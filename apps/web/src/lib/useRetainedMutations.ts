import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isStaleWriteConflict, isWorkItemAccessError, localizedErrorMessage } from "./errorMessage";
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

interface MutationOptions<TStored> {
  immediateRefresh?: boolean;
  identityKey?: string | object;
  receiptRevision?: (value: TStored) => number;
}

function mutationState<TStored>() {
  const errors: Record<number, string> = {};
  return {
    pendingIds: new Set<number>(),
    retained: new Map<number, TStored>(),
    holdingIds: new Set<number>(),
    errors,
    confirmed: new Map<number, TStored>(),
  };
}

export function useRetainedMutations<TStored>({
  immediateRefresh = false,
  identityKey,
  receiptRevision,
}: MutationOptions<TStored> = {}) {
  const strings = useStrings();
  const { bump } = useRefresh();
  const [, render] = useState(0);
  const runtime = useMemo(() => ({
    state: mutationState<TStored>(),
    scopeToken: {},
    active: true,
    leases: new Map<number, number>(),
    deadlines: new Map<number, number>(),
    timers: new Map<number, ReturnType<typeof setTimeout>>(),
    inFlight: new Set<number>(),
    targetTokens: new Map<number, object>(),
    invalidated: new Set<number>(),
    observed: new WeakMap<object, Set<number>>(),
    commandIds: new Set<number>(),
  }), [identityKey]);
  const currentRuntime = useRef(runtime);
  currentRuntime.current = runtime;
  const scopeToken = runtime.scopeToken;
  const isCurrentScope = useCallback((token: object) =>
    runtime.active && currentRuntime.current === runtime && runtime.scopeToken === token, [runtime]);
  const change = useCallback((update: (current: typeof runtime.state) => typeof runtime.state) => {
    if (!isCurrentScope(scopeToken)) return;
    const next = update(runtime.state);
    if (next === runtime.state) return;
    runtime.state = next;
    render(value => value + 1);
  }, [isCurrentScope, runtime, scopeToken]);
  useEffect(() => {
    if (!runtime.active) {
      runtime.active = true;
      render(value => value + 1);
    }
    return () => {
      runtime.active = false;
      runtime.scopeToken = {};
      runtime.timers.forEach(clearTimeout);
      runtime.timers.clear();
      runtime.leases.clear();
      runtime.deadlines.clear();
      runtime.inFlight.clear();
      runtime.targetTokens.clear();
      runtime.invalidated.clear();
      runtime.observed = new WeakMap();
      runtime.commandIds.clear();
      runtime.state = mutationState<TStored>();
    };
  }, [runtime]);

  const release = useCallback((id: number, refresh = false) => {
    if (!isCurrentScope(scopeToken)) return;
    const timer = runtime.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      runtime.timers.delete(id);
    }
    runtime.deadlines.delete(id);
    change(current => {
      if (!current.holdingIds.has(id) && !current.retained.has(id)) return current;
      const holdingIds = new Set(current.holdingIds);
      const retained = new Map(current.retained);
      holdingIds.delete(id);
      retained.delete(id);
      return { ...current, holdingIds, retained };
    });
    if (refresh) bump();
  }, [bump, change, isCurrentScope, runtime, scopeToken]);

  const retain = useCallback((id: number, value: TStored) => {
    change(current => ({ ...current, retained: new Map(current.retained).set(id, value) }));
  }, [change]);

  const recordConfirmed = useCallback((id: number, value: TStored, authoritative = false) => {
    if (!receiptRevision) return;
    change(current => {
      const previous = current.confirmed.get(id);
      if (previous !== undefined && (previous === value ||
        receiptRevision(previous) > receiptRevision(value) ||
        (!authoritative && receiptRevision(previous) === receiptRevision(value)))) return current;
      return { ...current, confirmed: new Map(current.confirmed).set(id, value) };
    });
  }, [change, receiptRevision]);
  const getConfirmed = useCallback((id: number) =>
    isCurrentScope(scopeToken) && !runtime.invalidated.has(id)
      ? runtime.state.confirmed.get(id) : undefined, [isCurrentScope, runtime, scopeToken]);
  const observeConfirmed = useCallback((id: number, value: TStored, source: unknown = value, authorizedRead = false) => {
    if (!isCurrentScope(scopeToken) || !receiptRevision ||
      (runtime.invalidated.has(id) && !authorizedRead)) return;
    if (!authorizedRead && !runtime.state.confirmed.has(id) && !runtime.inFlight.has(id)) return;
    const restoring = runtime.invalidated.has(id);
    if (authorizedRead) runtime.invalidated.delete(id);
    if (typeof source === "object" && source !== null) {
      const observedIds = runtime.observed.get(source) ?? new Set<number>();
      if (observedIds.has(id) && !restoring && runtime.state.confirmed.has(id)) return;
      observedIds.add(id);
      runtime.observed.set(source, observedIds);
    }
    recordConfirmed(id, value, true);
  }, [isCurrentScope, receiptRevision, recordConfirmed, runtime, scopeToken]);
  const invalidateConfirmed = useCallback((id: number) => {
    if (!isCurrentScope(scopeToken)) return;
    runtime.targetTokens.set(id, {});
    runtime.invalidated.add(id);
    release(id);
    change(current => {
      const confirmed = new Map(current.confirmed);
      confirmed.delete(id);
      return { ...current, confirmed };
    });
  }, [change, isCurrentScope, release, runtime, scopeToken]);

  const schedule = useCallback(function scheduleExpiry(id: number) {
    if (!isCurrentScope(scopeToken)) return;
    const token = scopeToken;
    const existing = runtime.timers.get(id);
    if (existing) clearTimeout(existing);
    runtime.timers.delete(id);
    const deadline = runtime.deadlines.get(id);
    if (deadline === undefined || runtime.leases.has(id)) return;
    runtime.timers.set(id, setTimeout(() => {
      if (!isCurrentScope(token)) return;
      runtime.timers.delete(id);
      runtime.deadlines.delete(id);
      if (!immediateRefresh) {
        change(current => {
          const retained = new Map(current.retained);
          retained.delete(id);
          return { ...current, retained };
        });
        bump();
      }
      change(current => {
        const holdingIds = new Set(current.holdingIds);
        holdingIds.delete(id);
        return { ...current, holdingIds };
      });
    }, Math.max(0, deadline - Date.now())));
  }, [bump, change, immediateRefresh, isCurrentScope, runtime, scopeToken]);

  const pauseRetention = useCallback((id: number) => {
    const token = scopeToken;
    if (!isCurrentScope(token)) return () => {};
    runtime.leases.set(id, (runtime.leases.get(id) ?? 0) + 1);
    const timer = runtime.timers.get(id);
    if (timer) clearTimeout(timer);
    runtime.timers.delete(id);
    return () => {
      if (!isCurrentScope(token)) return;
      const remaining = (runtime.leases.get(id) ?? 1) - 1;
      if (remaining > 0) runtime.leases.set(id, remaining);
      else {
        runtime.leases.delete(id);
        if (!runtime.commandIds.has(id) && !runtime.inFlight.has(id)) {
          change(current => {
            if (!current.confirmed.has(id)) return current;
            const confirmed = new Map(current.confirmed);
            confirmed.delete(id);
            return { ...current, confirmed };
          });
        }
        const deadline = runtime.deadlines.get(id);
        if (deadline !== undefined) {
          runtime.deadlines.set(id, Math.max(deadline, Date.now() + 2000));
          schedule(id);
        }
      }
    };
  }, [change, isCurrentScope, runtime, schedule, scopeToken]);

  const clearError = useCallback((id: number) => {
    change(current => {
      if (!(id in current.errors)) return current;
      const errors = { ...current.errors };
      delete errors[id];
      return { ...current, errors };
    });
  }, [change]);

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
      const token = scopeToken;
      if (!isCurrentScope(token)) return undefined;
      const targetToken = runtime.targetTokens.get(id);
      const canPublish = () => isCurrentScope(token) && runtime.targetTokens.get(id) === targetToken;
      if (runtime.inFlight.has(id)) {
        const error = new Error("An update for this item is already in progress.");
        change((current) => ({
          ...current,
          errors: { ...current.errors, [id]: localizedErrorMessage(error, strings) },
        }));
        if (throwOnError) throw error;
        return undefined;
      }
      runtime.inFlight.add(id);
      if (receiptRevision) runtime.commandIds.add(id);
      change((current) => ({ ...current, pendingIds: new Set(current.pendingIds).add(id) }));
      clearError(id);
      const holdPosition = !retainUntilRefresh || runtime.deadlines.has(id);
      const oldTimer = runtime.timers.get(id);
      if (oldTimer) clearTimeout(oldTimer);
      runtime.timers.delete(id);
      runtime.deadlines.delete(id);
      if (optimistic !== undefined) {
        retain(id, optimistic);
        if (holdPosition) change((current) => ({ ...current, holdingIds: new Set(current.holdingIds).add(id) }));
      }

      try {
        const result = await mutate();
        if (!canPublish()) {
          if (currentRuntime.current.active) bump();
          return undefined;
        }
        const value = confirmed?.(result);
        if (value !== undefined) {
          runtime.invalidated.delete(id);
          recordConfirmed(id, value);
        }
        if (shouldRetain) {
          if (value !== undefined) retain(id, value);
          if (holdPosition) {
            change((current) => ({ ...current, holdingIds: new Set(current.holdingIds).add(id) }));
            runtime.deadlines.set(id, Date.now() + RETENTION_MS);
            schedule(id);
          }
          if (immediateRefresh || refreshImmediately) bump();
        } else {
          release(id);
          bump();
        }
        return result;
      } catch (error) {
        if (!canPublish()) return undefined;
        release(id);
        if (isStaleWriteConflict(error) || isWorkItemAccessError(error)) bump();
        change((current) => ({
          ...current,
          errors: { ...current.errors, [id]: localizedErrorMessage(error, strings) },
        }));
        if (throwOnError) throw error;
        return undefined;
      } finally {
        if (isCurrentScope(token)) {
          runtime.inFlight.delete(id);
          change((current) => {
            const next = new Set(current.pendingIds);
            next.delete(id);
            return { ...current, pendingIds: next };
          });
        }
      }
    },
    [bump, change, clearError, release, retain, schedule, strings, immediateRefresh, isCurrentScope, receiptRevision, recordConfirmed, runtime, scopeToken],
  );

  const { pendingIds, holdingIds, retained, errors } = runtime.state;
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
    getConfirmed,
    observeConfirmed,
    invalidateConfirmed,
    scopeToken,
    isCurrentScope,
    confirmedSnapshots: runtime.state.confirmed,
  };
}
