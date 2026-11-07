import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Task, TaskStatus } from "@machbar/shared";
import { api } from "./api";
import type {
  ExternalWaitFollowUpInput,
  ExternalWaitInput,
  TaskDetail,
  UpdateTaskInput,
} from "./api";
import { addIsoCalendarDays, toIsoCalendarDate } from "./naturalDate";
import {
  flattenTasks,
  indexTaskDescendants,
  projectTaskValue,
  hasOpenDescendants,
  markOpenDescendantsTerminal,
} from "./taskHelpers";
import {
  ownerAssignmentPatch,
  setOwnerInheritance,
  updateTask,
} from "./taskMutations";
import { useRetainedMutations, type TargetReadToken, type TargetRead } from "./useRetainedMutations";
import { isWorkItemAccessError } from "./errorMessage";
import { useStrings } from "./strings";
import { useIdentityScope } from "./identity";
export { RETENTION_MS } from "./useRetainedMutations";
export { ownerAssignmentPatch, setOwnerInheritance } from "./taskMutations";

/** The three choices offered by the mandatory open-descendant policy prompt. */
export type ChildPolicy = "leave_open" | "complete_children" | "cancel_children";
export type PendingAction = "complete" | "cancel";
type WithoutExpectedRevision<T> = T extends unknown
  ? Omit<T, "expectedRevision">
  : never;

const taskReceiptRevision = (task: Task) => task.revision;

/**
 * Centralises the complete/reopen/cancel/quick-status flow, including the
 * mandatory open-descendant policy prompt and the "recently mutated tasks
 * stay put" retention behaviour required for mobile swipe actions.
 *
 * Complete and cancel accept every descendant policy and apply the parent
 * transition plus descendant outcomes in one backend transaction.
 *
 * Retention holds list placement independently from the optimistic/confirmed
 * state. Successful writes refresh immediately; lists preserve their own
 * observed rows while holdingIds contains them. Confirmed overlays outlive
 * display retention so late reads cannot restore stale values.
 *
 * This is the underlying state/logic; it is instantiated exactly once by
 * `TaskActionsProvider` below so every consumer (row, detail sheet, review,
 * waiting, quick-add, …) shares one optimistic/pending/error state instead
 * of each owning an independent copy. Call `useTaskActions()` to consume it.
 */
function useTaskActionsState() {
  const strings = useStrings();
  const identityKey = useIdentityScope();
  const [pending, setPending] = useState<{ task: Task; action: PendingAction } | null>(null);
  const [acknowledgedReviewIds, setAcknowledgedReviewIds] = useState<Set<number>>(new Set());
  const mutations = useRetainedMutations<Task>({ immediateRefresh: true, identityKey, receiptRevision: taskReceiptRevision });
  const scope = useRef(mutations.scopeToken);
  if (scope.current !== mutations.scopeToken) {
    scope.current = mutations.scopeToken;
    if (pending !== null) setPending(null);
    if (acknowledgedReviewIds.size > 0) setAcknowledgedReviewIds(new Set());
  }
  const { run, pendingIds, isPending, retained, errors, clearError } = mutations;
  const projectTask = useCallback((task: Task) => projectTaskValue(
    projectTaskValue(task, mutations.getConfirmed(task.id)), retained.get(task.id), isPending(task.id),
  ), [mutations.getConfirmed, mutations.confirmedSnapshots, retained, isPending]);
  useEffect(() => {
    setAcknowledgedReviewIds(current => {
      const next = new Set([...current].filter(id => mutations.holdingIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [mutations.holdingIds]);
  // Placement can preserve a subtree that a confirmed response no longer
  // contains. Remember its original ownership through the display lifetime.
  const placementDescendants = useRef(new Map<number, Set<number>>());
  const observedDescendants = useRef(new Map<number, Set<number>>());
  const liveState = useRef({ holding: mutations.holdingIds, pending: pendingIds });
  liveState.current = { holding: mutations.holdingIds, pending: pendingIds };
  const interactions = useRef(new Set<{ id: number; leases: Map<number, () => void> }>());
  const relationScope = useRef(mutations.scopeToken);
  if (relationScope.current !== mutations.scopeToken) {
    relationScope.current = mutations.scopeToken;
    placementDescendants.current.clear();
    observedDescendants.current.clear();
    interactions.current.clear();
  }
  const observeConfirmedTask = useCallback((task: Task, read?: TargetReadToken) =>
    mutations.observeConfirmed(task.id, task, task, read), [mutations.observeConfirmed]);
  const readTask = useCallback(async (id: number): Promise<TargetRead<TaskDetail>> => {
    const read = mutations.captureTargetRead(id);
    try {
      const value = await api.getTask(id);
      mutations.trackTargetRead(read, value);
      return { read, value };
    } catch (cause) {
      if (!mutations.isCurrentTargetRead(read)) throw new Error(strings.workflowTargetUnavailable);
      if (isWorkItemAccessError(cause)) mutations.invalidateConfirmed(id, read);
      throw cause;
    }
  }, [mutations.captureTargetRead, mutations.invalidateConfirmed, mutations.trackTargetRead, mutations.isCurrentTargetRead, strings]);
  const getTask = useCallback(async (id: number) => {
    const result = await readTask(id);
    if (!mutations.isCurrentTargetRead(result.read)) throw new Error(strings.workflowTargetUnavailable);
    return result.value;
  }, [readTask, mutations.isCurrentTargetRead, strings]);
  const syncInteractions = useCallback(() => {
    if (!mutations.isCurrentScope(mutations.scopeToken)) return;
    for (const interaction of interactions.current) {
      const owners = new Set([interaction.id]);
      for (const [owner, descendants] of placementDescendants.current) {
        if (descendants.has(interaction.id)) owners.add(owner);
        if (owner === interaction.id) {
          for (const child of descendants) if (liveState.current.holding.has(child)) owners.add(child);
        }
      }
      for (const owner of owners) {
        if (!interaction.leases.has(owner)) interaction.leases.set(owner, mutations.pauseRetention(owner));
      }
    }
  }, [mutations.pauseRetention, mutations.isCurrentScope, mutations.scopeToken]);
  const observeTasks = useCallback((tasks: readonly Task[]) => {
    if (!mutations.isCurrentScope(mutations.scopeToken)) return;
    for (const [id, descendants] of indexTaskDescendants(tasks)) {
      observedDescendants.current.set(id, descendants);
      const previous = placementDescendants.current.get(id);
      const { holding, pending } = liveState.current;
      if (holding.has(id) || pending.has(id) || [...(previous ?? []), ...descendants].some(child => holding.has(child) || pending.has(child))) {
        placementDescendants.current.set(id, new Set([...(previous ?? []), ...descendants]));
      }
    }
    // Existing interactions acquire new owners too, without dropping the old
    // paths that still keep their displayed row mounted.
    syncInteractions();
  }, [syncInteractions, mutations.isCurrentScope, mutations.scopeToken]);
  useEffect(() => {
    for (const [id, descendants] of placementDescendants.current) {
      if (![id, ...descendants].some(candidate => mutations.holdingIds.has(candidate) || pendingIds.has(candidate))) placementDescendants.current.delete(id);
    }
  }, [mutations.holdingIds, pendingIds]);
  useLayoutEffect(syncInteractions, [syncInteractions, mutations.holdingIds, pendingIds]);
  const pauseRetention = useCallback((id: number) => {
    if (!mutations.isCurrentScope(mutations.scopeToken)) return () => {};
    const interaction = { id, leases: new Map<number, () => void>() };
    interactions.current.add(interaction);
    syncInteractions();
    return () => {
      if (!interactions.current.delete(interaction)) return;
      interaction.leases.forEach(close => close());
    };
  }, [syncInteractions, mutations.isCurrentScope, mutations.scopeToken]);
  useEffect(() => {
    if (pending) return pauseRetention(pending.task.id);
  }, [pending, pauseRetention]);

  const runTransition = useCallback(
    async (
      task: Task,
      optimisticTask: Task,
      job: () => Promise<Task>,
      throwOnError = false,
    ) => {
      const token = mutations.scopeToken;
      if (!mutations.isCurrentScope(token)) return undefined;
      for (const [ancestor, descendants] of observedDescendants.current) {
        if (descendants.has(task.id)) {
          placementDescendants.current.set(ancestor, new Set([...(placementDescendants.current.get(ancestor) ?? []), ...descendants]));
        }
      }
      placementDescendants.current.set(task.id, new Set([...(placementDescendants.current.get(task.id) ?? []), ...flattenTasks(task.children ?? []).map(child => child.id)]));
      try {
        return await run({
          id: task.id,
          optimistic: optimisticTask,
          mutate: job,
          confirmed: (confirmed) => confirmed,
          throwOnError,
        });
      } finally {
        if (mutations.isCurrentScope(token)) setPending(null);
      }
    },
    [run, mutations.scopeToken, mutations.isCurrentScope],
  );

  const complete = useCallback(
    (task: Task, policy?: ChildPolicy, criteriaToCheck?: number[], throwOnError = false) => {
      const now = new Date().toISOString();
      const completedOn = toIsoCalendarDate(new Date());
      // Whichever policy closes the open descendants (matching or the mixed
      // "cancel children while completing the parent" case), fold that same
      // outcome into the optimistic snapshot's `children`, recursively, so
      // the whole retained subtree reflects its post-mutation state instead
      // of just the parent row.
      const descendantStatus: Extract<TaskStatus, "done" | "cancelled"> | null =
        policy === "complete_children" ? "done" : policy === "cancel_children" ? "cancelled" : null;
      const optimistic: Task =
        task.repeatAfterDays !== null &&
        task.allowedDeviationDays !== null
          ? {
              ...task,
              revision: task.revision + 1,
              status: "actionable",
              completedAt: null,
              cancelledAt: null,
              scheduledDate: addIsoCalendarDays(
                completedOn,
                task.repeatAfterDays,
              ),
              dueDate: addIsoCalendarDays(
                addIsoCalendarDays(completedOn, task.repeatAfterDays),
                task.allowedDeviationDays,
              ),
            }
          : {
              ...task,
              revision: task.revision + 1,
              status: "done",
              completedAt: now,
              cancelledAt: null,
              children: descendantStatus
                ? markOpenDescendantsTerminal(
                    task.children,
                    descendantStatus,
                    now,
                  )
                : task.children,
            };
      return runTransition(task, optimistic, () =>
        api.completeTask(
          task.id,
          policy ?? "leave_open",
          task.repeatAfterDays !== null ? completedOn : undefined,
          task.revision,
          ...(criteriaToCheck !== undefined ? [criteriaToCheck] : []),
        ), throwOnError,
      );
    },
    [runTransition],
  );

  const cancel = useCallback(
    (task: Task, policy?: ChildPolicy) => {
      const now = new Date().toISOString();
      const descendantStatus: Extract<TaskStatus, "done" | "cancelled"> | null =
        policy === "cancel_children" ? "cancelled" : policy === "complete_children" ? "done" : null;
      const optimistic: Task = {
        ...task,
        revision: task.revision + 1,
        status: "cancelled",
        cancelledAt: now,
        completedAt: null,
        children: descendantStatus ? markOpenDescendantsTerminal(task.children, descendantStatus, now) : task.children,
      };
      return runTransition(task, optimistic, () =>
        api.cancelTask(task.id, policy ?? "leave_open", task.revision),
      );
    },
    [runTransition],
  );

  const reopen = useCallback(
    (task: Task) => {
      const optimistic: Task = {
        ...task,
        revision: task.revision + 1,
        status: "actionable",
        needsClarification: task.needsClarification,
        completedAt: null,
        cancelledAt: null,
      };
      return runTransition(task, optimistic, () => api.reopenTask(task.id, task.revision));
    },
    [runTransition],
  );

  const transitionStatus = useCallback(
    (task: Task, status: TaskStatus) => {
      const now = new Date().toISOString();
      const optimistic: Task = {
        ...task,
        revision: task.revision + 1,
        status,
        needsClarification: status === "captured" ? true : task.needsClarification,
        completedAt: status === "done" ? now : null,
        cancelledAt: status === "cancelled" ? now : null,
      };
      return runTransition(task, optimistic, () =>
        api.transitionTaskStatus(task.id, status, undefined, task.revision),
      );
    },
    [runTransition],
  );

  /** Quick, prompt-free status change (used by the "Warten" swipe chip / config). Never terminal. */
  const setStatus = useCallback(
    (task: Task, status: Extract<TaskStatus, "someday" | "actionable">) => {
      const optimistic: Task = {
        ...task,
        revision: task.revision + 1,
        status,
        needsClarification: status === "actionable" && task.status === "captured" ? false : task.needsClarification,
        completedAt: null,
        cancelledAt: null,
      };
      return runTransition(task, optimistic, () =>
        updateTask(task, { status }),
      );
    },
    [runTransition],
  );

  /** Resolve clarification without demoting any existing commitment. */
  const clarify = useCallback(
    (task: Task) => {
      const optimistic: Task = {
        ...task,
        revision: task.revision + 1,
        status: task.status === "captured" ? "actionable" : task.status,
        needsClarification: false,
        clarificationRevisitDate: null,
        updatedAt: new Date().toISOString(),
      };
      return runTransition(task, optimistic, () =>
        api.clarifyTask(task.id, task.revision),
      );
    },
    [runTransition],
  );

  const deferClarification = useCallback(
    (task: Task, date: string, throwOnError = false) => {
      const optimistic: Task = {
        ...task,
        revision: task.revision + 1,
        clarificationRevisitDate: date,
        updatedAt: new Date().toISOString(),
      };
      return runTransition(
        task,
        optimistic,
        () => api.deferTaskClarification(task.id, date, task.revision),
        throwOnError,
      );
    },
    [runTransition],
  );

  /**
   * Promotes a `kind: "reference"` outline node to a real `kind: "action"`
   * task in place (same id/title/notes/parent/project/position/children).
   * No optimistic snapshot: this is a deliberate, infrequent action, and
   * the promoted row needs its full action-only affordances (status,
   * scheduling, …) as soon as the server confirms, so an immediate refresh
   * is simpler and safer than reconstructing that projection client-side.
   */
  const makeAction = useCallback(
    (task: Task) =>
      run({
        id: task.id,
        mutate: () => api.makeTaskAction(task.id, task.revision),
        confirmed: task => task,
        retain: false,
        refreshImmediately: true,
        throwOnError: true,
      }),
    [run],
  );

  /**
   * Applies a focused metadata edit while retaining the row in its current
   * view. This gives quick sheets the same stable, optimistic UX as status
   * swipes without opening the full task editor.
   */
  const update = useCallback(
    (
      task: Task,
      patch: UpdateTaskInput,
      // `patch.reminders` (if present) may contain not-yet-created entries
      // without an `id`; the server assigns real ids on commit, so the
      // optimistic snapshot fills in placeholder ones. This is cosmetic:
      // the snapshot is only shown for the brief retention window before
      // the authoritative refetch replaces it.
      optimisticPatch: Partial<Task> = (() => {
        const { externalWait, reminders, ...rest } = patch;
        return {
          ...rest,
          ...(externalWait !== undefined
            ? {
                externalWait:
                  externalWait === null
                    ? null
                    : {
                        waitingFor: externalWait.waitingFor ?? null,
                        revisitDate: externalWait.revisitDate ?? null,
                      },
              }
            : {}),
          ...(reminders
            ? {
                reminders: reminders.map((r, i) => ({
                  ...r,
                  id: r.id ?? -1 - i,
                })),
              }
            : {}),
        };
      })(),
      throwOnError = false,
    ) => {
      const optimistic: Task = {
        ...task,
        ...optimisticPatch,
        revision: task.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      return runTransition(
        task,
        optimistic,
        () =>
          updateTask(task, patch),
        throwOnError,
      );
    },
    [runTransition],
  );

  const appendNotes = useCallback((task: Task, content: string) =>
    runTransition(task, task, () => api.appendTaskNotes(task.id, content), true), [runTransition]);

  const assignOwner = useCallback(
    (
      task: Task,
      ownerMemberId: number | null,
      ownerInheritanceMode: Task["ownerInheritanceMode"] =
        ownerMemberId === null ? "none" : "explicit",
      companionPatch: Pick<UpdateTaskInput, "title"> = {},
    ) => {
      const patch = {
        ...ownerAssignmentPatch(ownerMemberId, ownerInheritanceMode),
        ...companionPatch,
      };
      const effectiveOwnerSource =
        ownerInheritanceMode === "inherit"
          ? task.effectiveOwnerSource
          : ownerMemberId === null
            ? "none"
            : "task";
      const effectiveOwnerId =
        ownerInheritanceMode === "inherit" ? task.effectiveOwnerId : ownerMemberId;
      return update(
        task,
        patch,
        {
          ...patch,
          effectiveOwnerId,
          effectiveOwnerSource,
        },
        true,
      );
    },
    [update],
  );

  const setContexts = useCallback(
    (
      task: Task,
      contextInheritanceMode: Task["contextInheritanceMode"],
      contextIds: number[],
      companionPatch: Pick<UpdateTaskInput, "title"> = {},
    ) =>
      update(
        task,
        { contextInheritanceMode, contextIds, ...companionPatch },
        { contextInheritanceMode, ...companionPatch },
        true,
      ),
    [update],
  );

  const acknowledgeReview = useCallback(
    async (task: Task) => {
      const now = new Date().toISOString();
      const optimistic: Task = {
        ...task,
        revision: task.revision + 1,
        reviewedAt: now,
      };
      const result = await runTransition(
        task,
        optimistic,
        () => api.acknowledgeTaskReview(task.id, task.revision),
      );
      if (result) setAcknowledgedReviewIds(current => new Set(current).add(task.id));
      return result;
    },
    [runTransition],
  );

  const runExternalWaitCommand = useCallback(
    (
      task: Pick<Task, "id">,
      mutate: () => Promise<Task>,
      throwOnError = false,
    ) =>
      run({
        id: task.id,
        mutate,
        confirmed: task => task,
        retain: false,
        throwOnError,
      }),
    [run],
  );

  const setExternalWait = useCallback(
    (
      task: Pick<Task, "id" | "revision">,
      input: Omit<ExternalWaitInput, "expectedRevision">,
      options: { throwOnError?: boolean } = {},
    ) =>
      runExternalWaitCommand(task, () =>
        api.setExternalWait(task.id, {
          ...input,
          expectedRevision: task.revision,
        }),
        options.throwOnError === true,
      ),
    [runExternalWaitCommand],
  );

  const resolveExternalWait = useCallback(
    (task: Pick<Task, "id" | "revision">) =>
      runExternalWaitCommand(task, () =>
        api.resolveExternalWait(task.id, task.revision),
      ),
    [runExternalWaitCommand],
  );

  const followUpExternalWait = useCallback(
    (
      task: Task,
      input: WithoutExpectedRevision<ExternalWaitFollowUpInput>,
      options: { throwOnError?: boolean } = {},
    ) =>
      runExternalWaitCommand(task, () =>
        api.followUpExternalWait(task.id, {
          ...input,
          expectedRevision: task.revision,
        }),
        options.throwOnError === true,
      ),
    [runExternalWaitCommand],
  );

  /** Toggle from a checkbox: asks first when there are open children. */
  const requestToggle = useCallback(
    (task: Task) => {
      if (!mutations.isCurrentScope(mutations.scopeToken)) return;
      if (task.status === "done" || task.status === "cancelled") {
        void reopen(task);
        return;
      }
      if (hasOpenDescendants(task)) {
        setPending({ task, action: "complete" });
        return;
      }
      void complete(task);
    },
    [complete, reopen, mutations.isCurrentScope, mutations.scopeToken],
  );

  /** Explicit "discard" action: asks first when there are open children. */
  const requestCancel = useCallback(
    (task: Task) => {
      if (!mutations.isCurrentScope(mutations.scopeToken)) return;
      if (task.status === "cancelled") return;
      if (hasOpenDescendants(task)) {
        setPending({ task, action: "cancel" });
        return;
      }
      void cancel(task);
    },
    [cancel, mutations.isCurrentScope, mutations.scopeToken],
  );

  const resolvePolicy = useCallback(
    (policy: ChildPolicy) => {
      if (!pending) return;
      if (pending.action === "complete") void complete(pending.task, policy);
      else void cancel(pending.task, policy);
    },
    [pending, complete, cancel],
  );

  const cancelPrompt = useCallback(() => {
    if (mutations.isCurrentScope(mutations.scopeToken)) setPending(null);
  }, [mutations.isCurrentScope, mutations.scopeToken]);

  return {
    observeTasks,
    observeConfirmedTask,
    readTask,
    getTask,
    captureTargetRead: mutations.captureTargetRead,
    isCurrentTargetRead: mutations.isCurrentTargetRead,
    isCurrentTaskRead: mutations.isCurrentTargetValue,
    isTargetReadable: mutations.isTargetReadable,
    getConfirmedTask: mutations.getConfirmed,
    invalidateConfirmedTask: mutations.invalidateConfirmed,
    scopeToken: mutations.scopeToken,
    isCurrentScope: mutations.isCurrentScope,
    projectTask,
    acknowledgedReviewIds,
    release: mutations.release,
    holdingIds: mutations.holdingIds,
    pauseRetention,
    pendingTask: pending?.task ?? null,
    pendingAction: pending?.action ?? null,
    pendingIds,
    isPending,
    retained,
    errors,
    clearError,
    requestToggle,
    requestCancel,
    setStatus,
    clarify,
    deferClarification,
    makeAction,
    update,
    appendNotes,
    assignOwner,
    setContexts,
    acknowledgeReview,
    setExternalWait,
    resolveExternalWait,
    followUpExternalWait,
    resolvePolicy,
    cancelPrompt,
    complete,
    cancel,
    reopen,
    transitionStatus,
  };
}

type TaskActionsValue = ReturnType<typeof useTaskActionsState>;

const TaskActionsContext = createContext<TaskActionsValue | null>(null);

/**
 * Mounts the single shared `useTaskActionsState()` instance for the whole
 * app (see `App.tsx`) so every consumer reads and mutates the same
 * pending/retained/error state — a swipe in `TaskOutline`, an edit in
 * `TaskDetailSheet`, and a click in `ReviewPage` all observe each other's
 * in-flight/retained tasks instead of keeping independent, inconsistent
 * copies. Test files use `renderWithProviders`, which mounts this too.
 */
export function TaskActionsProvider({ children }: { children: ReactNode }) {
  const value = useTaskActionsState();
  return <TaskActionsContext.Provider value={value}>{children}</TaskActionsContext.Provider>;
}

/** Consumes the shared task action controller mounted by `TaskActionsProvider`. */
export function useTaskActions(authoritative: readonly Task[] = []): TaskActionsValue {
  const context = useContext(TaskActionsContext);
  if (!context) {
    throw new Error("useTaskActions must be used within a TaskActionsProvider");
  }
  useEffect(() => {
    context.observeTasks(authoritative);
    for (const task of authoritative) {
      const overlay = context.retained.get(task.id);
      if (overlay && !context.holdingIds.has(task.id) && !context.isPending(task.id) && task.revision >= overlay.revision) context.release(task.id);
    }
  }, [authoritative, context]);
  return context;
}
