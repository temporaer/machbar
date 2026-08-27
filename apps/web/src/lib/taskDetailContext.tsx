import { createContext, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";

/**
 * Hints which part of the detail sheet to focus once it opens. Used by the
 * mobile swipe-chip actions (Zuweisen/Planen/Notizen) so tapping a chip
 * lands the user directly in the relevant field of the existing edit flow
 * instead of just opening the sheet at the top.
 */
export type TaskDetailFocusField =
  | "title"
  | "owner"
  | "schedule"
  | "notes"
  | "dependencies"
  | "subtasks";

interface TaskDetailContextValue {
  openTaskId: number | null;
  /** True while stepping through a "Klären" queue (Inbox clarify-all flow). */
  queueActive: boolean;
  focusField: TaskDetailFocusField | null;
  open: (taskId: number, focusField?: TaskDetailFocusField) => void;
  /** Opens the first id and remembers the rest so `advanceQueue` can step through them. */
  openQueue: (taskIds: number[], focusField?: TaskDetailFocusField) => void;
  advanceQueue: () => void;
  close: () => void;
  /** Consumed by the sheet once it has applied the requested focus. */
  clearFocusField: () => void;
}

const TaskDetailContext = createContext<TaskDetailContextValue | null>(null);

export function TaskDetailProvider({ children }: { children: ReactNode }) {
  const [openTaskId, setOpenTaskId] = useState<number | null>(null);
  const [queue, setQueue] = useState<number[]>([]);
  const [queueActive, setQueueActive] = useState(false);
  const [focusField, setFocusField] = useState<TaskDetailFocusField | null>(null);

  const open = (taskId: number, field?: TaskDetailFocusField) => {
    setQueueActive(false);
    setQueue([]);
    setOpenTaskId(taskId);
    setFocusField(field ?? null);
  };

  const openQueue = (taskIds: number[], field?: TaskDetailFocusField) => {
    if (taskIds.length === 0) return;
    const [first, ...rest] = taskIds;
    setQueueActive(true);
    setQueue(rest);
    setOpenTaskId(first ?? null);
    setFocusField(field ?? null);
  };

  const advanceQueue = () => {
    setFocusField(null);
    setQueue((current) => {
      const [next, ...rest] = current;
      if (next === undefined) {
        setOpenTaskId(null);
        setQueueActive(false);
        return [];
      }
      setOpenTaskId(next);
      return rest;
    });
  };

  const close = () => {
    setOpenTaskId(null);
    setQueue([]);
    setQueueActive(false);
    setFocusField(null);
  };

  const clearFocusField = () => setFocusField(null);

  const value = useMemo<TaskDetailContextValue>(
    () => ({ openTaskId, queueActive, focusField, open, openQueue, advanceQueue, close, clearFocusField }),
    [openTaskId, queueActive, focusField],
  );
  return <TaskDetailContext.Provider value={value}>{children}</TaskDetailContext.Provider>;
}

export function useTaskDetail(): TaskDetailContextValue {
  const ctx = useContext(TaskDetailContext);
  if (!ctx) throw new Error("useTaskDetail must be used within a TaskDetailProvider");
  return ctx;
}
