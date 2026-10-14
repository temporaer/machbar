import { createContext, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { TaskDetailHandoff } from "./taskDetailContext";
import type { TaskPlanningTarget } from "./commands";

/**
 * Every focused task workflow reachable through a canonical `task.*`
 * command (see `commands.ts`) except `task.open`/`task.lifecycle`/
 * `task.toggleDone`/`task.primaryAction`, which usually mutate directly or
 * open the task-criteria completion continuation when required — see
 * `useWorkItemCommands.ts`.
 *
 * This is the single place any of these commands may open a sheet: no rail,
 * keyboard shortcut, detail-value click, or Review repair may reinterpret
 * `task.plan`/`task.waitingLifecycle`/`task.split`/etc. locally. See
 * `TaskWorkflowHost.tsx`, which is the only component that imports every
 * one of the focused sheets below and switches on `kind`.
 *
 * `availability` and `plan` both open the canonical unified planning sheet,
 * with different initial focus. `structure` opens `TaskStructureSheet` (AI
 * clarification, Aufteilen, Verschieben …/Zum Projekt machen), which itself
 * dispatches semantic commands rather than rendering another sheet.
 */
export type TaskWorkflowKind =
  | "plan"
  | "availability"
  | "deferClarification"
  | "shape"
  | "structure"
  | "waitingLifecycle"
  | "split"
  | "refinement"
  | "assignOwner"
  | "changeProject"
  | "priority"
  | "tags"
  | "contexts"
  | "convertToProject"
  | "completeWithCriteria";

export interface TaskWorkflowState {
  kind: TaskWorkflowKind;
  taskId: number;
  planningTarget?: TaskPlanningTarget;
}
interface PlanningDetailInspection {
  previousDetail: TaskDetailHandoff | null;
  planningWorkflow: TaskWorkflowState;
}

interface TaskWorkflowContextValue {
  current: TaskWorkflowState | null;
  open: (kind: TaskWorkflowKind, taskId: number, planningTarget?: TaskPlanningTarget) => void;
  close: () => void;
  detailInspection: PlanningDetailInspection | null;
  detailInspections: PlanningDetailInspection[];
  suspendForDetail: (previousDetail: TaskDetailHandoff | null) => void;
  resumeFromDetail: () => void;
}

const TaskWorkflowContext = createContext<TaskWorkflowContextValue | null>(null);

export function TaskWorkflowProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<TaskWorkflowState | null>(null);
  const [detailInspections, setDetailInspections] = useState<PlanningDetailInspection[]>([]);
  const detailInspection = detailInspections.at(-1) ?? null;
  const value = useMemo<TaskWorkflowContextValue>(
    () => ({
      current,
      detailInspection,
      detailInspections,
      suspendForDetail: (previousDetail) => {
        if (current && current !== detailInspection?.planningWorkflow) {
          setDetailInspections((previous) => [...previous, { previousDetail, planningWorkflow: current }]);
        }
      },
      resumeFromDetail: () => {
        if (detailInspection) setCurrent(detailInspection.planningWorkflow);
        setDetailInspections((previous) => previous.slice(0, -1));
      },
      open: (kind, taskId, planningTarget) =>
        setCurrent({
          kind,
          taskId,
          ...(planningTarget ? { planningTarget } : {}),
        }),
      close: () => {
        if (detailInspection) setCurrent(detailInspection.planningWorkflow);
        else setCurrent(null);
      },
    }),
    [current, detailInspection, detailInspections],
  );
  return <TaskWorkflowContext.Provider value={value}>{children}</TaskWorkflowContext.Provider>;
}

export function useTaskWorkflow(): TaskWorkflowContextValue {
  const ctx = useContext(TaskWorkflowContext);
  if (!ctx) throw new Error("useTaskWorkflow must be used within a TaskWorkflowProvider");
  return ctx;
}
