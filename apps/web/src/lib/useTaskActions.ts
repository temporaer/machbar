import { useCallback, useEffect, useRef, useState } from "react";
import type { Task, TaskStatus } from "@machbar/shared";
import { api } from "./api";
import { useRefresh } from "./refresh";
import { hasOpenDescendants, openDescendantRoots } from "./taskHelpers";
import type { PrimarySwipeAction } from "./swipeSettings";

/** The three choices offered by the mandatory open-descendant policy prompt. */
export type ChildPolicy = "leave_open" | "complete_children" | "cancel_children";
export type PendingAction = "complete" | "cancel";

/**
 * How long a task that just left its compiled view (completed, cancelled,
 * or otherwise transitioned to a status the current list no longer shows)
 * keeps rendering in place with its optimistic status before the retained
 * override is dropped. Kept mid-range of the "about 3-5 seconds" requirement.
 */
export const RETENTION_MS = 4000;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
        : { status, completedAt: status === "done" ? at : null, cancelledAt: status === "cancelled" ? at : null }),
      children: markOpenDescendantsTerminal(child.children, status, at),
    };
  });
}

/** Mirrors the backend's `reopenTask` heuristic (see `apps/api/src/domain/mutations.ts`). */
function reopenedStatus(task: Task): TaskStatus {
  const looksClarified =
    task.projectId !== null ||
    task.context !== null ||
    task.ownerMemberId !== null ||
    task.dueDate !== null ||
    task.scheduledDate !== null;
  return looksClarified ? "actionable" : "inbox";
}

/**
 * Centralises the complete/reopen/cancel/quick-status flow, including the
 * mandatory open-descendant policy prompt and the "recently mutated tasks
 * stay put" retention behaviour required for mobile swipe actions.
 *
 * The real backend (`apps/api/src/domain/mutations.ts`) only lets a single
 * `descendantsPolicy` accompany the *matching* action — `complete_children`
 * for `POST /tasks/:id/complete`, `cancel_children` for
 * `POST /tasks/:id/cancel`. The prompt still offers all three documented
 * choices (leave open / complete children / cancel children) regardless of
 * which action triggered it, so picking the "other" policy is composed from
 * two calls: first apply that policy to the highest open task on every
 * descendant branch, then apply `leave_open` to the parent itself.
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
  const { bump } = useRefresh();
  const [pending, setPending] = useState<{ task: Task; action: PendingAction } | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [retained, setRetained] = useState<Map<number, Task>>(new Map());
  const [errors, setErrors] = useState<Record<number, string>>({});
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  // Never let a retention timer fire (and call setState) after this hook's
  // owning component has unmounted, e.g. the user navigated away mid-window.
  useEffect(
    () => () => {
      timers.current.forEach((t) => clearTimeout(t));
      timers.current.clear();
    },
    [],
  );

  const release = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (t) {
      clearTimeout(t);
      timers.current.delete(id);
    }
    setRetained((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  /**
   * Starts (or restarts) the retention window for a task. When it naturally
   * expires — i.e. it is never pre-empted by `release` (mutation failure) or
   * superseded by a later `retain` call for the same id (a follow-up
   * transition on the same task) — the row is released *and only then* is
   * the global refresh bumped. See `runTransition` for why the bump must not
   * happen any earlier.
   */
  const retain = useCallback(
    (optimisticTask: Task) => {
      setRetained((prev) => {
        const next = new Map(prev);
        next.set(optimisticTask.id, optimisticTask);
        return next;
      });
      const existing = timers.current.get(optimisticTask.id);
      if (existing) clearTimeout(existing);
      const timeout = setTimeout(() => {
        release(optimisticTask.id);
        bump();
      }, RETENTION_MS);
      timers.current.set(optimisticTask.id, timeout);
    },
    [release, bump],
  );

  const clearError = useCallback((id: number) => {
    setErrors((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const runTransition = useCallback(
    async (task: Task, optimisticTask: Task, job: () => Promise<unknown>) => {
      setBusyId(task.id);
      clearError(task.id);
      retain(optimisticTask);
      try {
        await job();
        // Deliberately no `bump()` here. Bumping now would let every
        // subscribed compiled view (Heute/Eingang/Suche/…) refetch
        // immediately — before the retention window is up — and some of
        // those views conditionally render their child `TaskOutline` only
        // while its section is non-empty (see e.g. `TodayPage`'s
        // `.filter((s) => agenda[s.key].length > 0)`). An immediate refetch
        // can therefore unmount *this very* `TaskOutline`, destroying the
        // `retained` state we just optimistically set and cutting the
        // crossed-out row's visible lifetime down to a single render frame
        // instead of the full window. `retain`'s own timer releases the row
        // and bumps exactly once, once the window has fully elapsed.
      } catch (err) {
        release(task.id);
        setErrors((prev) => ({ ...prev, [task.id]: errorMessage(err) }));
      } finally {
        setBusyId(null);
        setPending(null);
      }
    },
    [clearError, retain, release],
  );

  const complete = useCallback(
    (task: Task, policy?: ChildPolicy) => {
      const now = new Date().toISOString();
      // Whichever policy closes the open descendants (matching or the mixed
      // "cancel children while completing the parent" case), fold that same
      // outcome into the optimistic snapshot's `children`, recursively, so
      // the whole retained subtree reflects its post-mutation state instead
      // of just the parent row.
      const descendantStatus: Extract<TaskStatus, "done" | "cancelled"> | null =
        policy === "complete_children" ? "done" : policy === "cancel_children" ? "cancelled" : null;
      const optimistic: Task = {
        ...task,
        status: "done",
        completedAt: now,
        cancelledAt: null,
        children: descendantStatus ? markOpenDescendantsTerminal(task.children, descendantStatus, now) : task.children,
      };
      return runTransition(task, optimistic, async () => {
        if (policy === "cancel_children") {
          const openRoots = openDescendantRoots(task);
          await Promise.all(openRoots.map((c) => api.cancelTask(c.id, "cancel_children")));
          await api.completeTask(task.id, "leave_open");
        } else {
          await api.completeTask(task.id, policy === "complete_children" ? "complete_children" : "leave_open");
        }
      });
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
        status: "cancelled",
        cancelledAt: now,
        completedAt: null,
        children: descendantStatus ? markOpenDescendantsTerminal(task.children, descendantStatus, now) : task.children,
      };
      return runTransition(task, optimistic, async () => {
        if (policy === "complete_children") {
          const openRoots = openDescendantRoots(task);
          await Promise.all(openRoots.map((c) => api.completeTask(c.id, "complete_children")));
          await api.cancelTask(task.id, "leave_open");
        } else {
          await api.cancelTask(task.id, policy === "cancel_children" ? "cancel_children" : "leave_open");
        }
      });
    },
    [runTransition],
  );

  const reopen = useCallback(
    (task: Task) => {
      const optimistic: Task = { ...task, status: reopenedStatus(task), completedAt: null, cancelledAt: null };
      return runTransition(task, optimistic, () => api.reopenTask(task.id));
    },
    [runTransition],
  );

  /** Quick, prompt-free status change (used by the "Warten" swipe chip / config). Never terminal. */
  const setStatus = useCallback(
    (task: Task, status: Extract<TaskStatus, "waiting" | "someday" | "actionable">) => {
      const optimistic: Task = { ...task, status, completedAt: null, cancelledAt: null };
      return runTransition(task, optimistic, () => api.updateTask(task.id, { status }));
    },
    [runTransition],
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
      switch (action) {
        case "waiting":
          void setStatus(task, "waiting");
          return;
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
    [reopen, setStatus, requestCancel, requestToggle],
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
    retained,
    errors,
    clearError,
    requestToggle,
    requestCancel,
    requestPrimarySwipe,
    setStatus,
    resolvePolicy,
    cancelPrompt,
    complete,
    cancel,
    reopen,
  };
}
