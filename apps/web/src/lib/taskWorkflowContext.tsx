import { createContext, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";

/**
 * Every focused task workflow reachable through a canonical `task.*`
 * command (see `commands.ts`) except `task.open`/`task.lifecycle`/
 * `task.toggleDone`/`task.primaryAction`/`task.discard`/`task.openOverflow`,
 * which are either a direct mutation or already routed through
 * `taskDetailContext`/the interaction scope's rail state — see
 * `useWorkItemCommands.ts`.
 *
 * This is the single place any of these commands may open a sheet: no rail,
 * keyboard shortcut, detail-value click, or Review repair may reinterpret
 * `task.plan`/`task.waitingLifecycle`/`task.split`/etc. locally. See
 * `TaskWorkflowHost.tsx`, which is the only component that imports every
 * one of the focused sheets below and switches on `kind`.
 */
export type TaskWorkflowKind =
  | "plan"
  | "waitingLifecycle"
  | "split"
  | "assignOwner"
  | "changeProject"
  | "changeParent"
  | "addSuccessor"
  | "recurrence"
  | "priority"
  | "tags"
  | "contexts"
  | "convertToProject";

export interface TaskWorkflowState {
  kind: TaskWorkflowKind;
  taskId: number;
}

interface TaskWorkflowContextValue {
  current: TaskWorkflowState | null;
  open: (kind: TaskWorkflowKind, taskId: number) => void;
  close: () => void;
}

const TaskWorkflowContext = createContext<TaskWorkflowContextValue | null>(null);

export function TaskWorkflowProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<TaskWorkflowState | null>(null);
  const value = useMemo<TaskWorkflowContextValue>(
    () => ({
      current,
      open: (kind, taskId) => setCurrent({ kind, taskId }),
      close: () => setCurrent(null),
    }),
    [current],
  );
  return <TaskWorkflowContext.Provider value={value}>{children}</TaskWorkflowContext.Provider>;
}

export function useTaskWorkflow(): TaskWorkflowContextValue {
  const ctx = useContext(TaskWorkflowContext);
  if (!ctx) throw new Error("useTaskWorkflow must be used within a TaskWorkflowProvider");
  return ctx;
}
