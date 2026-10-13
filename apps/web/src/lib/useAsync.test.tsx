import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { LocaleProvider } from "./locale";
import { RefreshProvider, useRefresh } from "./refresh";
import { useAsync } from "./useAsync";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <LocaleProvider initialLocale="en">
      <RefreshProvider>{children}</RefreshProvider>
    </LocaleProvider>
  );
}

describe("useAsync", () => {
  it("uses foreground loading for the initial request and exposes its result", async () => {
    const request = deferred<string>();
    const { result } = renderHook(() => useAsync(() => request.promise), {
      wrapper,
    });

    expect(result.current).toMatchObject({
      data: null,
      loading: true,
      refreshing: false,
      error: null,
    });

    act(() => request.resolve("first"));
    await waitFor(() => expect(result.current.data).toBe("first"));
    expect(result.current).toMatchObject({
      loading: false,
      refreshing: false,
      error: null,
    });
  });

  it("keeps resolved data during global refresh and replaces it atomically", async () => {
    const refreshed = deferred<string>();
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("old")
      .mockReturnValueOnce(refreshed.promise);
    const { result } = renderHook(
      () => ({
        async: useAsync(fetcher),
        refresh: useRefresh(),
      }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.async.data).toBe("old"));

    act(() => result.current.refresh.bump());
    await waitFor(() => expect(result.current.async.refreshing).toBe(true));
    expect(result.current.async).toMatchObject({
      data: "old",
      loading: false,
      error: null,
    });

    act(() => refreshed.resolve("new"));
    await waitFor(() => expect(result.current.async.data).toBe("new"));
    expect(result.current.async.refreshing).toBe(false);
  });

  it("treats explicit reload as background revalidation when data exists", async () => {
    const refreshed = deferred<string>();
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("old")
      .mockReturnValueOnce(refreshed.promise);
    const { result } = renderHook(() => useAsync(fetcher), { wrapper });
    await waitFor(() => expect(result.current.data).toBe("old"));

    act(() => result.current.reload());
    await waitFor(() => expect(result.current.refreshing).toBe(true));
    expect(result.current).toMatchObject({ data: "old", loading: false });

    act(() => refreshed.resolve("new"));
    await waitFor(() => expect(result.current.data).toBe("new"));
  });

  it("does not expose data from the previous logical query", async () => {
    const second = deferred<string>();
    const fetcher = vi.fn((query: string) =>
      query === "first" ? Promise.resolve("first result") : second.promise,
    );
    const { result, rerender } = renderHook(
      ({ query }) => useAsync(() => fetcher(query), [query]),
      { wrapper, initialProps: { query: "first" } },
    );
    await waitFor(() => expect(result.current.data).toBe("first result"));

    rerender({ query: "second" });
    expect(result.current).toMatchObject({
      data: null,
      loading: true,
      refreshing: false,
      error: null,
    });

    act(() => second.resolve("second result"));
    await waitFor(() => expect(result.current.data).toBe("second result"));
  });

  it("preserves data and separates errors from failed background refreshes", async () => {
    const refresh = deferred<string>();
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("stable")
      .mockReturnValueOnce(refresh.promise);
    const { result } = renderHook(() => useAsync(fetcher), { wrapper });
    await waitFor(() => expect(result.current.data).toBe("stable"));

    act(() => result.current.reload());
    act(() => refresh.reject(new Error("offline")));
    await waitFor(() => expect(result.current.refreshing).toBe(false));

    expect(result.current).toMatchObject({
      data: "stable",
      loading: false,
      error: null,
      refreshError: "offline",
    });
  });

  it("exposes initial errors as foreground errors", async () => {
    const { result } = renderHook(
      () => useAsync(() => Promise.reject(new Error("initial failure"))),
      { wrapper },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current).toMatchObject({
      data: null,
      refreshing: false,
      error: "initial failure",
      refreshError: null,
    });
  });

  it("does not let a slower previous request overwrite a newer result", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const { result, rerender } = renderHook(
      ({ query }) =>
        useAsync(
          () => (query === "first" ? first.promise : second.promise),
          [query],
        ),
      { wrapper, initialProps: { query: "first" } },
    );

    rerender({ query: "second" });
    act(() => second.resolve("newer"));
    await waitFor(() => expect(result.current.data).toBe("newer"));

    act(() => first.resolve("older"));
    await act(async () => Promise.resolve());
    expect(result.current.data).toBe("newer");
  });
  it.each(["resolve", "reject"] as const)(
    "serializes repeated invalidations and settles after initial %s",
    async (outcome) => {
      const first = deferred<string>();
      const trailing = deferred<string>();
      const fetcher = vi.fn<() => Promise<string>>()
        .mockReturnValueOnce(first.promise).mockReturnValueOnce(trailing.promise);
      const { result } = renderHook(() => ({
        query: useAsync(fetcher), refresh: useRefresh(),
      }), { wrapper });
      for (let index = 0; index < 5; index++) {
        act(() => result.current.refresh.bump());
        act(() => result.current.query.reload());
      }
      expect(fetcher).toHaveBeenCalledTimes(1);
      await act(async () => {
        if (outcome === "resolve") first.resolve("initial");
        else first.reject(new Error("offline"));
      });
      expect(fetcher).toHaveBeenCalledTimes(2);
      if (outcome === "resolve") {
        expect(result.current.query).toMatchObject({
          data: "initial", loading: false, refreshing: true,
        });
      }
      await act(async () => trailing.resolve("final"));
      expect(result.current.query).toMatchObject({
        data: "final", loading: false, refreshing: false, error: null,
      });
      await act(async () => Promise.resolve());
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );

  it("retains existing data through queued background failure and retry", async () => {
    const failed = deferred<string>();
    const trailing = deferred<string>();
    const fetcher = vi.fn<() => Promise<string>>()
      .mockResolvedValueOnce("stable").mockReturnValueOnce(failed.promise)
      .mockReturnValueOnce(trailing.promise);
    const { result } = renderHook(() => useAsync(fetcher), { wrapper });
    await waitFor(() => expect(result.current.data).toBe("stable"));
    act(() => result.current.reload());
    act(() => result.current.reload());
    act(() => result.current.reload());
    expect(fetcher).toHaveBeenCalledTimes(2);
    await act(async () => failed.reject(new Error("offline")));
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(result.current).toMatchObject({ data: "stable", loading: false, refreshing: true });
    await act(async () => trailing.resolve("updated"));
    expect(result.current).toMatchObject({ data: "updated", refreshing: false, refreshError: null });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("discards a pending query and its queued refresh when dependencies change", async () => {
    const old = deferred<string>();
    const current = deferred<string>();
    const fetcher = vi.fn((query: string) => query === "old" ? old.promise : current.promise);
    const { result, rerender } = renderHook(({ query }) =>
      useAsync(() => fetcher(query), [query]),
      { wrapper, initialProps: { query: "old" } });
    act(() => result.current.reload());
    rerender({ query: "current" });
    await act(async () => old.resolve("obsolete"));
    expect(result.current).toMatchObject({ data: null, loading: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await act(async () => current.resolve("current"));
    expect(result.current.data).toBe("current");
  });

  it.each(["resolve", "reject"] as const)("drops queued refreshes after unmount on %s", async (outcome) => {
    const pending = deferred<string>();
    const fetcher = vi.fn(() => pending.promise);
    const { result, unmount } = renderHook(() => useAsync(fetcher), { wrapper });
    act(() => result.current.reload());
    unmount();
    await act(async () => {
      if (outcome === "resolve") pending.resolve("obsolete");
      else pending.reject(new Error("obsolete"));
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("folds events during trailing revalidation into one further request", async () => {
    const requests = [deferred<string>(), deferred<string>(), deferred<string>()];
    const fetcher = vi.fn<() => Promise<string>>()
      .mockReturnValueOnce(requests[0]!.promise)
      .mockReturnValueOnce(requests[1]!.promise)
      .mockReturnValueOnce(requests[2]!.promise);
    const { result } = renderHook(() => useAsync(fetcher), { wrapper });
    act(() => result.current.reload());
    await act(async () => requests[0]!.resolve("first"));
    for (let index = 0; index < 5; index++) act(() => result.current.reload());
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.current.data).toBe("first");
    await act(async () => requests[1]!.resolve("second"));
    expect(result.current.data).toBe("second");
    expect(fetcher).toHaveBeenCalledTimes(3);
    await act(async () => requests[2]!.resolve("final"));
    expect(result.current).toMatchObject({ data: "final", refreshing: false, loading: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("settles after StrictMode effect cleanup and remount", async () => {
    const obsolete = deferred<string>();
    const current = deferred<string>();
    const fetcher = vi.fn<() => Promise<string>>()
      .mockReturnValueOnce(obsolete.promise).mockReturnValueOnce(current.promise);
    const { result } = renderHook(() => useAsync(fetcher), {
      wrapper: ({ children }) => <StrictMode>{wrapper({ children })}</StrictMode>,
    });
    await act(async () => current.resolve("current"));
    await act(async () => obsolete.resolve("obsolete"));
    expect(result.current).toMatchObject({ data: "current", loading: false, refreshing: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

});
