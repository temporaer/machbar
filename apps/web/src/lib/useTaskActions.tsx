import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import type { Task, TaskStatus } from "@machbar/shared";
import { api, type ExternalWaitFollowUpInput, type ExternalWaitInput, type UpdateTaskInput } from "./api";
import { toIsoCalendarDate } from "./naturalDate";
import { hasOpenDescendants } from "./taskHelpers";
import { ownerAssignmentPatch, updateTask } from "./taskMutations";
import { useItemMutations, type ItemMutationRefreshOptions } from "./useItemMutations";
import { useStrings } from "./strings";
import type { Query } from "@tanstack/react-query";
export { ownerAssignmentPatch, setOwnerInheritance } from "./taskMutations";

export type CompletionFeedbackOwner = symbol;
export type TaskFeedbackAction = "complete" | "cancel" | "reopen" | "captured" | "actionable" | "someday";
export type ChildPolicy = "leave_open" | "complete_children" | "cancel_children";
export type PendingAction = "complete" | "cancel";
export interface TaskCommandEligibility {
  id: symbol;
  active: boolean;
}
type WithoutExpectedRevision<T> = T extends unknown ? Omit<T, "expectedRevision"> : never;
const CompletionFeedbackOwnerContext = createContext<CompletionFeedbackOwner | null>(null);
const TaskCommandEligibilityContext = createContext<TaskCommandEligibility | null>(null);

export function useCompletionFeedbackOwner() {
  return useContext(CompletionFeedbackOwnerContext);
}

export function CompletionFeedbackOwnerProvider({
  owner,
  children,
}: {
  owner: CompletionFeedbackOwner | null;
  children: ReactNode;
}) {
  return (
    <CompletionFeedbackOwnerContext.Provider value={owner}>
      {children}
    </CompletionFeedbackOwnerContext.Provider>
  );
}

export function TaskCommandEligibilityProvider({
  scope,
  children,
}: {
  scope: TaskCommandEligibility | null;
  children: ReactNode;
}) {
  return (
    <TaskCommandEligibilityContext.Provider value={scope}>
      {children}
    </TaskCommandEligibilityContext.Provider>
  );
}

export function useTaskCommandEligibility() {
  return useContext(TaskCommandEligibilityContext);
}

interface CompletionFeedback {
  pendingMessage: string | ((action: TaskFeedbackAction) => string);
  refreshOptions?: (completion: CompletionCommit) => ItemMutationRefreshOptions | undefined;
  onCommitted: (completion: CompletionCommit) => void;
}
interface CompletionCommit {
  taskId: number;
  title: string;
  recurring: boolean;
  action: TaskFeedbackAction;
  inlineCompletion?: boolean;
  sourceQuery?: Query;
}

function useTaskActionsState() {
  const strings = useStrings();
  const [pending, setPending] = useState<{
    task: Task;
    action: PendingAction;
    inlineCompletion?: boolean;
    completionFeedbackOwner?: CompletionFeedbackOwner;
    commandEligibility?: TaskCommandEligibility;
  } | null>(null);
  const { run, ...feedback } = useItemMutations();
  const completionFeedback = useRef(new Map<CompletionFeedbackOwner, CompletionFeedback>());
  const registerCompletionFeedback = useCallback((owner: CompletionFeedbackOwner, observer: CompletionFeedback) => {
    const registration = { ...observer };
    completionFeedback.current.set(owner, registration);
    return () => {
      if (completionFeedback.current.get(owner) === registration) completionFeedback.current.delete(owner);
    };
  }, []);
  const runTransition = useCallback((task: Pick<Task, "id">, mutate: () => Promise<Task>, throwOnError = false) =>
    run({ id: task.id, mutate, throwOnError }), [run]);
  const runLifecycle = useCallback((
    task: Task, action: TaskFeedbackAction, mutate: () => Promise<Task>,
    completionFeedbackOwner?: CompletionFeedbackOwner,
    commandEligibility?: TaskCommandEligibility,
    throwOnError = false,
    inlineCompletion = false,
  ) => {
    if (commandEligibility && !commandEligibility.active) {
      if (throwOnError) throw new Error(strings.taskCommandUnavailable);
      return Promise.resolve(undefined);
    }
    const observer = completionFeedbackOwner
      ? completionFeedback.current.get(completionFeedbackOwner)
      : undefined;
    let committedRefreshOptions: ItemMutationRefreshOptions | undefined;
    return run({
      id: task.id, mutate, throwOnError,
      pendingMessage: typeof observer?.pendingMessage === "function"
        ? observer.pendingMessage(action) : observer?.pendingMessage,
      refreshOptions: () => {
        committedRefreshOptions = observer && completionFeedbackOwner && inlineCompletion &&
          completionFeedback.current.get(completionFeedbackOwner) === observer
          ? observer.refreshOptions?.({
          taskId: task.id, title: task.title,
          recurring: action === "complete" && task.repeatAfterDays !== null,
          action, ...(inlineCompletion ? { inlineCompletion: true } : {}),
        })
          : undefined;
        return committedRefreshOptions;
      },
      onCommitted: () => {
        if (observer && completionFeedbackOwner &&
          completionFeedback.current.get(completionFeedbackOwner) === observer) {
          observer.onCommitted({
            taskId: task.id, title: task.title,
            recurring: action === "complete" && task.repeatAfterDays !== null,
            action, ...(inlineCompletion ? { inlineCompletion: true } : {}),
            ...(committedRefreshOptions?.deferQuery ? { sourceQuery: committedRefreshOptions.deferQuery } : {}),
          });
        }
      },
    });
  }, [run, strings]);

  const complete = useCallback(async (
    task: Task,
    policy?: ChildPolicy,
    criteriaToCheck?: number[],
    throwOnError = false,
    completionFeedbackOwner?: CompletionFeedbackOwner,
    commandEligibility?: TaskCommandEligibility,
    inlineCompletion = false,
  ) => {
    return runLifecycle(task, "complete", () => api.completeTask(
        task.id, policy ?? "leave_open",
        task.repeatAfterDays !== null ? toIsoCalendarDate(new Date()) : undefined,
        task.revision, ...(criteriaToCheck !== undefined ? [criteriaToCheck] : []),
      ), completionFeedbackOwner, commandEligibility, throwOnError, inlineCompletion);
  }, [runLifecycle]);
  const cancel = useCallback((
    task: Task, policy?: ChildPolicy,
    completionFeedbackOwner?: CompletionFeedbackOwner,
    commandEligibility?: TaskCommandEligibility,
  ) => runLifecycle(task, "cancel", () =>
    api.cancelTask(task.id, policy ?? "leave_open", task.revision),
  completionFeedbackOwner, commandEligibility), [runLifecycle]);
  const reopen = useCallback((
    task: Task, completionFeedbackOwner?: CompletionFeedbackOwner,
    commandEligibility?: TaskCommandEligibility,
  ) => runLifecycle(task, "reopen", () => api.reopenTask(task.id, task.revision),
    completionFeedbackOwner, commandEligibility), [runLifecycle]);
  const transitionStatus = useCallback((
    task: Task, status: TaskStatus,
    completionFeedbackOwner?: CompletionFeedbackOwner,
    commandEligibility?: TaskCommandEligibility,
  ) => runLifecycle(task, status === "done" ? "complete" : status === "cancelled" ? "cancel" : status, () =>
    api.transitionTaskStatus(task.id, status, undefined, task.revision),
  completionFeedbackOwner, commandEligibility), [runLifecycle]);
  const setStatus = useCallback((
    task: Task, status: Extract<TaskStatus, "someday" | "actionable">,
    completionFeedbackOwner?: CompletionFeedbackOwner,
    commandEligibility?: TaskCommandEligibility,
  ) => runLifecycle(task, status, () => updateTask(task, { status }),
    completionFeedbackOwner, commandEligibility), [runLifecycle]);
  const clarify = useCallback((task: Task) =>
    runTransition(task, () => api.clarifyTask(task.id, task.revision)), [runTransition]);
  const deferClarification = useCallback((task: Task, date: string, throwOnError = false) =>
    runTransition(task, () => api.deferTaskClarification(task.id, date, task.revision), throwOnError), [runTransition]);
  const makeAction = useCallback((task: Task) =>
    runTransition(task, () => api.makeTaskAction(task.id, task.revision), true), [runTransition]);
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

  const requestToggle = useCallback((
    task: Task,
    completionFeedbackOwner?: CompletionFeedbackOwner,
    commandEligibility?: TaskCommandEligibility,
    inlineCompletion = false,
  ) => {
    if (commandEligibility && !commandEligibility.active) return;
    if (task.status === "done" || task.status === "cancelled") {
      void reopen(task, completionFeedbackOwner, commandEligibility); return;
    }
    if (hasOpenDescendants(task)) {
      setPending({
        task,
        action: "complete",
        ...(inlineCompletion ? { inlineCompletion: true } : {}),
        ...(completionFeedbackOwner ? { completionFeedbackOwner } : {}),
        ...(commandEligibility ? { commandEligibility } : {}),
      });
      return;
    }
    void complete(task, undefined, undefined, false, completionFeedbackOwner, commandEligibility, inlineCompletion);
  }, [complete, reopen]);
  const requestCancel = useCallback((
    task: Task,
    completionFeedbackOwner?: CompletionFeedbackOwner,
    commandEligibility?: TaskCommandEligibility,
  ) => {
    if (commandEligibility && !commandEligibility.active) return;
    if (task.status === "cancelled") return;
    if (hasOpenDescendants(task)) {
      setPending({
        task,
        action: "cancel",
        ...(completionFeedbackOwner ? { completionFeedbackOwner } : {}),
        ...(commandEligibility ? { commandEligibility } : {}),
      });
      return;
    }
    void cancel(task, undefined, completionFeedbackOwner, commandEligibility);
  }, [cancel]);
  const resolvePolicy = useCallback((policy: ChildPolicy, commandEligibility?: TaskCommandEligibility) => {
    if (!pending) return;
    if (pending.commandEligibility && (
      !pending.commandEligibility.active ||
      pending.commandEligibility.id !== commandEligibility?.id
    )) {
      if (!pending.commandEligibility.active) {
        setPending(current => current === pending ? null : current);
      }
      return;
    }
    setPending(null);
    if (pending.action === "complete") {
      void complete(
        pending.task,
        policy,
        undefined,
        false,
        pending.completionFeedbackOwner,
        pending.commandEligibility,
        pending.inlineCompletion ?? false,
      );
    }
    else void cancel(pending.task, policy, pending.completionFeedbackOwner, pending.commandEligibility);
  }, [pending, complete, cancel]);
  const cancelPrompt = useCallback((commandEligibility?: TaskCommandEligibility) => {
    if (pending?.commandEligibility &&
      pending.commandEligibility.id !== commandEligibility?.id) return;
    setPending(null);
  }, [pending]);
  const retirePendingDecisions = useCallback((
    commandEligibility: TaskCommandEligibility,
    taskId?: number,
  ) => setPending(current =>
    current?.commandEligibility?.id === commandEligibility.id &&
    (taskId === undefined || current.task.id === taskId)
      ? null
      : current,
  ), []);

  return {
    ...feedback,
    pendingTask: pending?.task ?? null,
    pendingAction: pending?.action ?? null,
    pendingCommandEligibilityId: pending?.commandEligibility?.id ?? null,
    requestToggle, requestCancel, setStatus, clarify, deferClarification, makeAction,
    update, appendNotes, assignOwner, setContexts, acknowledgeReview, setExternalWait,
    resolveExternalWait, followUpExternalWait, resolvePolicy, cancelPrompt, complete,
    cancel, reopen, transitionStatus, move, registerCompletionFeedback, retirePendingDecisions,
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
  const completionFeedbackOwner = useCompletionFeedbackOwner();
  const commandEligibility = useTaskCommandEligibility();
  const requestToggle = useCallback(
    (task: Task, owner?: CompletionFeedbackOwner, eligibility?: TaskCommandEligibility, inlineCompletion = false) =>
      context.requestToggle(task, owner ?? completionFeedbackOwner ?? undefined, eligibility ?? commandEligibility ?? undefined, inlineCompletion),
    [commandEligibility, completionFeedbackOwner, context],
  );
  const requestCancel = useCallback(
    (task: Task) => context.requestCancel(task, completionFeedbackOwner ?? undefined, commandEligibility ?? undefined),
    [commandEligibility, completionFeedbackOwner, context],
  );
  const complete = useCallback((
    task: Task,
    policy?: ChildPolicy,
    criteriaToCheck?: number[],
    throwOnError = false,
  ) => context.complete(
    task,
    policy,
    criteriaToCheck,
    throwOnError,
    completionFeedbackOwner ?? undefined,
    commandEligibility ?? undefined,
  ), [commandEligibility, completionFeedbackOwner, context]);
  const cancel = useCallback(
    (task: Task, policy?: ChildPolicy) => context.cancel(task, policy, completionFeedbackOwner ?? undefined, commandEligibility ?? undefined),
    [commandEligibility, completionFeedbackOwner, context],
  );
  const reopen = useCallback(
    (task: Task) => context.reopen(task, completionFeedbackOwner ?? undefined, commandEligibility ?? undefined),
    [commandEligibility, completionFeedbackOwner, context],
  );
  const transitionStatus = useCallback(
    (task: Task, status: TaskStatus) =>
      context.transitionStatus(task, status, completionFeedbackOwner ?? undefined, commandEligibility ?? undefined),
    [commandEligibility, completionFeedbackOwner, context],
  );
  const setStatus = useCallback(
    (task: Task, status: Extract<TaskStatus, "someday" | "actionable">) =>
      context.setStatus(task, status, completionFeedbackOwner ?? undefined, commandEligibility ?? undefined),
    [commandEligibility, completionFeedbackOwner, context],
  );
  const resolvePolicy = useCallback(
    (policy: ChildPolicy) => context.resolvePolicy(policy, commandEligibility ?? undefined),
    [commandEligibility, context],
  );
  const cancelPrompt = useCallback(
    () => context.cancelPrompt(commandEligibility ?? undefined),
    [commandEligibility, context],
  );
  return {
    ...context,
    requestToggle,
    requestCancel,
    complete,
    cancel,
    reopen,
    transitionStatus,
    setStatus,
    resolvePolicy,
    cancelPrompt,
  };
}
