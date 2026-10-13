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

export type TaskDetailHandoff = {
  taskId: number;
  queueTaskIds: number[];
  queueActive: boolean;
  focusField: TaskDetailFocusField | null;
};

export type WorkRefinementOrigin = {
  targetType: "task" | "project";
  targetId: number;
  originPath: string;
  entry: "task_detail" | "page";
  taskDetail?: TaskDetailHandoff | null;
};

export function parseWorkRefinementOrigin(value: unknown): WorkRefinementOrigin | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    (candidate.targetType !== "task" && candidate.targetType !== "project") ||
    !Number.isInteger(candidate.targetId) || (candidate.targetId as number) <= 0 ||
    typeof candidate.originPath !== "string" || !candidate.originPath.startsWith("/") || candidate.originPath.startsWith("//") ||
    (candidate.entry !== "task_detail" && candidate.entry !== "page")
  ) return null;
  if (candidate.entry === "task_detail" && candidate.taskDetail == null) return null;
  if (candidate.taskDetail !== undefined && candidate.taskDetail !== null) {
    const detail = candidate.taskDetail as Record<string, unknown>;
    if (!detail || typeof detail !== "object" || detail.taskId !== candidate.targetId || !Array.isArray(detail.queueTaskIds) || !detail.queueTaskIds.every((id) => Number.isInteger(id) && id > 0) || typeof detail.queueActive !== "boolean" || ![null, "title", "notes", "attachment", "dependencies"].includes(detail.focusField as string | null)) return null;
  }
  return candidate as WorkRefinementOrigin;
}

interface TaskDetailContextValue {
  openTaskId: number | null;
  /** True while stepping through a "Klären" queue (Inbox clarify-all flow). */
  queueActive: boolean;
  focusField: TaskDetailFocusField | null;
  suspended: boolean;
  open: (taskId: number, focusField?: TaskDetailFocusField) => void;
  /** Opens the first id and remembers the rest so `advanceQueue` can step through them. */
  openQueue: (taskIds: number[], focusField?: TaskDetailFocusField) => void;
  advanceQueue: () => void;
  close: () => void;
  suspendForHandoff: () => TaskDetailHandoff | null;
  resumeAfterHandoff: (snapshot?: TaskDetailHandoff) => void;
  /** Consumed by the sheet once it has applied the requested focus. */
  clearFocusField: () => void;
}

const TaskDetailContext = createContext<TaskDetailContextValue | null>(null);

export function TaskDetailProvider({ children }: { children: ReactNode }) {
  const [openTaskId, setOpenTaskId] = useState<number | null>(null);
  const [queue, setQueue] = useState<number[]>([]);
  const [queueActive, setQueueActive] = useState(false);
  const [focusField, setFocusField] = useState<TaskDetailFocusField | null>(null);
  const [suspended, setSuspended] = useState(false);

  const open = (taskId: number, field?: TaskDetailFocusField) => {
    setQueueActive(false);
    setQueue([]);
    setOpenTaskId(taskId);
    setFocusField(field ?? null);
    setSuspended(false);
  };

  const openQueue = (taskIds: number[], field?: TaskDetailFocusField) => {
    if (taskIds.length === 0) return;
    const [first, ...rest] = taskIds;
    setQueueActive(true);
    setQueue(rest);
    setOpenTaskId(first ?? null);
    setFocusField(field ?? null);
    setSuspended(false);
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
    setSuspended(false);
  };

  const suspendForHandoff = (): TaskDetailHandoff | null => {
    if (openTaskId === null) return null;
    const snapshot = { taskId: openTaskId, queueTaskIds: [...queue], queueActive, focusField };
    setSuspended(true);
    return snapshot;
  };

  const resumeAfterHandoff = (snapshot?: TaskDetailHandoff) => {
    if (snapshot) {
      setOpenTaskId(snapshot.taskId);
      setQueue([...snapshot.queueTaskIds]);
      setQueueActive(snapshot.queueActive);
      setFocusField(snapshot.focusField);
    }
    setSuspended(false);
  };

  const clearFocusField = () => setFocusField(null);

  const value = useMemo<TaskDetailContextValue>(
    () => ({ openTaskId, queueActive, focusField, suspended, open, openQueue, advanceQueue, close, suspendForHandoff, resumeAfterHandoff, clearFocusField }),
    [openTaskId, queueActive, focusField, suspended, queue],
  );
  return <TaskDetailContext.Provider value={value}>{children}</TaskDetailContext.Provider>;
}

export function useTaskDetail(): TaskDetailContextValue {
  const ctx = useContext(TaskDetailContext);
  if (!ctx) throw new Error("useTaskDetail must be used within a TaskDetailProvider");
  return ctx;
}
