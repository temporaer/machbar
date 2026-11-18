import { useCallback, useEffect, useRef, useState } from "react";
import { isReadAccessError, isStaleWriteConflict, localizedErrorMessage } from "./errorMessage";
import { useRefresh } from "./refresh";
import { useStrings } from "./strings";
import type { Task } from "@machbar/shared";
import type { TaskTransitionIntent, TaskTransitionOrigin } from "./taskTransitionPresentation";

interface ItemMutation<TResult> {
  id: number;
  mutate: () => Promise<TResult>;
  throwOnError?: boolean;
  presentation?: {
    origin: TaskTransitionOrigin;
    task: Task;
    intent: TaskTransitionIntent;
  };
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
    id, mutate, throwOnError = false, presentation,
  }: ItemMutation<TResult>): Promise<TResult | undefined> => {
    if (!mounted.current) return undefined;
    if (inFlight.current.has(id)) {
      const error = new Error("An update for this item is already in progress.");
      setErrors(current => ({ ...current, [id]: localizedErrorMessage(error, strings) }));
      if (throwOnError) throw error;
      return undefined;
    }
    if (presentation?.origin.isBlocked()) return undefined;
    const token = `task-transition:${++operationSequence.current}`;
    const originState = presentation?.origin.begin(token, presentation.task, presentation.intent);
    if (originState === "blocked") return undefined;
    inFlight.current.add(id);
    setPendingIds(current => new Set(current).add(id));
    clearError(id);
    try {
      const result = await mutate();
      if (presentation && originState === "started" && result && typeof result === "object" &&
        "revision" in result && "status" in result) {
        presentation.origin.commit(
          token,
          Number((result as { revision: unknown }).revision),
          (result as { status: Task["status"] }).status,
        );
      }
      // The captured refresh owner outlives a sheet, but cannot target a replacement identity.
      // Query errors remain read errors; the write has already committed.
      let refreshFailed = false;
      try { await Promise.resolve(bump()); }
      catch { refreshFailed = true; }
      if (presentation && originState === "started") presentation.origin.settled(token, refreshFailed);
      return result;
    } catch (error) {
      if (presentation && originState === "started") presentation.origin.reject(token);
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
