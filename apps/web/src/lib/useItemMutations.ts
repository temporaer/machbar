import { useCallback, useEffect, useRef, useState } from "react";
import { isReadAccessError, isStaleWriteConflict, localizedErrorMessage } from "./errorMessage";
import { useRefresh } from "./refresh";
import { useStrings } from "./strings";

export interface ItemMutationLifecycle<TResult> {
  validate?(): Error | undefined;
  acceptedStart?(token: string): void;
  writeCommitted?(result: TResult, token: string): void;
  writeRejected?(error: unknown, token: string): void;
  refreshSettled?(outcome: { failed: boolean }, token: string): void;
}

interface ItemMutation<TResult> {
  id: number;
  mutate: () => Promise<TResult>;
  throwOnError?: boolean;
  lifecycle?: ItemMutationLifecycle<TResult>;
}

/** Pending/error feedback only: server reads own every domain value and row. */
export function useItemMutations() {
  const strings = useStrings();
  const { bump } = useRefresh();
  const [pendingIds, setPendingIds] = useState<Set<number>>(new Set());
  const [errors, setErrors] = useState<Record<number, string>>({});
  const inFlight = useRef(new Set<number>());
  const operationSequence = useRef(0);
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
    id, mutate, throwOnError = false, lifecycle,
  }: ItemMutation<TResult>): Promise<TResult | undefined> => {
    if (!mounted.current) return undefined;
    if (inFlight.current.has(id)) {
      const error = new Error("An update for this item is already in progress.");
      setErrors(current => ({ ...current, [id]: localizedErrorMessage(error, strings) }));
      if (throwOnError) throw error;
      return undefined;
    }
    const token = `task-transition:${++operationSequence.current}`;
    const validationError = lifecycle?.validate?.();
    if (validationError) {
      const error = validationError;
      setErrors(current => ({ ...current, [id]: localizedErrorMessage(error, strings) }));
      if (isReadAccessError(error) || isStaleWriteConflict(error)) void bump().catch(() => undefined);
      if (throwOnError) throw error;
      return undefined;
    }
    inFlight.current.add(id);
    setPendingIds(current => new Set(current).add(id));
    clearError(id);
    try { lifecycle?.acceptedStart?.(token); } catch { /* Presentation cannot reject an accepted command. */ }
    try {
      const result = await mutate();
      try { lifecycle?.writeCommitted?.(result, token); } catch { /* The write is already committed. */ }
      // The captured refresh owner outlives a sheet, but cannot target a replacement identity.
      // Query errors remain read errors; the write has already committed.
      let refreshFailed = false;
      try { await Promise.resolve(bump()); }
      catch { refreshFailed = true; }
      try { lifecycle?.refreshSettled?.({ failed: refreshFailed }, token); } catch { /* Keep the committed result. */ }
      return result;
    } catch (error) {
      try { lifecycle?.writeRejected?.(error, token); } catch { /* Preserve the original write rejection. */ }
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
