import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { Task, TaskStatus } from "@machbar/shared";
import { api } from "./api";
import type {
  ExternalWaitFollowUpInput,
  ExternalWaitInput,
  UpdateTaskInput,
} from "./api";
import { addIsoCalendarDays, toIsoCalendarDate } from "./naturalDate";
import {
  hasOpenDescendants,
  markOpenDescendantsTerminal,
} from "./taskHelpers";
import {
  ownerAssignmentPatch,
  setOwnerInheritance,
  updateTask,
} from "./taskMutations";
import { useRetainedMutations } from "./useRetainedMutations";
export { RETENTION_MS } from "./useRetainedMutations";
export { ownerAssignmentPatch, setOwnerInheritance } from "./taskMutations";

/** The three choices offered by the mandatory open-descendant policy prompt. */
export type ChildPolicy = "leave_open" | "complete_children" | "cancel_children";
export type PendingAction = "complete" | "cancel";
type WithoutExpectedRevision<T> = T extends unknown
  ? Omit<T, "expectedRevision">
  : never;

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
  const [pending, setPending] = useState<{ task: Task; action: PendingAction } | null>(null);
  const mutations = useRetainedMutations<Task>({ immediateRefresh: true });
  const { run, pendingIds, isPending, retained, errors, clearError } = mutations;

  const runTransition = useCallback(
    async (
      task: Task,
      optimisticTask: Task,
      job: () => Promise<Task>,
      throwOnError = false,
    ) => {
      try {
        return await run({
          id: task.id,
          optimistic: optimisticTask,
          mutate: job,
          confirmed: (confirmed) => confirmed,
          throwOnError,
        });
      } finally {
        setPending(null);
      }
    },
    [run],
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
    (task: Task) => {
      const now = new Date().toISOString();
      const optimistic: Task = {
        ...task,
        revision: task.revision + 1,
        reviewedAt: now,
      };
      return runTransition(
        task,
        optimistic,
        () => api.acknowledgeTaskReview(task.id, task.revision),
      );
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
    [complete, reopen],
  );

  /** Explicit "discard" action: asks first when there are open children. */
  const requestCancel = useCallback(
    (task: Task) => {
      if (task.status === "cancelled") return;
      if (hasOpenDescendants(task)) {
        setPending({ task, action: "cancel" });
        return;
      }
      void cancel(task);
    },
    [cancel],
  );

  const resolvePolicy = useCallback(
    (policy: ChildPolicy) => {
      if (!pending) return;
      if (pending.action === "complete") void complete(pending.task, policy);
      else void cancel(pending.task, policy);
    },
    [pending, complete, cancel],
  );

  const cancelPrompt = useCallback(() => setPending(null), []);

  return {
    release: mutations.release,
    holdingIds: mutations.holdingIds,
    pauseRetention: mutations.pauseRetention,
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
    for (const task of authoritative) {
      const overlay = context.retained.get(task.id);
      if (overlay && !context.holdingIds.has(task.id) && !context.isPending(task.id) && task.revision >= overlay.revision) context.release(task.id);
    }
  }, [authoritative, context]);
  return context;
}
