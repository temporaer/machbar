import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";

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

export function RefreshProvider({ children }: { children: ReactNode }) {
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const value = useMemo(() => ({ version, bump }), [version, bump]);
  return <RefreshContext.Provider value={value}>{children}</RefreshContext.Provider>;
}

export function useRefresh(): RefreshContextValue {
  const ctx = useContext(RefreshContext);
  if (!ctx) throw new Error("useRefresh must be used within a RefreshProvider");
  return ctx;
}
