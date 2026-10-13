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
 * subscribes to `version` via `useAsync`. This gives cross-page consistency
 * (e.g. completing a task in the Inbox updates the Heute counts) without
 * pulling in a full data-fetching library.
 */
interface RefreshContextValue {
  version: number;
  bump: () => void;
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
  const [streamConnected, setStreamConnected] = useState(false);
  const coalesceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastExternalRefresh = useRef<number | null>(null);
  const diagnosticVersion = useRef(0);
  const invalidate = useCallback((reason: string) => {
    diagnosticVersion.current += 1;
    refreshDiagnostic(reason, diagnosticVersion.current);
    setVersion((v) => v + 1);
  }, []);
  const bump = useCallback(() => invalidate("mutation"), [invalidate]);

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
      if (coalesceTimer.current !== null) {
        clearTimeout(coalesceTimer.current);
        coalesceTimer.current = null;
      }
    },
    [],
  );

  const value = useMemo(() => ({ version, bump }), [version, bump]);
  return <RefreshContext.Provider value={value}>{children}</RefreshContext.Provider>;
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
