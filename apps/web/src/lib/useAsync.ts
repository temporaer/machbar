import { useCallback, useEffect, useRef, useState } from "react";
import { useRefresh } from "./refresh";

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * Fetches `fetcher()` whenever `deps` change or the global refresh bus is
 * bumped, exposing loading/error state that every page can render
 * consistently. Guards against setting state after unmount / after a newer
 * request has already superseded an older, slower one.
 */
export function useAsync<T>(fetcher: () => Promise<T>, deps: ReadonlyArray<unknown> = []): AsyncState<T> {
  const { version } = useRefresh();
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const [reloadToken, setReloadToken] = useState(0);

  const reload = useCallback(() => setReloadToken((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    fetcher()
      .then((result) => {
        if (cancelled || id !== requestId.current) return;
        setData(result);
      })
      .catch((err: unknown) => {
        if (cancelled || id !== requestId.current) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (cancelled || id !== requestId.current) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, reloadToken, ...deps]);

  return { data, loading, error, reload };
}
