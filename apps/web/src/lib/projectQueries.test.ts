import { afterEach, describe, expect, it, vi } from "vitest";
import { makeProject } from "../test/fixtures";
import {
  captureProjectRead,
  createQueryClient,
  projectQueryKeys,
  reconcileProjectMetadata,
} from "./projectQueries";

describe("project Query cache lifetime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a command-confirmed revision after a failed inactive refresh, until its identity scope is removed", async () => {
    vi.useFakeTimers();
    const queryClient = createQueryClient();
    const identity = "identity-one";
    const id = 42;
    const queryKey = projectQueryKeys.detail(identity, id);
    const full = { ...makeProject({ id }), tasks: [] };
    const confirmed = { ...full, revision: full.revision + 2, title: "Command-confirmed title" };

    captureProjectRead(queryClient, identity, id);
    queryClient.setQueryData(queryKey, full);
    reconcileProjectMetadata(queryClient, queryKey, confirmed);
    await expect(queryClient.fetchQuery({
      queryKey,
      queryFn: async () => { throw new Error("offline"); },
      staleTime: 0,
      retry: false,
    })).rejects.toThrow("offline");

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
    expect(queryClient.getQueryData<typeof confirmed>(queryKey)).toMatchObject({
      revision: confirmed.revision,
      title: confirmed.title,
    });

    queryClient.removeQueries({ queryKey: projectQueryKeys.identity(identity) });
    expect(queryClient.getQueryData(queryKey)).toBeUndefined();
    queryClient.clear();
  });
});
