import { createMachine, assign } from "xstate";
import { useMachine } from "@xstate/react";
import { createContext, useContext, useMemo, useRef, useState } from "react";
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
  originDetail?: TaskDetailHandoff | null;
}
export interface PlanningDetailInspection {
  previousDetail: TaskDetailHandoff | null;
  planningWorkflow: TaskWorkflowState;
  originPath: string;
  originKey: string;
}

type InspectionContext = {
  inspections: PlanningDetailInspection[];
  detailVisible: boolean;
  navigationIntent: "inspection" | "project" | "refinement" | null;
};

type InspectionEvent =
  | {
      type: "INSPECT";
      previousDetail: TaskDetailHandoff | null;
      planningWorkflow: TaskWorkflowState;
      originPath: string;
      originKey: string;
    }
  | { type: "PROJECT_NAVIGATE" }
  | { type: "HISTORY_CHANGED"; key: string; navigationType: "POP" | "PUSH" | "REPLACE" }
  | { type: "REFINEMENT_RETURN" }
  | { type: "CLOSE" };

const inspectionMachine = createMachine({
  types: {} as {
    context: InspectionContext;
    events: InspectionEvent;
  },
  id: "taskInspectionNavigation",
  initial: "idle",
  context: {
    inspections: [],
    detailVisible: true,
    navigationIntent: null,
  },
  states: {
    idle: {},
    active: {},
  },
  on: {
    INSPECT: {
      target: ".active",
      actions: assign({
        inspections: ({ context, event }) => {
          if (event.type !== "INSPECT") return context.inspections;
          const current = context.inspections.at(-1);
          const sameOperation =
            current &&
            current.originPath === event.originPath &&
            current.originKey === event.originKey &&
            current.planningWorkflow.kind === event.planningWorkflow.kind &&
            current.planningWorkflow.taskId === event.planningWorkflow.taskId &&
            current.planningWorkflow.planningTarget === event.planningWorkflow.planningTarget;
          if (sameOperation) return context.inspections;
          return [
            ...context.inspections,
            {
              previousDetail: event.previousDetail,
              planningWorkflow: event.planningWorkflow,
              originPath: event.originPath,
              originKey: event.originKey,
            },
          ];
        },
        detailVisible: true,
        navigationIntent: "inspection",
      }),
    },
    PROJECT_NAVIGATE: {
      target: ".active",
      actions: assign({ navigationIntent: "project", detailVisible: false }),
    },
    HISTORY_CHANGED: {
      target: ".active",
      actions: assign({
        inspections: ({ context, event }) => {
          if (
            event.type !== "HISTORY_CHANGED" ||
            context.navigationIntent !== "refinement" ||
            event.navigationType !== "REPLACE"
          ) {
            return context.inspections;
          }
          const returningOriginKey = context.inspections.at(-1)?.originKey;
          if (!returningOriginKey) return context.inspections;
          return context.inspections.map((inspection) =>
            inspection.originKey === returningOriginKey
              ? { ...inspection, originKey: event.key }
              : inspection,
          );
        },
        detailVisible: ({ context, event }) => {
          if (event.type !== "HISTORY_CHANGED") return context.detailVisible;
          if (context.navigationIntent === "refinement") return true;
          const current = context.inspections.at(-1);
          if (!current) return true;
          return event.navigationType === "POP" && event.key === current.originKey;
        },
        navigationIntent: "inspection",
      }),
    },
    REFINEMENT_RETURN: {
      target: ".active",
      actions: assign({
        detailVisible: true,
        navigationIntent: "refinement",
      }),
    },
    CLOSE: {
      target: ".active",
      actions: assign({
        inspections: ({ context }) => context.inspections.slice(0, -1),
        detailVisible: true,
        navigationIntent: null,
      }),
    },
  },
});

interface TaskWorkflowContextValue {
  current: TaskWorkflowState | null;
  open: (kind: TaskWorkflowKind, taskId: number, planningTarget?: TaskPlanningTarget, originDetail?: TaskDetailHandoff | null) => void;
  close: () => void;
  closeDetail: () => void;
  detailReturn: TaskDetailHandoff | null;
  consumeDetailReturn: () => void;
  detailInspection: PlanningDetailInspection | null;
  detailInspections: PlanningDetailInspection[];
  detailVisible: boolean;
  detailClosing: boolean;
  navigationIntent: InspectionContext["navigationIntent"];
  suspendForDetail: (previousDetail: TaskDetailHandoff | null, originPath: string, originKey: string) => void;
  navigateProject: () => void;
  historyChanged: (key: string, navigationType: "POP" | "PUSH" | "REPLACE") => void;
  refinementReturn: () => void;
  resumeFromDetail: () => void;
}

const TaskWorkflowContext = createContext<TaskWorkflowContextValue | null>(null);

export function TaskWorkflowProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<TaskWorkflowState | null>(null);
  const [detailReturn, setDetailReturn] = useState<TaskDetailHandoff | null>(null);
  const [detailClosing, setDetailClosing] = useState(false);
  const detailCloseRequested = useRef(false);
  const pendingDetailWorkflow = useRef<TaskWorkflowState | null>(null);
  const pendingDetailReturn = useRef<TaskDetailHandoff | null>(null);
  const [snapshot, send] = useMachine(inspectionMachine);
  const { inspections: detailInspections, detailVisible, navigationIntent } = snapshot.context;
  const detailInspection = detailInspections.at(-1) ?? null;
  const value = useMemo<TaskWorkflowContextValue>(
    () => ({
      current,
      detailInspection,
      detailInspections,
      detailVisible,
      navigationIntent,
      detailClosing,
      suspendForDetail: (previousDetail, originPath, originKey) => {
        const planningWorkflow = current ?? detailInspection?.planningWorkflow ?? null;
        if (planningWorkflow) {
          detailCloseRequested.current = false;
          setDetailClosing(false);
          send({ type: "INSPECT", previousDetail, planningWorkflow, originPath, originKey });
        }
      },
      navigateProject: () => send({ type: "PROJECT_NAVIGATE" }),
      historyChanged: (key, navigationType) => send({ type: "HISTORY_CHANGED", key, navigationType }),
      refinementReturn: () => {
        setDetailClosing(false);
        setCurrent(null);
        send({ type: "REFINEMENT_RETURN" });
      },
      resumeFromDetail: () => {
        if (detailInspection) {
          setCurrent(detailInspection.planningWorkflow);
        }
      },
      open: (kind, taskId, planningTarget, originDetail) =>
        setCurrent({
          kind,
          taskId,
          ...(planningTarget ? { planningTarget } : {}),
          ...(originDetail !== undefined ? { originDetail } : {}),
        }),
      close: () => {
        if (current && pendingDetailWorkflow.current === current) {
          detailCloseRequested.current = false;
          setDetailClosing(false);
          setDetailReturn(pendingDetailReturn.current ?? detailInspection?.previousDetail ?? current.originDetail ?? null);
          pendingDetailWorkflow.current = null;
          pendingDetailReturn.current = null;
          send({ type: "CLOSE" });
          setCurrent(null);
          return;
        }
        if (detailInspection) {
          if (current !== detailInspection.planningWorkflow) {
            setCurrent(detailInspection.planningWorkflow);
          } else {
            if (detailInspection.previousDetail) {
              setDetailReturn(detailInspection.previousDetail);
            }
            setDetailClosing(false);
            send({ type: "CLOSE" });
            setCurrent(null);
          }
        } else {
          setDetailClosing(false);
          setCurrent(null);
        }
      },
      closeDetail: () => {
        if (detailCloseRequested.current) return;
        if (detailInspection) {
          detailCloseRequested.current = true;
          setDetailClosing(true);
          pendingDetailWorkflow.current = detailInspection.planningWorkflow;
          pendingDetailReturn.current = detailInspection.previousDetail;
          setCurrent(detailInspection.planningWorkflow);
        }
      },
      detailReturn,
      consumeDetailReturn: () => setDetailReturn(null),
    }),
    [current, detailInspection, detailInspections, detailVisible, navigationIntent, detailReturn, detailClosing, send],
  );
  return <TaskWorkflowContext.Provider value={value}>{children}</TaskWorkflowContext.Provider>;
}

export function useTaskWorkflow(): TaskWorkflowContextValue {
  const ctx = useContext(TaskWorkflowContext);
  if (!ctx) throw new Error("useTaskWorkflow must be used within a TaskWorkflowProvider");
  return ctx;
}
