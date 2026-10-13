import { useCallback, useEffect, useRef, useState } from "react";
import { useRefresh } from "./refresh";
import { useStrings } from "./strings";
import { localizedErrorMessage } from "./errorMessage";

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  refreshError: string | null;
  reload: () => void;
}

interface AsyncSnapshot<T> {
  generation: number;
  data: T | null;
  hasData: boolean;
  loading: boolean;
  refreshing: boolean;
  errorCause: unknown | null;
  refreshErrorCause: unknown | null;
}

function sameDependencies(
  previous: ReadonlyArray<unknown>,
  next: ReadonlyArray<unknown>,
): boolean {
  return (
    previous.length === next.length &&
    previous.every((value, index) => Object.is(value, next[index]))
  );
}

/**
 * Fetches `fetcher()` whenever `deps` change or the global refresh bus is
 * bumped. A new logical query enters foreground loading, while reloads of an
 * already resolved query retain its data and revalidate in the background.
 * Same-query invalidations queue one revalidation without discarding the pending
 * result. Query changes and unmount still discard obsolete results.
 */
export function useAsync<T>(fetcher: () => Promise<T>, deps: ReadonlyArray<unknown> = []): AsyncState<T> {
  const strings = useStrings();
  const { version } = useRefresh();
  const dependencies = useRef<ReadonlyArray<unknown>>(deps);
  const generation = useRef(0);
  if (!sameDependencies(dependencies.current, deps)) {
    dependencies.current = deps;
    generation.current += 1;
  }
  const currentGeneration = generation.current;
  const [snapshot, setSnapshot] = useState<AsyncSnapshot<T>>({
    generation: currentGeneration,
    data: null,
    hasData: false,
    loading: true,
    refreshing: false,
    errorCause: null,
    refreshErrorCause: null,
  });
  const snapshotRef = useRef(snapshot);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const requestRefresh = useRef<(() => void) | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const reload = useCallback(() => setReloadToken((t) => t + 1), []);

  // Only a logical query change cancels this runner. Refreshes share it.
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let dirty = false;
    const run = async () => {
      if (cancelled) return;
      if (inFlight) {
        dirty = true;
        return;
      }
      inFlight = true;
      const existing = snapshotRef.current;
      const background =
        existing.generation === currentGeneration && existing.hasData;
      const pending: AsyncSnapshot<T> = background
        ? {
            ...existing,
            loading: false,
            refreshing: true,
            errorCause: null,
            refreshErrorCause: null,
          }
        : {
            generation: currentGeneration,
            data: null,
            hasData: false,
            loading: true,
            refreshing: false,
            errorCause: null,
            refreshErrorCause: null,
          };
      snapshotRef.current = pending;
      setSnapshot(pending);
      try {
        const result = await fetcherRef.current();
        if (cancelled || generation.current !== currentGeneration) return;
        const next: AsyncSnapshot<T> = {
          generation: currentGeneration,
          data: result,
          hasData: true,
          loading: false,
          refreshing: false,
          errorCause: null,
          refreshErrorCause: null,
        };
        snapshotRef.current = next;
        setSnapshot(next);
      } catch (err: unknown) {
        if (cancelled || generation.current !== currentGeneration) return;
        const next: AsyncSnapshot<T> = background
          ? {
              ...snapshotRef.current,
              loading: false,
              refreshing: false,
              errorCause: null,
              refreshErrorCause: err,
            }
          : {
              generation: currentGeneration,
              data: null,
              hasData: false,
              loading: false,
              refreshing: false,
              errorCause: err,
              refreshErrorCause: null,
            };
        snapshotRef.current = next;
        setSnapshot(next);
      } finally {
        inFlight = false;
        if (!cancelled && generation.current === currentGeneration && dirty) {
          dirty = false;
          void run();
        }
      }
    };
    requestRefresh.current = () => {
      void run();
    };
    void run();
    return () => {
      cancelled = true;
      requestRefresh.current = null;
    };
  }, [currentGeneration]);

  const invalidation = useRef({ version, reloadToken });
  useEffect(() => {
    const previous = invalidation.current;
    invalidation.current = { version, reloadToken };
    if (previous.version !== version || previous.reloadToken !== reloadToken) {
      requestRefresh.current?.();
    }
  }, [version, reloadToken]);

  const current: AsyncSnapshot<T> =
    snapshot.generation === currentGeneration
      ? snapshot
      : {
          generation: currentGeneration,
          data: null,
          hasData: false,
          loading: true,
          refreshing: false,
          errorCause: null,
          refreshErrorCause: null,
        };
  return {
    data: current.data,
    loading: current.loading,
    refreshing: current.refreshing,
    error:
      current.errorCause === null
        ? null
        : localizedErrorMessage(current.errorCause, strings),
    refreshError:
      current.refreshErrorCause === null
        ? null
        : localizedErrorMessage(current.refreshErrorCause, strings),
    reload,
  };
}
