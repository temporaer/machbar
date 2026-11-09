import { useCallback, useEffect, useRef, useState } from "react";
import { isReadAccessError, isStaleWriteConflict, localizedErrorMessage } from "./errorMessage";
import { useRefresh } from "./refresh";
import { useStrings } from "./strings";

interface ItemMutation<TResult> {
  id: number;
  mutate: () => Promise<TResult>;
  throwOnError?: boolean;
}

/** Pending/error feedback only: server reads own every domain value and row. */
export function useItemMutations() {
  const strings = useStrings();
  const { bump } = useRefresh();
  const [pendingIds, setPendingIds] = useState<Set<number>>(new Set());
  const [errors, setErrors] = useState<Record<number, string>>({});
  const inFlight = useRef(new Set<number>());
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const clearError = useCallback((id: number) => {
    setErrors(current => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  }, []);

  const run = useCallback(async <TResult,>({
    id, mutate, throwOnError = false,
  }: ItemMutation<TResult>): Promise<TResult | undefined> => {
    if (!mounted.current) return undefined;
    if (inFlight.current.has(id)) {
      const error = new Error("An update for this item is already in progress.");
      setErrors(current => ({ ...current, [id]: localizedErrorMessage(error, strings) }));
      if (throwOnError) throw error;
      return undefined;
    }
    inFlight.current.add(id);
    setPendingIds(current => new Set(current).add(id));
    clearError(id);
    try {
      const result = await mutate();
      if (mounted.current) bump();
      return result;
    } catch (error) {
      if (mounted.current) {
        setErrors(current => ({ ...current, [id]: localizedErrorMessage(error, strings) }));
        if (isReadAccessError(error) || isStaleWriteConflict(error)) bump();
      }
      if (throwOnError) throw error;
      return undefined;
    } finally {
      inFlight.current.delete(id);
      if (mounted.current) setPendingIds(current => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  }, [bump, clearError, strings]);

  const isPending = useCallback((id: number) => pendingIds.has(id), [pendingIds]);
  return { run, pendingIds, isPending, errors, clearError };
}
