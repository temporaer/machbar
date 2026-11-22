import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { changeStreamUrl } from "./api";
import { getClientId } from "./clientId";
import { QueryClientProvider } from "@tanstack/react-query";
import type { Query } from "@tanstack/react-query";
import { createReadQueryClient, invalidateReads } from "./queryClient";

export const DISCONNECTED_POLL_MS = 120_000;
export const TIMED_ELIGIBILITY_REFRESH_MS = 60_000;
export const EXTERNAL_REFRESH_INTERVAL_MS = 1_000;

// Temporary incident diagnostics, opt-in per tab. Never log event payloads.
function refreshDiagnostic(reason: string, version: number) {
  try {
    if (window.sessionStorage.getItem("machbar:refresh-debug") === "1") {
      console.debug("[machbar refresh]", { reason, version, time: performance.now() });
    }
  } catch {
    // Storage may be unavailable; diagnostics must not affect refreshes.
  }
}

/**
 * A tiny invalidation bus: any mutation (complete a task, move it, edit a
 * project, …) calls `bump()`, and every screen that reads server data
 * invalidates the Query-owned reads. `version` remains an event notification
 * for explicit polling/activity consumers, not a second fetched-state owner.
 */
interface RefreshContextValue {
  version: number;
  bump: () => Promise<void>;
  bumpAfterQuery: (query: Query, delayMs?: number) => Promise<void>;
}

const RefreshContext = createContext<RefreshContextValue | null>(null);

export function RefreshProvider({
  children,
  remoteSyncEnabled = false,
}: {
  children: ReactNode;
  remoteSyncEnabled?: boolean;
}) {
  const [version, setVersion] = useState(0);
  const [queryClient] = useState(createReadQueryClient);
  const [streamConnected, setStreamConnected] = useState(false);
  const coalesceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastExternalRefresh = useRef<number | null>(null);
  const diagnosticVersion = useRef(0);
  const latestInvalidation = useRef<Promise<void> | null>(null);
  const deferredQueryTimers = useRef(new Map<Query, ReturnType<typeof setTimeout>>());
  const clearDeferredQueryTimers = useCallback(() => {
    for (const timer of deferredQueryTimers.current.values()) clearTimeout(timer);
    deferredQueryTimers.current.clear();
  }, []);
  const invalidate = useCallback((reason: string, except?: Query, preserveDeferred = false) => {
    if (!preserveDeferred) clearDeferredQueryTimers();
    diagnosticVersion.current += 1;
    refreshDiagnostic(reason, diagnosticVersion.current);
    setVersion((v) => v + 1);
    const work = invalidateReads(queryClient, reason === "mutation", undefined, except);
    latestInvalidation.current = work;
    return (async () => {
      // Native invalidation can cancel an older refetch. Its completion is
      // not fresh data: callers must follow the replacement's settlement.
      // These are only native read promises, never DTOs or another read queue.
      let pending = work;
      for (;;) {
        try { await pending; }
        catch (error) { if (latestInvalidation.current === pending) throw error; }
        if (latestInvalidation.current === pending) return;
        pending = latestInvalidation.current!;
      }
    })();
  }, [clearDeferredQueryTimers, queryClient]);
  const bump = useCallback(() => invalidate("mutation"), [invalidate]);
  const bumpAfterQuery = useCallback((deferredQuery: Query, delayMs = 3_000) => {
    clearDeferredQueryTimers();
    const work = invalidate("mutation", deferredQuery, true);
    const timer = setTimeout(() => {
      deferredQueryTimers.current.delete(deferredQuery);
      void invalidateReads(queryClient, true, deferredQuery).catch(() => undefined);
    }, delayMs);
    deferredQueryTimers.current.set(deferredQuery, timer);
    return work;
  }, [clearDeferredQueryTimers, invalidate, queryClient]);

  // Leading refresh plus one trailing refresh; continuous events cannot
  // postpone convergence or invalidate all queries several times per second.
  const coalescedBump = useCallback((reason: string) => {
    refreshDiagnostic(reason, diagnosticVersion.current);
    if (coalesceTimer.current !== null) return;
    const now = performance.now();
    const elapsed = lastExternalRefresh.current === null
      ? EXTERNAL_REFRESH_INTERVAL_MS
      : now - lastExternalRefresh.current;
    if (elapsed >= EXTERNAL_REFRESH_INTERVAL_MS) {
      lastExternalRefresh.current = now;
      invalidate("external-leading");
      return;
    }
    coalesceTimer.current = setTimeout(() => {
      coalesceTimer.current = null;
      lastExternalRefresh.current = performance.now();
      invalidate("external-trailing");
    }, EXTERNAL_REFRESH_INTERVAL_MS - elapsed);
  }, [invalidate]);

  useEffect(() => {
    const refreshIfVisible = (event: Event) => {
      if (document.visibilityState === "visible") coalescedBump(event.type);
    };
    window.addEventListener("focus", refreshIfVisible);
    window.addEventListener("online", refreshIfVisible);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => {
      window.removeEventListener("focus", refreshIfVisible);
      window.removeEventListener("online", refreshIfVisible);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [coalescedBump]);

  useEffect(() => {
    if (!remoteSyncEnabled || typeof EventSource === "undefined") {
      setStreamConnected(false);
      return;
    }

    const ownClientId = getClientId();
    refreshDiagnostic("sse-connect", diagnosticVersion.current);
    const stream = new EventSource(changeStreamUrl());
    stream.onopen = () => {
      setStreamConnected(true);
      coalescedBump("sse-open");
    };
    stream.onerror = () => {
      refreshDiagnostic("sse-error", diagnosticVersion.current);
      setStreamConnected(false);
    };
    stream.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as {
          originClientId?: string | null;
        };
        if (event.originClientId !== ownClientId) coalescedBump("remote-change");
      } catch {
        coalescedBump("remote-unparseable");
      }
    };
    return () => {
      refreshDiagnostic("sse-close", diagnosticVersion.current);
      stream.close();
      setStreamConnected(false);
    };
  }, [
    remoteSyncEnabled,
    coalescedBump,
  ]);

  useEffect(() => {
    if (!remoteSyncEnabled || streamConnected) return;
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") coalescedBump("disconnected-poll");
    }, DISCONNECTED_POLL_MS);
    return () => clearInterval(interval);
  }, [remoteSyncEnabled, streamConnected, coalescedBump]);

  useEffect(
    () => () => {
      clearDeferredQueryTimers();
      if (coalesceTimer.current !== null) {
        clearTimeout(coalesceTimer.current);
        coalesceTimer.current = null;
      }
    },
    [clearDeferredQueryTimers],
  );

  const value = useMemo(() => ({ version, bump, bumpAfterQuery }), [version, bump, bumpAfterQuery]);
  return (
    <QueryClientProvider client={queryClient}>
      <RefreshContext.Provider value={value}>{children}</RefreshContext.Provider>
    </QueryClientProvider>
  );
}

export function useRefresh(): RefreshContextValue {
  const ctx = useContext(RefreshContext);
  if (!ctx) throw new Error("useRefresh must be used within a RefreshProvider");
  return ctx;
}

export function useVisibleRefreshInterval(
  refresh: () => void,
  intervalMs = TIMED_ELIGIBILITY_REFRESH_MS,
) {
  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, intervalMs);
    return () => window.clearInterval(interval);
  }, [intervalMs, refresh]);
}
