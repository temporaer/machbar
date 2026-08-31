import { useCallback, useEffect, useRef, useState } from "react";
import { isStaleWriteConflict, localizedErrorMessage } from "./errorMessage";
import { useRefresh } from "./refresh";
import { useStrings } from "./strings";

export const RETENTION_MS = 4000;

interface RetainedMutation<TStored, TResult> {
  id: number;
  optimistic?: TStored;
  mutate: () => Promise<TResult>;
  confirmed?: (result: TResult) => TStored;
  retain?: boolean;
  throwOnError?: boolean;
}

export function useRetainedMutations<TStored>() {
  const strings = useStrings();
  const { bump } = useRefresh();
  const [pendingIds, setPendingIds] = useState<Set<number>>(new Set());
  const [retained, setRetained] = useState<Map<number, TStored>>(new Map());
  const [errors, setErrors] = useState<Record<number, string>>({});
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  const inFlight = useRef<Set<number>>(new Set());

  useEffect(
    () => () => {
      timers.current.forEach((timer) => clearTimeout(timer));
      timers.current.clear();
    },
    [],
  );

  const release = useCallback((id: number, refresh = false) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setRetained((current) => {
      if (!current.has(id)) return current;
      const next = new Map(current);
      next.delete(id);
      return next;
    });
    if (refresh) bump();
  }, [bump]);

  const retain = useCallback((id: number, value: TStored) => {
    setRetained((current) => {
      const next = new Map(current);
      next.set(id, value);
      return next;
    });
    if (timers.current.has(id)) return;
    const timer = setTimeout(() => {
      timers.current.delete(id);
      setRetained((current) => {
        if (!current.has(id)) return current;
        const next = new Map(current);
        next.delete(id);
        return next;
      });
      bump();
    }, RETENTION_MS);
    timers.current.set(id, timer);
  }, [bump]);

  const clearError = useCallback((id: number) => {
    setErrors((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  }, []);

  const run = useCallback(
    async <TResult,>({
      id,
      optimistic,
      mutate,
      confirmed,
      retain: shouldRetain = optimistic !== undefined,
      throwOnError = false,
    }: RetainedMutation<TStored, TResult>): Promise<TResult | undefined> => {
      if (inFlight.current.has(id)) {
        const error = new Error("An update for this item is already in progress.");
        setErrors((current) => ({
          ...current,
          [id]: localizedErrorMessage(error, strings),
        }));
        if (throwOnError) throw error;
        return undefined;
      }
      inFlight.current.add(id);
      setPendingIds((current) => new Set(current).add(id));
      clearError(id);
      if (optimistic !== undefined) retain(id, optimistic);

      try {
        const result = await mutate();
        if (shouldRetain) {
          if (confirmed) retain(id, confirmed(result));
        } else {
          release(id);
          bump();
        }
        return result;
      } catch (error) {
        release(id);
        if (isStaleWriteConflict(error)) bump();
        setErrors((current) => ({
          ...current,
          [id]: localizedErrorMessage(error, strings),
        }));
        if (throwOnError) throw error;
        return undefined;
      } finally {
        inFlight.current.delete(id);
        setPendingIds((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
      }
    },
    [bump, clearError, release, retain, strings],
  );

  const isPending = useCallback((id: number) => pendingIds.has(id), [pendingIds]);

  return {
    pendingIds,
    isPending,
    retained,
    errors,
    clearError,
    run,
    release,
  };
}
