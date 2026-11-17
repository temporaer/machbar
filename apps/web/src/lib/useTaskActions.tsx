import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import type { Task, TaskStatus } from "@machbar/shared";
import { api, type ExternalWaitFollowUpInput, type ExternalWaitInput, type UpdateTaskInput } from "./api";
import { toIsoCalendarDate } from "./naturalDate";
import { hasOpenDescendants } from "./taskHelpers";
import { ownerAssignmentPatch, updateTask } from "./taskMutations";
import { useItemMutations } from "./useItemMutations";
export { ownerAssignmentPatch, setOwnerInheritance } from "./taskMutations";

export type ChildPolicy = "leave_open" | "complete_children" | "cancel_children";
export type PendingAction = "complete" | "cancel";
export interface TaskTransitionFeedbackEvent {
  taskId: number;
  targetStatus: TaskStatus;
  occurrence: boolean;
  phase: "pending" | "success" | "failure";
  sourceRevision: number;
  resultStatus?: TaskStatus;
  resultRevision?: number;
}
type TaskTransitionFeedbackListener = (event: TaskTransitionFeedbackEvent) => void;
type WithoutExpectedRevision<T> = T extends unknown ? Omit<T, "expectedRevision"> : never;

function useTaskActionsState() {
  const [pending, setPending] = useState<{ task: Task; action: PendingAction } | null>(null);
  const { run, ...feedback } = useItemMutations();
  const transitionListeners = useRef(new Set<TaskTransitionFeedbackListener>());
  const subscribeTransitionFeedback = useCallback((listener: TaskTransitionFeedbackListener) => {
    transitionListeners.current.add(listener);
    return () => { transitionListeners.current.delete(listener); };
  }, []);
  const publishTransitionFeedback = useCallback((event: TaskTransitionFeedbackEvent) => {
    for (const listener of transitionListeners.current) {
      try { listener(event); } catch { /* presentation feedback cannot change a command result */ }
    }
  }, []);
  const runTransition = useCallback((
    task: Pick<Task, "id"> & Partial<Pick<Task, "revision">>,
    mutate: () => Promise<Task>,
    throwOnError = false,
    transition?: { targetStatus: TaskStatus; occurrence?: boolean },
  ) => run({
    id: task.id,
    mutate,
    throwOnError,
    ...(transition ? {
      onStart: () => publishTransitionFeedback({
        taskId: task.id,
        targetStatus: transition.targetStatus,
        occurrence: transition.occurrence ?? false,
        phase: "pending",
        sourceRevision: task.revision ?? 0,
      }),
      onSuccess: (result: Task) => publishTransitionFeedback({
        taskId: task.id,
        targetStatus: transition.targetStatus,
        occurrence: transition.occurrence ?? false,
        phase: "success",
        sourceRevision: task.revision ?? 0,
        resultStatus: result.status,
        resultRevision: result.revision,
      }),
      onError: () => publishTransitionFeedback({
        taskId: task.id,
        targetStatus: transition.targetStatus,
        occurrence: transition.occurrence ?? false,
        phase: "failure",
        sourceRevision: task.revision ?? 0,
      }),
    } : {}),
  }), [publishTransitionFeedback, run]);

  const complete = useCallback((task: Task, policy?: ChildPolicy, criteriaToCheck?: number[], throwOnError = false) =>
    runTransition(task, () => api.completeTask(
      task.id, policy ?? "leave_open",
      task.repeatAfterDays !== null ? toIsoCalendarDate(new Date()) : undefined,
      task.revision, ...(criteriaToCheck !== undefined ? [criteriaToCheck] : []),
    ), throwOnError, {
      targetStatus: task.repeatAfterDays !== null ? "actionable" : "done",
      occurrence: task.repeatAfterDays !== null,
    }), [runTransition]);
  const cancel = useCallback((task: Task, policy?: ChildPolicy) =>
    runTransition(task, () => api.cancelTask(task.id, policy ?? "leave_open", task.revision), false, { targetStatus: "cancelled" }), [runTransition]);
  const reopen = useCallback((task: Task) =>
    runTransition(task, () => api.reopenTask(task.id, task.revision), false, { targetStatus: "actionable" }), [runTransition]);
  const transitionStatus = useCallback((task: Task, status: TaskStatus) =>
    runTransition(task, () => api.transitionTaskStatus(task.id, status, undefined, task.revision), false, { targetStatus: status }), [runTransition]);
  const setStatus = useCallback((task: Task, status: Extract<TaskStatus, "someday" | "actionable">) =>
    runTransition(task, () => updateTask(task, { status }), false, { targetStatus: status }), [runTransition]);
  const clarify = useCallback((task: Task) =>
    runTransition(task, () => api.clarifyTask(task.id, task.revision), false, task.status === "captured" ? { targetStatus: "actionable" } : undefined), [runTransition]);
  const deferClarification = useCallback((task: Task, date: string, throwOnError = false) =>
    runTransition(task, () => api.deferTaskClarification(task.id, date, task.revision), throwOnError), [runTransition]);
  const makeAction = useCallback((task: Task) =>
    runTransition(task, () => api.makeTaskAction(task.id, task.revision), true, { targetStatus: "actionable" }), [runTransition]);
  const move = useCallback((task: Pick<Task, "id">, input: Parameters<typeof api.moveTask>[1]) =>
    runTransition(task, () => api.moveTask(task.id, input), true), [runTransition]);
  const update = useCallback((task: Pick<Task, "id" | "revision">, patch: UpdateTaskInput, throwOnError = false) =>
    runTransition(task, () => updateTask(task, patch), throwOnError), [runTransition]);
  const appendNotes = useCallback((task: Task, content: string) =>
    runTransition(task, () => api.appendTaskNotes(task.id, content), true), [runTransition]);
  const assignOwner = useCallback((
    task: Task, ownerMemberId: number | null,
    ownerInheritanceMode: Task["ownerInheritanceMode"] = ownerMemberId === null ? "none" : "explicit",
    companionPatch: Pick<UpdateTaskInput, "title"> = {},
  ) => update(task, { ...ownerAssignmentPatch(ownerMemberId, ownerInheritanceMode), ...companionPatch }, true), [update]);
  const setContexts = useCallback((
    task: Task, contextInheritanceMode: Task["contextInheritanceMode"], contextIds: number[],
    companionPatch: Pick<UpdateTaskInput, "title"> = {},
  ) => update(task, { contextInheritanceMode, contextIds, ...companionPatch }, true), [update]);
  const acknowledgeReview = useCallback((task: Task) =>
    runTransition(task, () => api.acknowledgeTaskReview(task.id, task.revision)), [runTransition]);
  const setExternalWait = useCallback((
    task: Pick<Task, "id" | "revision">, input: Omit<ExternalWaitInput, "expectedRevision">,
    options: { throwOnError?: boolean } = {},
  ) => runTransition(task, () => api.setExternalWait(task.id, { ...input, expectedRevision: task.revision }), options.throwOnError), [runTransition]);
  const resolveExternalWait = useCallback((task: Pick<Task, "id" | "revision">) =>
    runTransition(task, () => api.resolveExternalWait(task.id, task.revision)), [runTransition]);
  const followUpExternalWait = useCallback((
    task: Task, input: WithoutExpectedRevision<ExternalWaitFollowUpInput>, options: { throwOnError?: boolean } = {},
  ) => runTransition(task, () => api.followUpExternalWait(task.id, { ...input, expectedRevision: task.revision }), options.throwOnError), [runTransition]);

  const requestToggle = useCallback((task: Task) => {
    if (task.status === "done" || task.status === "cancelled") { void reopen(task); return; }
    if (hasOpenDescendants(task)) { setPending({ task, action: "complete" }); return; }
    void complete(task);
  }, [complete, reopen]);
  const requestCancel = useCallback((task: Task) => {
    if (task.status === "cancelled") return;
    if (hasOpenDescendants(task)) { setPending({ task, action: "cancel" }); return; }
    void cancel(task);
  }, [cancel]);
  const resolvePolicy = useCallback((policy: ChildPolicy) => {
    if (!pending) return;
    setPending(null);
    if (pending.action === "complete") void complete(pending.task, policy);
    else void cancel(pending.task, policy);
  }, [pending, complete, cancel]);
  const cancelPrompt = useCallback(() => setPending(null), []);

  return {
    ...feedback, pendingTask: pending?.task ?? null, pendingAction: pending?.action ?? null,
    subscribeTransitionFeedback,
    requestToggle, requestCancel, setStatus, clarify, deferClarification, makeAction,
    update, appendNotes, assignOwner, setContexts, acknowledgeReview, setExternalWait,
    resolveExternalWait, followUpExternalWait, resolvePolicy, cancelPrompt, complete,
    cancel, reopen, transitionStatus, move,
  };
}

type TaskActionsValue = ReturnType<typeof useTaskActionsState>;
const TaskActionsContext = createContext<TaskActionsValue | null>(null);
export function TaskActionsProvider({ children }: { children: ReactNode }) {
  const value = useTaskActionsState();
  return <TaskActionsContext.Provider value={value}>{children}</TaskActionsContext.Provider>;
}
export function useTaskActions(): TaskActionsValue {
  const context = useContext(TaskActionsContext);
  if (!context) throw new Error("useTaskActions must be used within a TaskActionsProvider");
  return context;
}
