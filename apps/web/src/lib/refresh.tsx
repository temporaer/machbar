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
const REFRESH_COALESCE_MS = 150;

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
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const coalescedBump = useCallback(() => {
    if (coalesceTimer.current !== null) return;
    coalesceTimer.current = setTimeout(() => {
      coalesceTimer.current = null;
      bump();
    }, REFRESH_COALESCE_MS);
  }, [bump]);

  useEffect(() => {
    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") coalescedBump();
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
    const stream = new EventSource(changeStreamUrl());
    stream.onopen = () => {
      setStreamConnected(true);
      coalescedBump();
    };
    stream.onerror = () => setStreamConnected(false);
    stream.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as {
          originClientId?: string | null;
        };
        if (event.originClientId !== ownClientId) coalescedBump();
      } catch {
        coalescedBump();
      }
    };
    return () => {
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
      if (document.visibilityState === "visible") coalescedBump();
    }, DISCONNECTED_POLL_MS);
    return () => clearInterval(interval);
  }, [remoteSyncEnabled, streamConnected, coalescedBump]);

  useEffect(
    () => () => {
      if (coalesceTimer.current !== null) {
        clearTimeout(coalesceTimer.current);
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
