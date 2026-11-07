import { act, renderHook } from "@testing-library/react";
import { StrictMode, useEffect, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocaleProvider } from "./locale";
import { RefreshProvider, useRefresh } from "./refresh";
import { RETENTION_MS, useRetainedMutations } from "./useRetainedMutations";

type Receipt = { revision: number; title: string };
const receiptRevision = (receipt: Receipt) => receipt.revision;

function deferredReceipt() {
  let resolve!: (receipt: Receipt) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<Receipt>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("confirmed mutation receipts", () => {
  it("prunes read-only inputs after their last interaction but preserves command input needed by an offline consumer", async () => {
    const { result } = renderHook(() => useRetainedMutations<Receipt>({ receiptRevision }), { wrapper });
    const readOnly = { revision: 1, title: "Read-only visit" };
    let close!: () => void;
    act(() => {
      close = result.current.pauseRetention(1);
      result.current.observeConfirmed(1, readOnly, readOnly, true);
    });
    expect(result.current.getConfirmed(1)).toBe(readOnly);
    act(close);
    expect(result.current.getConfirmed(1)).toBeUndefined();
    const confirmed = { revision: 2, title: "Accepted command" };
    await act(async () => {
      await result.current.run({ id: 2, mutate: async () => confirmed, confirmed: value => value, retain: false });
    });
    act(() => {
      close = result.current.pauseRetention(2);
      result.current.observeConfirmed(2, confirmed, confirmed, true);
    });
    act(close);
    expect(result.current.getConfirmed(2)).toBe(confirmed);
  });

  it("rejects saved mutation, release, observation and invalidation methods from discarded StrictMode render scope", async () => {
    let obsolete: Pick<ReturnType<typeof useRetainedMutations<Receipt>>, "run" | "release" | "observeConfirmed" | "invalidateConfirmed"> | undefined;
    const { result } = renderHook(() => {
      const mutations = useRetainedMutations<Receipt>({ receiptRevision });
      useEffect(() => { obsolete ??= mutations; }, [mutations]);
      return mutations;
    }, { wrapper: ({ children }) => <StrictMode>{wrapper({ children })}</StrictMode> });
    const confirmed = { revision: 2, title: "Current confirmed" };
    await act(async () => {
      await result.current.run({ id: 1, optimistic: confirmed, mutate: async () => confirmed, confirmed: value => value });
    });
    if (!obsolete) throw new Error("Expected initial effect methods");
    const old = obsolete;
    const mutate = vi.fn(async () => ({ revision: 9, title: "Obsolete command" }));
    await act(async () => {
      old.release(1);
      old.observeConfirmed(1, { revision: 8, title: "Obsolete read" }, undefined, true);
      old.invalidateConfirmed(1);
      await old.run({ id: 1, mutate, confirmed: value => value, retain: false });
    });
    expect(mutate).not.toHaveBeenCalled();
    expect(result.current.getConfirmed(1)).toBe(confirmed);
    expect(result.current.retained.get(1)).toBe(confirmed);
  });

  it("preserves confirmed input after its visual retention deadline expires", async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useRetainedMutations<Receipt>({ receiptRevision }), { wrapper });
      const confirmed = { revision: 2, title: "Server title" };
      await act(async () => {
        await result.current.run({
          id: 1, optimistic: { revision: 2, title: "Pending title" },
          mutate: async () => confirmed, confirmed: value => value,
        });
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(RETENTION_MS + 1); });
      expect(result.current.retained.has(1)).toBe(false);
      expect(result.current.holdingIds.has(1)).toBe(false);
      expect(result.current.getConfirmed(1)).toBe(confirmed);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps unretained server input through visual release and a failed later write", async () => {
    const { result } = renderHook(() => useRetainedMutations<Receipt>({ receiptRevision }), { wrapper });
    const confirmed = { revision: 2, title: "Server title" };
    await act(async () => {
      await result.current.run({ id: 1, mutate: async () => confirmed, confirmed: value => value, retain: false });
    });
    expect(result.current.getConfirmed(1)).toBe(confirmed);
    expect(result.current.retained.has(1)).toBe(false);
    expect(result.current.holdingIds.has(1)).toBe(false);
    await act(async () => {
      await result.current.run({
        id: 1, optimistic: { revision: 3, title: "Unsaved title" },
        mutate: async () => { throw new Error("save offline"); }, confirmed: value => value,
      });
    });
    act(() => result.current.release(1));
    expect(result.current.getConfirmed(1)).toBe(confirmed);
    expect(result.current.retained.has(1)).toBe(false);
    expect(result.current.errors[1]).toBe("save offline");
  });

  it("prefers fresh equal-revision authority over a late response and never downgrades it", async () => {
    const pending = deferredReceipt();
    const { result } = renderHook(() => useRetainedMutations<Receipt>({ receiptRevision }), { wrapper });
    let run!: Promise<Receipt | undefined>;
    act(() => {
      run = result.current.run({ id: 1, mutate: () => pending.promise, confirmed: value => value, retain: false });
    });
    const fresh = { revision: 3, title: "Fresh derived title" };
    act(() => result.current.observeConfirmed(1, fresh));
    await act(async () => { pending.resolve({ revision: 3, title: "Older response title" }); await run; });
    act(() => result.current.observeConfirmed(1, { revision: 2, title: "Older read" }));
    expect(result.current.getConfirmed(1)).toBe(fresh);
    act(() => result.current.release(1));
    expect(result.current.getConfirmed(1)).toBe(fresh);
  });

  it.each(["resolve", "reject"] as const)("isolates A-to-B-to-A receipts and same-ID pending ownership from old %s", async (settlement) => {
    const old = deferredReceipt();
    const next = deferredReceipt();
    const { result, rerender } = renderHook(({ identityKey }) =>
      useRetainedMutations<Receipt>({ receiptRevision, identityKey }), { wrapper, initialProps: { identityKey: "A" } });
    let first!: Promise<Receipt | undefined>;
    act(() => {
      first = result.current.run({ id: 1, optimistic: { revision: 2, title: "Old pending" }, mutate: () => old.promise, confirmed: value => value });
    });
    const oldToken = result.current.scopeToken;
    const oldLease = result.current.pauseRetention(1);
    rerender({ identityKey: "B" });
    expect(result.current.retained.size).toBe(0);
    expect(result.current.pendingIds.size).toBe(0);
    rerender({ identityKey: "A" });
    expect(result.current.scopeToken).not.toBe(oldToken);
    let second!: Promise<Receipt | undefined>;
    act(() => {
      second = result.current.run({ id: 1, optimistic: { revision: 5, title: "New pending" }, mutate: () => next.promise, confirmed: value => value });
      oldLease();
    });
    await act(async () => {
      if (settlement === "resolve") old.resolve({ revision: 9, title: "Old private title" });
      else old.reject(new Error("Old private error"));
      await first;
    });
    expect(result.current.getConfirmed(1)).toBeUndefined();
    expect(result.current.isPending(1)).toBe(true);
    expect(result.current.retained.get(1)?.title).toBe("New pending");
    expect(result.current.errors[1]).toBeUndefined();
    await act(async () => { next.resolve({ revision: 5, title: "New confirmed" }); await second; });
    expect(result.current.getConfirmed(1)?.title).toBe("New confirmed");
  });

  it("invalidates denied targets without allowing old results or cached observations to restore them", async () => {
    const pending = deferredReceipt();
    const { result } = renderHook(() => useRetainedMutations<Receipt>({ receiptRevision }), { wrapper });
    let run!: Promise<Receipt | undefined>;
    act(() => {
      run = result.current.run({ id: 1, mutate: () => pending.promise, confirmed: value => value, retain: false });
      result.current.invalidateConfirmed(1);
    });
    await act(async () => { pending.resolve({ revision: 2, title: "No longer accessible" }); await run; });
    const readable = { revision: 3, title: "Authorized again" };
    act(() => result.current.observeConfirmed(1, readable));
    expect(result.current.getConfirmed(1)).toBeUndefined();
    act(() => result.current.observeConfirmed(1, readable, readable, true));
    expect(result.current.getConfirmed(1)).toBe(readable);
  });

  it("does not publish a response from the discarded StrictMode effect lifetime", async () => {
    const pending = deferredReceipt();
    let started = false;
    let run!: Promise<Receipt | undefined>;
    const { result } = renderHook(() => {
      const mutations = useRetainedMutations<Receipt>({ receiptRevision });
      useEffect(() => {
        if (started) return;
        started = true;
        run = mutations.run({ id: 1, mutate: () => pending.promise, confirmed: value => value, retain: false });
      }, [mutations.run]);
      return mutations;
    }, { wrapper: ({ children }) => <StrictMode>{wrapper({ children })}</StrictMode> });
    await act(async () => { pending.resolve({ revision: 2, title: "Discarded" }); await run; });
    expect(result.current.getConfirmed(1)).toBeUndefined();
    expect(result.current.pendingIds.size).toBe(0);
  });
});

function wrapper({ children }: { children: ReactNode }) {
  return (
    <LocaleProvider initialLocale="de">
      <RefreshProvider>{children}</RefreshProvider>
    </LocaleProvider>
  );
}

describe("useRetainedMutations", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("tracks independent entity mutations concurrently", async () => {
    let resolveFirst!: (value: string) => void;
    let resolveSecond!: (value: string) => void;
    const first = new Promise<string>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<string>((resolve) => {
      resolveSecond = resolve;
    });
    const { result } = renderHook(() => useRetainedMutations<string>(), {
      wrapper,
    });

    let firstRun!: Promise<string | undefined>;
    let secondRun!: Promise<string | undefined>;
    act(() => {
      firstRun = result.current.run({
        id: 1,
        optimistic: "first pending",
        mutate: () => first,
        confirmed: (value) => value,
      });
      secondRun = result.current.run({
        id: 2,
        optimistic: "second pending",
        mutate: () => second,
        confirmed: (value) => value,
      });
    });

    expect(result.current.isPending(1)).toBe(true);
    expect(result.current.isPending(2)).toBe(true);

    await act(async () => {
      resolveFirst("first confirmed");
      await firstRun;
    });
    expect(result.current.isPending(1)).toBe(false);
    expect(result.current.isPending(2)).toBe(true);
    expect(result.current.retained.get(1)).toBe("first confirmed");

    await act(async () => {
      resolveSecond("second confirmed");
      await secondRun;
    });
  });

  it("rejects a duplicate same-entity mutation instead of dropping it silently", async () => {
    let resolveFirst!: (value: string) => void;
    const first = new Promise<string>((resolve) => {
      resolveFirst = resolve;
    });
    const secondMutation = vi.fn(async () => "second");
    const { result } = renderHook(() => useRetainedMutations<string>(), {
      wrapper,
    });

    let firstRun!: Promise<string | undefined>;
    let secondRun!: Promise<string | undefined>;
    act(() => {
      firstRun = result.current.run({
        id: 1,
        optimistic: "first pending",
        mutate: () => first,
      });
      secondRun = result.current.run({
        id: 1,
        optimistic: "second pending",
        mutate: secondMutation,
      });
    });

    await expect(secondRun).resolves.toBeUndefined();
    expect(secondMutation).not.toHaveBeenCalled();
    expect(result.current.retained.get(1)).toBe("first pending");
    expect(result.current.isPending(1)).toBe(true);
    expect(result.current.errors[1]).toBe(
      "An update for this item is already in progress.",
    );

    await act(async () => {
      resolveFirst("first confirmed");
      await firstRun;
    });
    expect(result.current.isPending(1)).toBe(false);
  });

  it("starts the full retention window after confirmation, then preserves the confirmed overlay", async () => {
    vi.useFakeTimers();
    let resolveMutation!: (value: string) => void;
    const mutation = new Promise<string>((resolve) => {
      resolveMutation = resolve;
    });
    const { result } = renderHook(
      () => ({
        mutations: useRetainedMutations<string>({ immediateRefresh: true }),
        refresh: useRefresh(),
      }),
      { wrapper },
    );

    let run!: Promise<string | undefined>;
    act(() => {
      run = result.current.mutations.run({
        id: 1,
        optimistic: "optimistic",
        mutate: () => mutation,
        confirmed: (value) => value,
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RETENTION_MS - 500);
      resolveMutation("confirmed");
      await run;
    });
    expect(result.current.mutations.retained.get(1)).toBe("confirmed");

    const version = result.current.refresh.version;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(result.current.mutations.holdingIds.has(1)).toBe(true);
    expect(result.current.refresh.version).toBe(version);
    await act(async () => { await vi.advanceTimersByTimeAsync(RETENTION_MS); });
    expect(result.current.mutations.holdingIds.has(1)).toBe(false);
    expect(result.current.mutations.retained.get(1)).toBe("confirmed");
    expect(result.current.refresh.version).toBe(version);
  });

  it("retains confirmed state until an authoritative refresh is reconciled", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(
      () => ({
        mutations: useRetainedMutations<string>({ immediateRefresh: true }),
        refresh: useRefresh(),
      }),
      { wrapper },
    );

    const version = result.current.refresh.version;
    await act(async () => {
      await result.current.mutations.run({
        id: 1,
        optimistic: "optimistic",
        mutate: async () => "confirmed",
        confirmed: (value) => value,
        retainUntilRefresh: true,
        refreshImmediately: true,
      });
    });

    expect(result.current.mutations.retained.get(1)).toBe("confirmed");
    expect(result.current.refresh.version).toBe(version + 1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RETENTION_MS * 2);
    });
    expect(result.current.mutations.retained.get(1)).toBe("confirmed");

    act(() => result.current.mutations.release(1));
    expect(result.current.mutations.retained.has(1)).toBe(false);
  });

  it("rolls back optimistic state and retains an actionable error", async () => {
    const { result } = renderHook(() => useRetainedMutations<string>(), {
      wrapper,
    });

    await act(async () => {
      await result.current.run({
        id: 7,
        optimistic: "optimistic",
        mutate: async () => {
          throw new Error("Netzwerkfehler");
        },
      });
    });

    expect(result.current.retained.has(7)).toBe(false);
    expect(result.current.errors[7]).toBe("Netzwerkfehler");
  });
  it("keeps slow writes visible and resets the full lifetime on a subsequent transition", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useRetainedMutations<string>({ immediateRefresh: true }), { wrapper });
    let resolve!: (value: string) => void;
    let first!: Promise<string | undefined>;
    act(() => { first = result.current.run({ id: 1, optimistic: "pending", mutate: () => new Promise<string>(r => { resolve = r; }), confirmed: value => value }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(RETENTION_MS * 3); });
    expect(result.current.holdingIds.has(1)).toBe(true);
    expect(result.current.isPending(1)).toBe(true);
    await act(async () => { resolve("done"); await first; });
    await act(async () => { await vi.advanceTimersByTimeAsync(RETENTION_MS - 100); });
    await act(async () => { await result.current.run({ id: 1, optimistic: "reopened", mutate: async () => "reopened", confirmed: value => value }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(result.current.holdingIds.has(1)).toBe(true);
    expect(result.current.retained.get(1)).toBe("reopened");
    await act(async () => { await vi.advanceTimersByTimeAsync(RETENTION_MS); });
    expect(result.current.holdingIds.has(1)).toBe(false);
  });

  it("pauses removal for overlapping interactions and gives two seconds after the last closes", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useRetainedMutations<string>({ immediateRefresh: true }), { wrapper });
    let closeMenu!: () => void;
    let closeDetails!: () => void;
    act(() => { closeMenu = result.current.pauseRetention(1); });
    await act(async () => { await result.current.run({ id: 1, optimistic: "done", mutate: async () => "done" }); });
    act(() => { closeDetails = result.current.pauseRetention(1); });
    await act(async () => { await vi.advanceTimersByTimeAsync(RETENTION_MS * 2); });
    act(() => closeMenu());
    await act(async () => { await vi.advanceTimersByTimeAsync(RETENTION_MS); });
    expect(result.current.holdingIds.has(1)).toBe(true);
    act(() => closeDetails());
    await act(async () => { await vi.advanceTimersByTimeAsync(1999); });
    expect(result.current.holdingIds.has(1)).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(result.current.holdingIds.has(1)).toBe(false);
  });

  it("preserves a lifecycle placement deadline through a subsequent metadata save", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useRetainedMutations<string>({ immediateRefresh: true }), { wrapper });
    await act(async () => { await result.current.run({ id: 1, optimistic: "done", mutate: async () => "done" }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    await act(async () => { await result.current.run({ id: 1, optimistic: "renamed", mutate: async () => "renamed", retainUntilRefresh: true }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3999); });
    expect(result.current.holdingIds.has(1)).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(result.current.holdingIds.has(1)).toBe(false);
    expect(result.current.retained.get(1)).toBe("renamed");
  });

});
