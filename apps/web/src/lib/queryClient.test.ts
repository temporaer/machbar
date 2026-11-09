import { QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { createReadQueryClient, invalidateReads } from "./queryClient";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("server-confirmed reads", () => {
  it.each(["old-first", "new-first"])("discards a held pre-write read (%s) without mutation DTO publication", async order => {
    const client = createReadQueryClient();
    const old = deferred<string>();
    const current = deferred<string>();
    const fetcher = vi.fn<() => Promise<string>>()
      .mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const observer = new QueryObserver(client, {
      queryKey: ["project", 1],
      queryFn: async ({ signal }) => {
        const result = await fetcher();
        signal.throwIfAborted();
        return result;
      },
    });
    const seen: unknown[] = [];
    const unsubscribe = observer.subscribe(result => { seen.push(result.data); });
    const refreshed = invalidateReads(client, true);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    if (order === "old-first") {
      old.resolve("obsolete");
      await Promise.resolve();
    }
    current.resolve("confirmed by GET");
    await refreshed;
    if (order === "new-first") {
      old.resolve("obsolete");
      await Promise.resolve();
    }
    expect(seen).not.toContain("obsolete");
    expect(client.getQueryData(["project", 1])).toBe("confirmed by GET");
    unsubscribe();
    client.clear();
  });

  it("does not trail-refetch a replacement query with the same key", async () => {
    const client = createReadQueryClient();
    const old = deferred<string>();
    const observer = new QueryObserver(client, { queryKey: ["project", 1], queryFn: () => old.promise });
    const unsubscribe = observer.subscribe(() => {});
    const invalidation = invalidateReads(client);
    unsubscribe();
    client.removeQueries({ queryKey: ["project", 1] });
    const replacement = vi.fn(async () => "replacement");
    await client.fetchQuery({ queryKey: ["project", 1], queryFn: replacement });
    old.resolve("obsolete");
    await invalidation;
    expect(replacement).toHaveBeenCalledOnce();
    expect(client.getQueryData(["project", 1])).toBe("replacement");
    client.clear();
  });

  it("finishes an initial read and one shared trailing read after external invalidations", async () => {
    const client = createReadQueryClient();
    const initial = deferred<string>();
    const trailing = deferred<string>();
    const fetcher = vi.fn<() => Promise<string>>()
      .mockReturnValueOnce(initial.promise).mockReturnValueOnce(trailing.promise);
    const observer = new QueryObserver(client, { queryKey: ["agenda"], queryFn: fetcher });
    const unsubscribe = observer.subscribe(() => {});
    const refreshes = [invalidateReads(client), invalidateReads(client)];
    expect(fetcher).toHaveBeenCalledTimes(1);
    initial.resolve("initial");
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    trailing.resolve("latest");
    await Promise.all(refreshes);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(client.getQueryData(["agenda"])).toBe("latest");
    unsubscribe();
    client.clear();
  });

  it("removes protected cached data on denial but retains it on a network failure", async () => {
    const client = createReadQueryClient();
    const fetcher = vi.fn<() => Promise<string>>()
      .mockResolvedValueOnce("protected")
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new ApiError(403, "denied"));
    const observer = new QueryObserver(client, { queryKey: ["project", 1], queryFn: fetcher });
    const unsubscribe = observer.subscribe(() => {});
    await observer.refetch();
    await observer.refetch();
    expect(client.getQueryData(["project", 1])).toBe("protected");
    await observer.refetch();
    expect(client.getQueryData(["project", 1])).toBeUndefined();
    unsubscribe();
    client.clear();
  });
});
