import { createContext, useContext, useMemo, useReducer } from "react";
import type { ReactNode } from "react";
import type { TaskDetailHandoff } from "./taskDetailContext";
import type { TaskPlanningTarget } from "./commands";

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

type WorkflowState = {
  current: TaskWorkflowState | null;
  currentOpeningId: number | null;
  detail: TaskDetailHandoff | null;
  detailOpeningId: number | null;
  detailMode: "normal" | "prerequisite" | null;
  nextOpeningId: number;
};

type WorkflowEvent =
  | { type: "OPEN"; workflow: TaskWorkflowState }
  | { type: "DETAIL_OPEN"; handoff: TaskDetailHandoff; mode: "normal" | "prerequisite" }
  | { type: "DETAIL_ADVANCE_QUEUE" }
  | { type: "DETAIL_CLEAR_FOCUS" }
  | { type: "DETAIL_CLOSE" }
  | { type: "PROJECT_NAVIGATE" }
  | { type: "CLOSE" }
  | { type: "CLOSE_DETAIL" };

const initialState: WorkflowState = {
  current: null,
  currentOpeningId: null,
  detail: null,
  detailOpeningId: null,
  detailMode: null,
  nextOpeningId: 1,
};

function workflowReducer(state: WorkflowState, event: WorkflowEvent): WorkflowState {
  switch (event.type) {
    case "OPEN": {
      const openingId = state.nextOpeningId;
      return {
        ...state,
        current: event.workflow,
        currentOpeningId: openingId,
        nextOpeningId: openingId + 1,
      };
    }
    case "DETAIL_OPEN": {
      const openingId = state.nextOpeningId;
      return {
        ...state,
        detail: event.handoff,
        detailOpeningId: openingId,
        detailMode: event.mode,
        nextOpeningId: openingId + 1,
      };
    }
    case "DETAIL_ADVANCE_QUEUE": {
      if (!state.detail) return state;
      const [next, ...rest] = state.detail.queueTaskIds;
      return {
        ...state,
        detail: next === undefined
          ? null
          : { ...state.detail, taskId: next, queueTaskIds: rest, focusField: null },
        detailOpeningId: next === undefined ? null : state.detailOpeningId,
        detailMode: next === undefined ? null : state.detailMode,
      };
    }
    case "DETAIL_CLEAR_FOCUS":
      return state.detail
        ? { ...state, detail: { ...state.detail, focusField: null } }
        : state;
    case "DETAIL_CLOSE":
    case "CLOSE_DETAIL":
      return { ...state, detail: null, detailOpeningId: null, detailMode: null };
    case "PROJECT_NAVIGATE":
      return {
        ...state,
        current: null,
        currentOpeningId: null,
        detail: null,
        detailOpeningId: null,
        detailMode: null,
      };
    case "CLOSE": {
      const restored = state.current?.originDetail ?? null;
      return {
        ...state,
        current: null,
        currentOpeningId: null,
        detail: restored,
        detailOpeningId: restored?.openingId ?? null,
        detailMode: restored ? "normal" : null,
      };
    }
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
  detail: TaskDetailHandoff | null;
  detailOpeningId: number | null;
  detailMode: "normal" | "prerequisite" | null;
  openDetail: (handoff: TaskDetailHandoff) => void;
  inspectDetail: (handoff: TaskDetailHandoff) => void;
  advanceDetailQueue: () => void;
  closeDetailDirectly: () => void;
  clearDetailFocus: () => void;
  getDetailHandoff: () => TaskDetailHandoff | null;
  detailVisible: boolean;
  detailSuspended: boolean;
  navigateProject: () => void;
  historyChanged: () => void;
}

const TaskWorkflowContext = createContext<TaskWorkflowContextValue | null>(null);

export function TaskWorkflowProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(workflowReducer, initialState);
  const detailVisible = state.detail !== null;
  const value = useMemo<TaskWorkflowContextValue>(
    () => ({
      current: state.current,
      currentOpeningId: state.currentOpeningId,
      detail: state.detail,
      detailOpeningId: state.detailOpeningId,
      detailMode: state.detailMode,
      detailVisible,
      detailSuspended: false,
      open: (kind, taskId, planningTarget, originDetail) => dispatch({
        type: "OPEN",
        workflow: {
          kind,
          taskId,
          ...(planningTarget ? { planningTarget } : {}),
          ...(originDetail !== undefined ? { originDetail } : {}),
        },
      }),
      close: () => dispatch({ type: "CLOSE" }),
      closeDetail: () => dispatch({ type: "CLOSE_DETAIL" }),
      openDetail: (handoff) => dispatch({ type: "DETAIL_OPEN", handoff, mode: "normal" }),
      inspectDetail: (handoff) => dispatch({ type: "DETAIL_OPEN", handoff, mode: "prerequisite" }),
      advanceDetailQueue: () => dispatch({ type: "DETAIL_ADVANCE_QUEUE" }),
      closeDetailDirectly: () => dispatch({ type: "DETAIL_CLOSE" }),
      clearDetailFocus: () => dispatch({ type: "DETAIL_CLEAR_FOCUS" }),
      getDetailHandoff: () => state.detail,
      navigateProject: () => dispatch({ type: "PROJECT_NAVIGATE" }),
      historyChanged: () => dispatch({ type: "PROJECT_NAVIGATE" }),
    }),
    [detailVisible, state],
  );
  return <TaskWorkflowContext.Provider value={value}>{children}</TaskWorkflowContext.Provider>;
}

export function useTaskWorkflow(): TaskWorkflowContextValue {
  const ctx = useContext(TaskWorkflowContext);
  if (!ctx) throw new Error("useTaskWorkflow must be used within a TaskWorkflowProvider");
  return ctx;
}

export function useOptionalTaskWorkflow(): TaskWorkflowContextValue | null {
  return useContext(TaskWorkflowContext);
}
