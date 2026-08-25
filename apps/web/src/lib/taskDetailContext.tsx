import { createContext, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";

interface TaskDetailContextValue {
  openTaskId: number | null;
  /** True while stepping through a "Klären" queue (Inbox clarify-all flow). */
  queueActive: boolean;
  open: (taskId: number) => void;
  /** Opens the first id and remembers the rest so `advanceQueue` can step through them. */
  openQueue: (taskIds: number[]) => void;
  advanceQueue: () => void;
  close: () => void;
}

const TaskDetailContext = createContext<TaskDetailContextValue | null>(null);

export function TaskDetailProvider({ children }: { children: ReactNode }) {
  const [openTaskId, setOpenTaskId] = useState<number | null>(null);
  const [queue, setQueue] = useState<number[]>([]);
  const [queueActive, setQueueActive] = useState(false);

  const open = (taskId: number) => {
    setQueueActive(false);
    setQueue([]);
    setOpenTaskId(taskId);
  };

  const openQueue = (taskIds: number[]) => {
    if (taskIds.length === 0) return;
    const [first, ...rest] = taskIds;
    setQueueActive(true);
    setQueue(rest);
    setOpenTaskId(first ?? null);
  };

  const advanceQueue = () => {
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
  };

  const value = useMemo<TaskDetailContextValue>(
    () => ({ openTaskId, queueActive, open, openQueue, advanceQueue, close }),
    [openTaskId, queueActive],
  );
  return <TaskDetailContext.Provider value={value}>{children}</TaskDetailContext.Provider>;
}

export function useTaskDetail(): TaskDetailContextValue {
  const ctx = useContext(TaskDetailContext);
  if (!ctx) throw new Error("useTaskDetail must be used within a TaskDetailProvider");
  return ctx;
}
