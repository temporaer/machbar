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
  retainUntilRefresh?: boolean;
  refreshImmediately?: boolean;
  throwOnError?: boolean;
}

export function useRetainedMutations<TStored>({ immediateRefresh = false } = {}) {
  const strings = useStrings();
  const { bump } = useRefresh();
  const [pendingIds, setPendingIds] = useState<Set<number>>(new Set());
  const [retained, setRetained] = useState<Map<number, TStored>>(new Map());
  const [holdingIds, setHoldingIds] = useState<Set<number>>(new Set());
  const leases = useRef(new Map<number, number>());
  const deadlines = useRef(new Map<number, number>());
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
    deadlines.current.delete(id);
    setHoldingIds((current) => { const next = new Set(current); next.delete(id); return next; });
    setRetained((current) => {
      if (!current.has(id)) return current;
      const next = new Map(current);
      next.delete(id);
      return next;
    });
    if (refresh) bump();
  }, [bump]);

  // A confirmed value and its display lifetime are independent: expiry must
  // never put an older server snapshot back on screen.
  const retain = useCallback((id: number, value: TStored) => {
    setRetained((current) => new Map(current).set(id, value));
  }, []);

  const schedule = useCallback(function scheduleExpiry(id: number) {
    const existing = timers.current.get(id);
    if (existing) clearTimeout(existing);
    timers.current.delete(id);
    const deadline = deadlines.current.get(id);
    if (deadline === undefined || leases.current.has(id)) return;
    timers.current.set(id, setTimeout(() => {
      timers.current.delete(id);
      deadlines.current.delete(id);
      if (!immediateRefresh) {
        setRetained(current => { const next = new Map(current); next.delete(id); return next; });
        bump();
      }
      setHoldingIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }, Math.max(0, deadline - Date.now())));
  }, [bump, immediateRefresh]);

  const pauseRetention = useCallback((id: number) => {
    leases.current.set(id, (leases.current.get(id) ?? 0) + 1);
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    return () => {
      const remaining = (leases.current.get(id) ?? 1) - 1;
      if (remaining > 0) leases.current.set(id, remaining);
      else {
        leases.current.delete(id);
        const deadline = deadlines.current.get(id);
        if (deadline !== undefined) {
          deadlines.current.set(id, Math.max(deadline, Date.now() + 2000));
          schedule(id);
        }
      }
    };
  }, [schedule]);

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
      retainUntilRefresh = false,
      refreshImmediately = false,
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
      const holdPosition = !retainUntilRefresh || deadlines.current.has(id);
      const oldTimer = timers.current.get(id);
      if (oldTimer) clearTimeout(oldTimer);
      timers.current.delete(id);
      deadlines.current.delete(id);
      if (optimistic !== undefined) {
        retain(id, optimistic);
        if (holdPosition) setHoldingIds((current) => new Set(current).add(id));
      }

      try {
        const result = await mutate();
        if (shouldRetain) {
          if (confirmed) retain(id, confirmed(result));
          if (holdPosition) {
            setHoldingIds((current) => new Set(current).add(id));
            deadlines.current.set(id, Date.now() + RETENTION_MS);
            schedule(id);
          }
          if (immediateRefresh || refreshImmediately) bump();
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
    [bump, clearError, release, retain, schedule, strings, immediateRefresh],
  );

  const isPending = useCallback((id: number) => pendingIds.has(id), [pendingIds]);

  return {
    pendingIds,
    holdingIds,
    pauseRetention,
    isPending,
    retained,
    errors,
    clearError,
    run,
    release,
  };
}
