import { act, renderHook, waitFor } from "@testing-library/react";
import { type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { LocaleProvider } from "./locale";
import { RefreshProvider } from "./refresh";
import { useAsync } from "./useAsync";
import { useItemMutations } from "./useItemMutations";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function wrapper({ children }: { children: ReactNode }) {
  return <LocaleProvider initialLocale="en"><RefreshProvider>{children}</RefreshProvider></LocaleProvider>;
}

describe("mutation settlement with the real refresh/query provider", () => {
  it.each(["success", "failure"])("follows a superseding write's held read until %s", async outcome => {
    const initial = deferred<string>(), superseded = deferred<string>(), replacement = deferred<string>();
    const fetcher = vi.fn<(signal: AbortSignal) => Promise<string>>()
      .mockReturnValueOnce(initial.promise).mockReturnValueOnce(superseded.promise).mockReturnValueOnce(replacement.promise);
    const { result } = renderHook(() => ({ read: useAsync(fetcher), actions: useItemMutations() }), { wrapper });
    await act(async () => initial.resolve("before both writes"));
    await waitFor(() => expect(result.current.read.data).toBe("before both writes"));
    let first!: Promise<string | undefined>, second!: Promise<string | undefined>;
    let firstReturned = false;
    act(() => { first = result.current.actions.run({ id: 1, mutate: async () => "first committed" }).then(value => { firstReturned = true; return value; }); });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    act(() => { second = result.current.actions.run({ id: 2, mutate: async () => "second committed" }); });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    expect(fetcher.mock.calls[1]![0].aborted).toBe(true);
    expect(result.current.read.data).toBe("before both writes");
    expect(result.current.actions.isPending(1)).toBe(true);
    expect(firstReturned).toBe(false);
    expect(result.current.actions.isPending(2)).toBe(true);
    const duplicate = vi.fn(async () => "duplicate");
    await act(async () => { await result.current.actions.run({ id: 1, mutate: duplicate }); });
    expect(duplicate).not.toHaveBeenCalled();
    await act(async () => {
      if (outcome === "success") replacement.resolve("after both writes");
      else replacement.reject(new Error("Read offline"));
      expect(await first).toBe("first committed");
      expect(await second).toBe("second committed");
    });
    expect(result.current.actions.isPending(1)).toBe(false);
    expect(result.current.actions.isPending(2)).toBe(false);
    expect(result.current.read.data).toBe(outcome === "success" ? "after both writes" : "before both writes");
    expect(result.current.read.refreshError).toBe(outcome === "success" ? null : "Read offline");
    expect(fetcher).toHaveBeenCalledTimes(3); // following settlement never starts another read
    await act(async () => superseded.resolve("obsolete"));
    expect(result.current.read.data).not.toBe("obsolete");
  });
  it("follows repeated replacements without starting extra reads", async () => {
    const reads = Array.from({ length: 4 }, () => deferred<string>());
    let index = 0;
    const fetcher = vi.fn<(signal: AbortSignal) => Promise<string>>(() => reads[index++]!.promise);
    const { result } = renderHook(() => ({ read: useAsync(fetcher), actions: useItemMutations() }), { wrapper });
    await act(async () => reads[0]!.resolve("before"));
    await waitFor(() => expect(result.current.read.data).toBe("before"));
    const commands: Promise<unknown>[] = [];
    for (let id = 1; id <= 3; id++) {
      act(() => { commands.push(result.current.actions.run({ id, mutate: async () => id })); });
      await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(id + 1));
      for (let prior = 1; prior <= id; prior++) expect(result.current.actions.isPending(prior)).toBe(true);
    }
    expect(fetcher.mock.calls[1]![0].aborted).toBe(true);
    expect(fetcher.mock.calls[2]![0].aborted).toBe(true);
    await act(async () => { reads[3]!.resolve("after all three"); await Promise.all(commands); });
    expect(result.current.read.data).toBe("after all three");
    for (let id = 1; id <= 3; id++) expect(result.current.actions.isPending(id)).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

});
