import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isReadAccessError, isStaleWriteConflict, localizedErrorMessage } from "./errorMessage";
import { useRefresh } from "./refresh";
import { useStrings } from "./strings";

interface ItemMutation<TResult> {
  id: number;
  mutate: () => Promise<TResult>;
  throwOnError?: boolean;
  pendingMessage?: string | undefined;
  onCommitted?: (result: TResult) => void;
}

/** Pending/error feedback only: server reads own every domain value and row. */
export function useItemMutations() {
  const strings = useStrings();
  const { bump } = useRefresh();
  const [pendingMessages, setPendingMessages] = useState(new Map<number, string | undefined>());
  const pendingIds = useMemo(() => new Set(pendingMessages.keys()), [pendingMessages]);
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
    id, mutate, throwOnError = false, pendingMessage, onCommitted,
  }: ItemMutation<TResult>): Promise<TResult | undefined> => {
    if (!mounted.current) return undefined;
    if (inFlight.current.has(id)) {
      const error = new Error("An update for this item is already in progress.");
      setErrors(current => ({ ...current, [id]: localizedErrorMessage(error, strings) }));
      if (throwOnError) throw error;
      return undefined;
    }
    inFlight.current.add(id);
    setPendingMessages(current => new Map(current).set(id, pendingMessage));
    clearError(id);
    try {
      let result: TResult;
      try {
        result = await mutate();
      } catch (error) {
        if (mounted.current) {
          setErrors(current => ({ ...current, [id]: localizedErrorMessage(error, strings) }));
          if (isReadAccessError(error) || isStaleWriteConflict(error)) bump();
        }
        if (throwOnError) throw error;
        return undefined;
      }
      // The captured refresh owner outlives a sheet, but cannot target a replacement identity.
      // Query errors remain read errors; the write has already committed.
      const refresh = Promise.resolve(bump()).catch(() => undefined);
      if (mounted.current) {
        setPendingMessages(current => new Map(current).set(id, undefined));
        try {
          onCommitted?.(result);
        } catch {
          // Presentation feedback must not change the outcome of a committed write.
        }
      }
      await refresh;
      return result;
    } finally {
      inFlight.current.delete(id);
      if (mounted.current) setPendingMessages(current => {
        const next = new Map(current);
        next.delete(id);
        return next;
      });
    }
  }, [bump, clearError, strings]);

  const isPending = useCallback((id: number) => pendingIds.has(id), [pendingIds]);
  return { run, pendingIds, pendingMessages, isPending, errors, clearError };
}
