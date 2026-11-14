import { createContext, useContext, useMemo } from "react";
import type { ReactNode } from "react";
import {
  TaskWorkflowProvider,
  useOptionalTaskWorkflow,
  useTaskWorkflow,
} from "./taskWorkflowContext";

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
  openingId?: number;
};

export type WorkRefinementOrigin = {
  targetType: "task" | "project";
  targetId: number;
  originPath: string;
  entry: "task_detail" | "page";
}

export function parseWorkRefinementOrigin(value: unknown): WorkRefinementOrigin | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    (candidate.targetType !== "task" && candidate.targetType !== "project") ||
    !Number.isInteger(candidate.targetId) || (candidate.targetId as number) <= 0 ||
    typeof candidate.originPath !== "string" || !candidate.originPath.startsWith("/") || candidate.originPath.startsWith("//") ||
    (candidate.entry !== "task_detail" && candidate.entry !== "page")
  ) return null;
  return candidate as WorkRefinementOrigin;
}

interface TaskDetailContextValue {
  openTaskId: number | null;
  /** True while stepping through a "Klären" queue (Inbox clarify-all flow). */
  queueActive: boolean;
  focusField: TaskDetailFocusField | null;
  open: (taskId: number, focusField?: TaskDetailFocusField) => void;
  inspect: (taskId: number, focusField?: TaskDetailFocusField) => void;
  /** Opens the first id and remembers the rest so `advanceQueue` can step through them. */
  openQueue: (taskIds: number[], focusField?: TaskDetailFocusField) => void;
  advanceQueue: () => void;
  close: () => void;
  getHandoff: () => TaskDetailHandoff | null;
  /** Consumed by the sheet once it has applied the requested focus. */
  clearFocusField: () => void;
}

const TaskDetailContext = createContext<TaskDetailContextValue | null>(null);

export function TaskDetailProvider({ children }: { children: ReactNode }) {
  const outerWorkflow = useOptionalTaskWorkflow();
  if (!outerWorkflow) {
    return (
      <TaskWorkflowProvider>
        <TaskDetailFacade>{children}</TaskDetailFacade>
      </TaskWorkflowProvider>
    );
  }
  return <TaskDetailFacade>{children}</TaskDetailFacade>;
}

function TaskDetailFacade({ children }: { children: ReactNode }) {
  const workflow = useTaskWorkflow();
  const detail = workflow.detail;
  const open = (taskId: number, field?: TaskDetailFocusField) =>
    workflow.openDetail({
      taskId,
      queueTaskIds: [],
      queueActive: false,
      focusField: field ?? null,
    });
  const inspect = (taskId: number, field?: TaskDetailFocusField) =>
    workflow.inspectDetail({
      taskId,
      queueTaskIds: [],
      queueActive: false,
      focusField: field ?? null,
    });
  const openQueue = (taskIds: number[], field?: TaskDetailFocusField) => {
    const [first, ...rest] = taskIds;
    if (first === undefined) return;
    workflow.openDetail({
      taskId: first,
      queueTaskIds: rest,
      queueActive: true,
      focusField: field ?? null,
    });
  };
  const close = () => workflow.closeDetailDirectly();
  const getHandoff = (): TaskDetailHandoff | null => workflow.getDetailHandoff();
  const clearFocusField = () => workflow.clearDetailFocus();

  const value = useMemo<TaskDetailContextValue>(
    () => ({
      openTaskId: detail?.taskId ?? null,
      queueActive: detail?.queueActive ?? false,
      focusField: detail?.focusField ?? null,
      open,
      inspect,
      openQueue,
      advanceQueue: workflow.advanceDetailQueue,
      close,
      getHandoff,
      clearFocusField,
    }),
    [detail, workflow],
  );
  return <TaskDetailContext.Provider value={value}>{children}</TaskDetailContext.Provider>;
}

export function useTaskDetail(): TaskDetailContextValue {
  const ctx = useContext(TaskDetailContext);
  if (!ctx) throw new Error("useTaskDetail must be used within a TaskDetailProvider");
  return ctx;
}
