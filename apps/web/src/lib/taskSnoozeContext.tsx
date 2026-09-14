import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useIdentity } from "./identity";
import {
  isSnoozeActive,
  readSnoozeEntries,
  writeSnoozeEntries,
  type TaskSnoozeEntry,
} from "./taskSnooze";

const PRUNE_INTERVAL_MS = 30_000;

interface TaskSnoozeContextValue {
  /** Whether `taskId` is currently snoozed for the active member. */
  isSnoozed: (taskId: number) => boolean;
  /** Snoozes `taskId` until `until` for the active member only. */
  snooze: (taskId: number, until: Date) => void;
  clearSnooze: (taskId: number) => void;
}

const TaskSnoozeContext = createContext<TaskSnoozeContextValue | null>(null);

/**
 * Member-scoped, ephemeral "Später" same-day snooze state (see
 * `taskSnooze.ts`). Pure client/local-storage state, recomputed on a short
 * interval so an expired snooze naturally stops hiding its task again —
 * there is no server write and no effect on `scheduledDate`/`externalWait`,
 * so a task snoozed by one household member stays fully visible to every
 * other member.
 */
export function TaskSnoozeProvider({ children }: { children: ReactNode }) {
  const { currentMemberId } = useIdentity();
  const [entries, setEntries] = useState<TaskSnoozeEntry[]>(() =>
    readSnoozeEntries(currentMemberId),
  );

  useEffect(() => {
    setEntries(readSnoozeEntries(currentMemberId));
  }, [currentMemberId]);

  // Periodically prune expired entries so a snooze that has run out
  // re-surfaces its task without requiring any other state change.
  useEffect(() => {
    const interval = setInterval(() => {
      setEntries((current) => {
        const pruned = current.filter((entry) => isSnoozeActive(entry));
        if (pruned.length !== current.length) {
          writeSnoozeEntries(pruned, currentMemberId);
          return pruned;
        }
        return current;
      });
    }, PRUNE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [currentMemberId]);

  const isSnoozed = useCallback(
    (taskId: number) => entries.some((entry) => entry.taskId === taskId && isSnoozeActive(entry)),
    [entries],
  );

  const snooze = useCallback(
    (taskId: number, until: Date) => {
      setEntries((current) => {
        const next = [
          ...current.filter((entry) => entry.taskId !== taskId),
          { taskId, until: until.toISOString() },
        ];
        writeSnoozeEntries(next, currentMemberId);
        return next;
      });
    },
    [currentMemberId],
  );

  const clearSnooze = useCallback(
    (taskId: number) => {
      setEntries((current) => {
        const next = current.filter((entry) => entry.taskId !== taskId);
        writeSnoozeEntries(next, currentMemberId);
        return next;
      });
    },
    [currentMemberId],
  );

  const value = useMemo(
    () => ({ isSnoozed, snooze, clearSnooze }),
    [isSnoozed, snooze, clearSnooze],
  );

  return <TaskSnoozeContext.Provider value={value}>{children}</TaskSnoozeContext.Provider>;
}

export function useTaskSnooze(): TaskSnoozeContextValue {
  const ctx = useContext(TaskSnoozeContext);
  if (!ctx) throw new Error("useTaskSnooze must be used within a TaskSnoozeProvider");
  return ctx;
}
