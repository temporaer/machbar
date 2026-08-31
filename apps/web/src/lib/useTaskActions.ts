import { useCallback, useState } from "react";
import type { Task, TaskStatus } from "@machbar/shared";
import { api } from "./api";
import type {
  ExternalWaitFollowUpInput,
  ExternalWaitInput,
  UpdateTaskInput,
} from "./api";
import { hasOpenDescendants } from "./taskHelpers";
import type { PrimarySwipeAction } from "./swipeSettings";
import {
  ownerAssignmentPatch,
  updateTask,
} from "./taskMutations";
import { useRetainedMutations } from "./useRetainedMutations";
export { RETENTION_MS } from "./useRetainedMutations";
export { ownerAssignmentPatch } from "./taskMutations";

/** The three choices offered by the mandatory open-descendant policy prompt. */
export type ChildPolicy = "leave_open" | "complete_children" | "cancel_children";
export type PendingAction = "complete" | "cancel";
type WithoutExpectedRevision<T> = T extends unknown
  ? Omit<T, "expectedRevision">
  : never;

/**
 * How long a task that just left its compiled view (completed, cancelled,
 * or otherwise transitioned to a status the current list no longer shows)
 * keeps rendering in place with its optimistic status before the retained
 * override is dropped. Kept mid-range of the "about 3-5 seconds" requirement.
 */
function localCalendarDate(date = new Date()): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function addCalendarDays(value: string, days: number): string {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day! + days));
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

/**
 * Recursively marks every *open* descendant with the given terminal status,
 * mirroring the backend's `openDescendants` (which walks the whole subtree,
 * not just direct children, and keeps walking past an already-closed node in
 * case a deeper descendant is still open). Without this, a parent's optimistic
 * retention snapshot would only cover the parent itself, leaving its
 * descendants frozen in their pre-mutation state (and styling) for the whole
 * retention window even though `complete_children`/`cancel_children` just
 * closed them too.
 */
function markOpenDescendantsTerminal(children: Task[], status: Extract<TaskStatus, "done" | "cancelled">, at: string): Task[] {
  return children.map((child) => {
    const alreadyClosed = child.status === "done" || child.status === "cancelled";
    return {
      ...child,
      ...(alreadyClosed
        ? {}
        : {
            status,
            needsClarification: false,
            completedAt: status === "done" ? at : null,
            cancelledAt: status === "cancelled" ? at : null,
          }),
      children: markOpenDescendantsTerminal(child.children, status, at),
    };
  });
}

/**
 * Centralises the complete/reopen/cancel/quick-status flow, including the
 * mandatory open-descendant policy prompt and the "recently mutated tasks
 * stay put" retention behaviour required for mobile swipe actions.
 *
 * Complete and cancel accept every descendant policy and apply the parent
 * transition plus descendant outcomes in one backend transaction.
 *
 * Retention: every mutation here is optimistic. The instant it starts, the
 * mutated task is snapshotted (with its *new* status/timestamps) into
 * `retained`, so any list still rendering that row can keep showing it —
 * crossed out or muted — instead of yanking it away the moment the
 * compiled view (Heute/Eingang/Suche/…) refetches and no longer includes
 * it. Crucially, the global refresh (`bump()`) does *not* fire the instant
 * the mutation succeeds: several compiled views only render a section (and
 * the `TaskOutline` within it) while that section is non-empty, so an
 * immediate refetch can unmount the very `TaskOutline` holding the
 * `retained` snapshot — cutting the "stays crossed out" window down to a
 * single render frame instead of `RETENTION_MS`. Instead, `bump()` is
 * deferred to fire exactly once, precisely when the retention window
 * naturally elapses (see `retain`), so counts/badges elsewhere and this
 * row's removal settle together. A failed mutation clears the retained
 * entry (and cancels that pending bump) immediately, which restores the row
 * to its last known-good (pre-mutation) state, and records a message
 * consumers can surface inline — no delayed refresh is left behind.
 */
export function useTaskActions() {
  const [pending, setPending] = useState<{ task: Task; action: PendingAction } | null>(null);
  const mutations = useRetainedMutations<Task>();
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
    (task: Task, policy?: ChildPolicy) => {
      const now = new Date().toISOString();
      const completedOn = localCalendarDate();
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
              needsClarification: false,
              completedAt: null,
              cancelledAt: null,
              scheduledDate: addCalendarDays(
                completedOn,
                task.repeatAfterDays,
              ),
              dueDate: addCalendarDays(
                addCalendarDays(completedOn, task.repeatAfterDays),
                task.allowedDeviationDays,
              ),
            }
          : {
              ...task,
              revision: task.revision + 1,
              status: "done",
              needsClarification: false,
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
        ),
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
        needsClarification: false,
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
        needsClarification: false,
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
        needsClarification: status === "captured",
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
        needsClarification: false,
        completedAt: null,
        cancelledAt: null,
      };
      return runTransition(task, optimistic, () =>
        updateTask(task, { status }),
      );
    },
    [runTransition],
  );

  /** Clarifying a captured task makes it actionable. */
  const clarify = useCallback(
    (task: Task) => {
      const optimistic: Task = {
        ...task,
        revision: task.revision + 1,
        status: "actionable",
        needsClarification: false,
        updatedAt: new Date().toISOString(),
      };
      return runTransition(task, optimistic, () =>
        api.clarifyTask(task.id, task.revision),
      );
    },
    [runTransition],
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
      optimisticPatch: Partial<Task> = patch,
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

  const assignOwner = useCallback(
    (task: Task, ownerMemberId: number | null) => {
      const patch = ownerAssignmentPatch(ownerMemberId);
      return update(
        task,
        patch,
        {
          ...patch,
          effectiveOwnerId: ownerMemberId,
          effectiveOwnerSource: ownerMemberId === null ? "none" : "task",
        },
        true,
      );
    },
    [update],
  );

  const runExternalWaitCommand = useCallback(
    (
      task: Pick<Task, "id">,
      mutate: () => Promise<Task>,
    ) =>
      run({
        id: task.id,
        mutate,
        retain: false,
      }),
    [run],
  );

  const setExternalWait = useCallback(
    (task: Pick<Task, "id" | "revision">, input: Omit<ExternalWaitInput, "expectedRevision">) =>
      runExternalWaitCommand(task, () =>
        api.setExternalWait(task.id, {
          ...input,
          expectedRevision: task.revision,
        }),
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
    ) =>
      runExternalWaitCommand(task, () =>
        api.followUpExternalWait(task.id, {
          ...input,
          expectedRevision: task.revision,
        }),
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

  /**
   * Dispatches the configured primary swipe action. Regardless of what is
   * configured, a task that is already done/cancelled is always reopened —
   * re-applying "Warten"/"Irgendwann"/"Verwerfen" to a finished task would
   * be incoherent, and reopening is the one transition every configuration
   * agrees on.
   */
  const requestPrimarySwipe = useCallback(
    (task: Task, action: PrimarySwipeAction) => {
      if (task.status === "done" || task.status === "cancelled") {
        void reopen(task);
        return;
      }
      if (task.status === "captured") {
        void clarify(task);
        return;
      }
      switch (action) {
        case "someday":
          void setStatus(task, "someday");
          return;
        case "cancel":
          requestCancel(task);
          return;
        case "complete":
        default:
          requestToggle(task);
      }
    },
    [reopen, clarify, setStatus, requestCancel, requestToggle],
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
    pendingTask: pending?.task ?? null,
    pendingAction: pending?.action ?? null,
    pendingIds,
    isPending,
    retained,
    errors,
    clearError,
    requestToggle,
    requestCancel,
    requestPrimarySwipe,
    setStatus,
    clarify,
    update,
    assignOwner,
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
