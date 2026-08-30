import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";

/**
 * The state transition a right-swipe on a task row performs. The left swipe
 * always reveals the touch-chip row (assign/schedule/notes/waiting/more)
 * regardless of this setting — see `TaskRow.tsx`. Whatever is configured
 * here, a task that is already `done`/`cancelled` is always reopened by the
 * primary swipe instead of re-applying the configured transition, so the
 * state rules stay coherent (see `useTaskActions.ts::requestPrimarySwipe`).
 */
export const primarySwipeActions = ["complete", "someday", "cancel"] as const;
export type PrimarySwipeAction = (typeof primarySwipeActions)[number];

const STORAGE_KEY = "machbar:primary-swipe-action";
const DEFAULT_PRIMARY_SWIPE_ACTION: PrimarySwipeAction = "complete";

function isPrimarySwipeAction(value: unknown): value is PrimarySwipeAction {
  return typeof value === "string" && (primarySwipeActions as readonly string[]).includes(value);
}

export function readStoredPrimarySwipeAction(): PrimarySwipeAction {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isPrimarySwipeAction(raw) ? raw : DEFAULT_PRIMARY_SWIPE_ACTION;
  } catch {
    // localStorage may be unavailable (private mode, tests, SSR).
    return DEFAULT_PRIMARY_SWIPE_ACTION;
  }
}

interface SwipeSettingsContextValue {
  primarySwipeAction: PrimarySwipeAction;
  setPrimarySwipeAction: (action: PrimarySwipeAction) => void;
}

const SwipeSettingsContext = createContext<SwipeSettingsContextValue | null>(null);

export function SwipeSettingsProvider({ children }: { children: ReactNode }) {
  const [primarySwipeAction, setPrimarySwipeActionState] = useState<PrimarySwipeAction>(() =>
    readStoredPrimarySwipeAction(),
  );

  const setPrimarySwipeAction = useCallback((action: PrimarySwipeAction) => {
    setPrimarySwipeActionState(action);
    try {
      window.localStorage.setItem(STORAGE_KEY, action);
    } catch {
      /* localStorage may be unavailable (private mode, tests) */
    }
  }, []);

  const value = useMemo<SwipeSettingsContextValue>(
    () => ({ primarySwipeAction, setPrimarySwipeAction }),
    [primarySwipeAction, setPrimarySwipeAction],
  );

  return <SwipeSettingsContext.Provider value={value}>{children}</SwipeSettingsContext.Provider>;
}

export function useSwipeSettings(): SwipeSettingsContextValue {
  const ctx = useContext(SwipeSettingsContext);
  if (!ctx) throw new Error("useSwipeSettings must be used within a SwipeSettingsProvider");
  return ctx;
}
