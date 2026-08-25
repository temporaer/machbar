import { useCallback, useState } from "react";
import type { Task } from "@machbar/shared";
import { api } from "./api";
import { useRefresh } from "./refresh";
import { hasOpenDescendants, openDescendantRoots } from "./taskHelpers";

/** The three choices offered by the mandatory open-descendant policy prompt. */
export type ChildPolicy = "leave_open" | "complete_children" | "cancel_children";
export type PendingAction = "complete" | "cancel";

/**
 * Centralises the complete/reopen/cancel flow, including the mandatory
 * open-descendant policy prompt. Any list (Today, Inbox, project outline,
 * search results, waiting groups) can reuse this instead of re-implementing
 * the prompt logic.
 *
 * The real backend (`apps/api/src/domain/mutations.ts`) only lets a single
 * `descendantsPolicy` accompany the *matching* action — `complete_children`
 * for `POST /tasks/:id/complete`, `cancel_children` for
 * `POST /tasks/:id/cancel`. The prompt still offers all three documented
 * choices (leave open / complete children / cancel children) regardless of
 * which action triggered it, so picking the "other" policy is composed from
 * two calls: first apply that policy to the highest open task on every
 * descendant branch, then apply `leave_open` to the parent itself.
 */
export function useTaskActions() {
  const { bump } = useRefresh();
  const [pending, setPending] = useState<{ task: Task; action: PendingAction } | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const runBusy = useCallback(
    async (id: number, job: () => Promise<unknown>) => {
      setBusyId(id);
      try {
        await job();
        bump();
      } finally {
        setBusyId(null);
        setPending(null);
      }
    },
    [bump],
  );

  const complete = useCallback(
    (task: Task, policy?: ChildPolicy) =>
      runBusy(task.id, async () => {
        if (policy === "cancel_children") {
          const openRoots = openDescendantRoots(task);
          await Promise.all(openRoots.map((c) => api.cancelTask(c.id, "cancel_children")));
          await api.completeTask(task.id, "leave_open");
        } else {
          await api.completeTask(task.id, policy === "complete_children" ? "complete_children" : "leave_open");
        }
      }),
    [runBusy],
  );

  const cancel = useCallback(
    (task: Task, policy?: ChildPolicy) =>
      runBusy(task.id, async () => {
        if (policy === "complete_children") {
          const openRoots = openDescendantRoots(task);
          await Promise.all(openRoots.map((c) => api.completeTask(c.id, "complete_children")));
          await api.cancelTask(task.id, "leave_open");
        } else {
          await api.cancelTask(task.id, policy === "cancel_children" ? "cancel_children" : "leave_open");
        }
      }),
    [runBusy],
  );

  const reopen = useCallback(
    (task: Task) => runBusy(task.id, () => api.reopenTask(task.id)),
    [runBusy],
  );

  /** Toggle from a checkbox/swipe-right: asks first when there are open children. */
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

  /** Explicit "discard"/swipe-left action: asks first when there are open children. */
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
    pendingTask: pending?.task ?? null,
    pendingAction: pending?.action ?? null,
    busyId,
    requestToggle,
    requestCancel,
    resolvePolicy,
    cancelPrompt,
    complete,
    cancel,
    reopen,
  };
}
