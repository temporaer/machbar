import { createContext, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";

/**
 * Hints which part of the detail sheet to focus once it opens. This is
 * deliberately limited to the document-like content the sheet itself owns
 * (title, notes, attachments, dependencies); every scalar work-item property
 * is edited through its own semantic `task.*` command and focused workflow,
 * never through a focus hint into this sheet.
 */
export type TaskDetailFocusField =
  | "title"
  | "notes"
  | "attachment"
  | "dependencies";

interface TaskDetailContextValue {
  openTaskId: number | null;
  /** True while stepping through a "Klären" queue (Inbox clarify-all flow). */
  queueActive: boolean;
  focusField: TaskDetailFocusField | null;
  /**
   * Unsaved text seeded into the focused title/notes editor (title: replaces
   * the draft; notes: appended). Saving still requires the editor's Save.
   */
  focusDraft: string | null;
  open: (taskId: number, focusField?: TaskDetailFocusField, draft?: string) => void;
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
  const [focusDraft, setFocusDraft] = useState<string | null>(null);

  const open = (taskId: number, field?: TaskDetailFocusField, draft?: string) => {
    setQueueActive(false);
    setQueue([]);
    setOpenTaskId(taskId);
    setFocusField(field ?? null);
    setFocusDraft(field && draft ? draft : null);
  };

  const openQueue = (taskIds: number[], field?: TaskDetailFocusField) => {
    if (taskIds.length === 0) return;
    const [first, ...rest] = taskIds;
    setQueueActive(true);
    setQueue(rest);
    setOpenTaskId(first ?? null);
    setFocusField(field ?? null);
    setFocusDraft(null);
  };

  const advanceQueue = () => {
    setFocusField(null);
    setFocusDraft(null);
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
    setFocusDraft(null);
  };

  const clearFocusField = () => {
    setFocusField(null);
    setFocusDraft(null);
  };

  const value = useMemo<TaskDetailContextValue>(
    () => ({ openTaskId, queueActive, focusField, focusDraft, open, openQueue, advanceQueue, close, clearFocusField }),
    [openTaskId, queueActive, focusField, focusDraft],
  );
  return <TaskDetailContext.Provider value={value}>{children}</TaskDetailContext.Provider>;
}

export function useTaskDetail(): TaskDetailContextValue {
  const ctx = useContext(TaskDetailContext);
  if (!ctx) throw new Error("useTaskDetail must be used within a TaskDetailProvider");
  return ctx;
}
