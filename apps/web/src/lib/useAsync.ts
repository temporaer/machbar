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
 * Guards against setting state after unmount or after a newer request.
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
  const requestId = useRef(0);
  const [reloadToken, setReloadToken] = useState(0);

  const reload = useCallback(() => setReloadToken((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    const id = ++requestId.current;
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
    fetcher()
      .then((result) => {
        if (cancelled || id !== requestId.current) return;
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
      })
      .catch((err: unknown) => {
        if (cancelled || id !== requestId.current) return;
        const next: AsyncSnapshot<T> = background
          ? {
              ...snapshotRef.current,
              generation: currentGeneration,
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
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, reloadToken, ...deps]);

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
