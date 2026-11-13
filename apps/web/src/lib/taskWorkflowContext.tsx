import { createContext, useContext, useMemo, useReducer } from "react";
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
 * focused sheet below and switches on `kind`.
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
  openingId: number;
  previousDetail: TaskDetailHandoff | null;
  planningWorkflow: TaskWorkflowState;
  originPath: string;
  originKey: string;
}

type NavigationIntent = "inspection" | "project" | "refinement" | null;

type WorkflowState = {
  current: TaskWorkflowState | null;
  currentOpeningId: number | null;
  inspections: PlanningDetailInspection[];
  detailReturn: TaskDetailHandoff | null;
  detailVisible: boolean;
  detailClosing: boolean;
  navigationIntent: NavigationIntent;
  pendingClose: {
    openingId: number;
    previousDetail: TaskDetailHandoff | null;
  } | null;
  nextOpeningId: number;
};

type WorkflowEvent =
  | {
      type: "OPEN";
      workflow: TaskWorkflowState;
    }
  | {
      type: "INSPECT";
      previousDetail: TaskDetailHandoff | null;
      planningWorkflow: TaskWorkflowState;
      originPath: string;
      originKey: string;
    }
  | { type: "PROJECT_NAVIGATE" }
  | {
      type: "HISTORY_CHANGED";
      key: string;
      navigationType: "POP" | "PUSH" | "REPLACE";
    }
  | { type: "REFINEMENT_RETURN" }
  | { type: "CLOSE" }
  | { type: "CLOSE_DETAIL" }
  | { type: "RESUME_FROM_DETAIL" }
  | { type: "CONSUME_DETAIL_RETURN" };

const initialState: WorkflowState = {
  current: null,
  currentOpeningId: null,
  inspections: [],
  detailReturn: null,
  detailVisible: true,
  detailClosing: false,
  navigationIntent: null,
  pendingClose: null,
  nextOpeningId: 1,
};

function sameOperation(
  inspection: PlanningDetailInspection | undefined,
  workflow: TaskWorkflowState,
  originPath: string,
  originKey: string,
) {
  return Boolean(
    inspection &&
      inspection.originPath === originPath &&
      inspection.originKey === originKey &&
      inspection.planningWorkflow.kind === workflow.kind &&
      inspection.planningWorkflow.taskId === workflow.taskId &&
      inspection.planningWorkflow.planningTarget === workflow.planningTarget,
  );
}

function workflowReducer(state: WorkflowState, event: WorkflowEvent): WorkflowState {
  switch (event.type) {
    case "OPEN":
      {
        const openingId = state.nextOpeningId;
        return {
          ...state,
          current: event.workflow,
          currentOpeningId: openingId,
          detailClosing: false,
          pendingClose: null,
          nextOpeningId: openingId + 1,
        };
      }
    case "INSPECT": {
      const current = state.inspections.at(-1);
      if (sameOperation(current, event.planningWorkflow, event.originPath, event.originKey)) {
        return {
          ...state,
          detailVisible: true,
          detailClosing: false,
          navigationIntent: "inspection",
          pendingClose: null,
        };
      }
      const openingId =
        state.current === event.planningWorkflow && state.currentOpeningId !== null
          ? state.currentOpeningId
          : state.nextOpeningId;
      return {
        ...state,
        currentOpeningId:
          state.current === event.planningWorkflow ? openingId : state.currentOpeningId,
        inspections: [
          ...state.inspections,
          {
            openingId,
            previousDetail: event.previousDetail,
            planningWorkflow: event.planningWorkflow,
            originPath: event.originPath,
            originKey: event.originKey,
          },
        ],
        detailVisible: true,
        detailClosing: false,
        navigationIntent: "inspection",
        pendingClose: null,
        nextOpeningId:
          openingId === state.nextOpeningId ? openingId + 1 : state.nextOpeningId,
      };
    }
    case "PROJECT_NAVIGATE":
      return {
        ...state,
        detailVisible: false,
        navigationIntent: "project",
      };
    case "HISTORY_CHANGED": {
      const top = state.inspections.at(-1);
      let inspections = state.inspections;
      if (
        state.navigationIntent === "refinement" &&
        event.navigationType === "REPLACE" &&
        top
      ) {
        inspections = state.inspections.map((inspection) =>
          inspection.originKey === top.originKey
            ? { ...inspection, originKey: event.key }
            : inspection,
        );
      }
      const current = inspections.at(-1);
      return {
        ...state,
        inspections,
        detailVisible:
          state.navigationIntent === "refinement"
            ? true
            : !current ||
                (event.navigationType === "POP" && event.key === current.originKey),
        navigationIntent: "inspection",
      };
    }
    case "REFINEMENT_RETURN":
      return {
        ...state,
        current: null,
        currentOpeningId: null,
        detailVisible: true,
        detailClosing: false,
        navigationIntent: "refinement",
        pendingClose: null,
      };
    case "CLOSE": {
      const top = state.inspections.at(-1);
      if (state.pendingClose && state.currentOpeningId === state.pendingClose.openingId) {
        return {
          ...state,
          inspections: state.inspections.slice(0, -1),
          current: null,
          currentOpeningId: null,
          detailReturn:
            state.pendingClose.previousDetail ??
            top?.previousDetail ??
            state.current?.originDetail ??
            null,
          detailVisible: true,
          detailClosing: false,
          navigationIntent: null,
          pendingClose: null,
        };
      }
      if (!top) {
        return {
          ...state,
          current: null,
          currentOpeningId: null,
          detailClosing: false,
          navigationIntent: null,
          pendingClose: null,
        };
      }
      if (
        state.current &&
        state.currentOpeningId !== top.openingId &&
        state.current.originDetail
      ) {
        return {
          ...state,
          current: null,
          currentOpeningId: null,
          detailReturn: state.current.originDetail,
          detailVisible: true,
          detailClosing: false,
          navigationIntent: null,
          pendingClose: null,
        };
      }
      if (state.currentOpeningId !== top.openingId) {
        return {
          ...state,
          current: top.planningWorkflow,
          currentOpeningId: top.openingId,
          detailClosing: false,
          pendingClose: null,
        };
      }
      return {
        ...state,
        inspections: state.inspections.slice(0, -1),
        current: null,
        currentOpeningId: null,
        detailReturn: top.previousDetail ?? null,
        detailVisible: true,
        detailClosing: false,
        navigationIntent: null,
        pendingClose: null,
      };
    }
    case "CLOSE_DETAIL": {
      const top = state.inspections.at(-1);
      if (!top || state.pendingClose) return state;
      return {
        ...state,
        current: top.planningWorkflow,
        currentOpeningId: top.openingId,
        detailClosing: true,
        pendingClose: {
          openingId: top.openingId,
          previousDetail: top.previousDetail,
        },
      };
    }
    case "RESUME_FROM_DETAIL": {
      const top = state.inspections.at(-1);
      return top
        ? {
            ...state,
            current: top.planningWorkflow,
            currentOpeningId: top.openingId,
          }
        : state;
    }
    case "CONSUME_DETAIL_RETURN":
      return { ...state, detailReturn: null };
  }
}

interface TaskWorkflowContextValue {
  current: TaskWorkflowState | null;
  currentOpeningId: number | null;
  open: (
    kind: TaskWorkflowKind,
    taskId: number,
    planningTarget?: TaskPlanningTarget,
    originDetail?: TaskDetailHandoff | null,
  ) => void;
  close: () => void;
  closeDetail: () => void;
  detailReturn: TaskDetailHandoff | null;
  consumeDetailReturn: () => void;
  detailInspection: PlanningDetailInspection | null;
  detailInspections: PlanningDetailInspection[];
  detailVisible: boolean;
  detailClosing: boolean;
  navigationIntent: NavigationIntent;
  suspendForDetail: (
    previousDetail: TaskDetailHandoff | null,
    originPath: string,
    originKey: string,
  ) => void;
  navigateProject: () => void;
  historyChanged: (
    key: string,
    navigationType: "POP" | "PUSH" | "REPLACE",
  ) => void;
  refinementReturn: () => void;
  resumeFromDetail: () => void;
}

const TaskWorkflowContext = createContext<TaskWorkflowContextValue | null>(null);

export function TaskWorkflowProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(workflowReducer, initialState);
  const detailInspection = state.inspections.at(-1) ?? null;
  const value = useMemo<TaskWorkflowContextValue>(
    () => ({
      current: state.current,
      currentOpeningId: state.currentOpeningId,
      detailInspection,
      detailInspections: state.inspections,
      detailVisible: state.detailVisible,
      navigationIntent: state.navigationIntent,
      detailClosing: state.detailClosing,
      detailReturn: state.detailReturn,
      open: (kind, taskId, planningTarget, originDetail) => {
        const workflow: TaskWorkflowState = {
          kind,
          taskId,
          ...(planningTarget ? { planningTarget } : {}),
          ...(originDetail !== undefined ? { originDetail } : {}),
        };
        dispatch({ type: "OPEN", workflow });
      },
      close: () => dispatch({ type: "CLOSE" }),
      closeDetail: () => dispatch({ type: "CLOSE_DETAIL" }),
      consumeDetailReturn: () => dispatch({ type: "CONSUME_DETAIL_RETURN" }),
      suspendForDetail: (previousDetail, originPath, originKey) => {
        const planningWorkflow = state.current ?? detailInspection?.planningWorkflow;
        if (planningWorkflow) {
          dispatch({
            type: "INSPECT",
            previousDetail,
            planningWorkflow,
            originPath,
            originKey,
          });
        }
      },
      navigateProject: () => dispatch({ type: "PROJECT_NAVIGATE" }),
      historyChanged: (key, navigationType) =>
        dispatch({ type: "HISTORY_CHANGED", key, navigationType }),
      refinementReturn: () => dispatch({ type: "REFINEMENT_RETURN" }),
      resumeFromDetail: () => dispatch({ type: "RESUME_FROM_DETAIL" }),
    }),
    [detailInspection, state],
  );
  return (
    <TaskWorkflowContext.Provider value={value}>
      {children}
    </TaskWorkflowContext.Provider>
  );
}

export function useTaskWorkflow(): TaskWorkflowContextValue {
  const ctx = useContext(TaskWorkflowContext);
  if (!ctx) throw new Error("useTaskWorkflow must be used within a TaskWorkflowProvider");
  return ctx;
}
