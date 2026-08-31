import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocaleProvider } from "./locale";
import { RefreshProvider, useRefresh } from "./refresh";
import { RETENTION_MS, useRetainedMutations } from "./useRetainedMutations";

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

  it("merges the confirmed response without restarting retention", async () => {
    vi.useFakeTimers();
    let resolveMutation!: (value: string) => void;
    const mutation = new Promise<string>((resolve) => {
      resolveMutation = resolve;
    });
    const { result } = renderHook(
      () => ({
        mutations: useRetainedMutations<string>(),
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
    expect(result.current.mutations.retained.has(1)).toBe(false);
    expect(result.current.refresh.version).toBe(version + 1);
  });

  it("retains confirmed state until an authoritative refresh is reconciled", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(
      () => ({
        mutations: useRetainedMutations<string>(),
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
});
