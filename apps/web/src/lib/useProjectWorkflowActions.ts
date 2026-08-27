import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { ProjectWithActions, ProjectWorkflowAction } from "./api";
import { useRefresh } from "./refresh";
import { statusAfterAction, workflowActionsByStatus } from "./projectWorkflow";
// Reuses the exact same "how long does a just-transitioned row stay put"
// constant as the task list (see `useTaskActions`), so the whole app agrees
// on one retention window rather than two subtly different magic numbers.
import { RETENTION_MS } from "./useTaskActions";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * An optimistically transitioned story plus the transition that produced it,
 * so a row can render the matching past-tense confirmation badge
 * ("Aktiviert", "Abgeschlossen", …) instead of guessing from the new status
 * (`active`, for instance, is reachable both by activating and by reopening).
 */
export interface RetainedStory {
  story: ProjectWithActions;
  action: ProjectWorkflowAction;
}

/**
 * Project/story counterpart of `useTaskActions`: centralises **every**
 * lifecycle transition (activate / return to backlog / complete / reopen /
 * archive) plus the driver-assignment and scheduling edits, for both the
 * Projekte tab and Backlog Review.
 *
 * Transitions are optimistic and retained for `RETENTION_MS`, mirroring
 * `TaskRow`'s "stays visible for ~4s before the list drops it" behaviour —
 * see `useTaskActions` for why the global refresh (`bump()`) is deliberately
 * deferred until the retention window elapses rather than fired immediately.
 * Just like there, `busyId` is cleared as soon as the request resolves, so a
 * retained row becomes actionable again right away and a workflow can be
 * cycled (`abschließen → wieder öffnen → …`) without waiting.
 *
 * Assigning a driver or (re)scheduling never changes a story's status, so
 * those simply patch the project and bump right away.
 */
export function useProjectWorkflowActions() {
  const { bump } = useRefresh();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [retained, setRetained] = useState<Map<number, RetainedStory>>(new Map());
  const [errors, setErrors] = useState<Record<number, string>>({});
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  // Never let a retention timer fire (and call setState) after the owning
  // component unmounted, e.g. the user navigated away mid-window.
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

  const retain = useCallback(
    (entry: RetainedStory) => {
      const id = entry.story.id;
      setRetained((prev) => {
        const next = new Map(prev);
        next.set(id, entry);
        return next;
      });
      const existing = timers.current.get(id);
      if (existing) clearTimeout(existing);
      const timeout = setTimeout(() => {
        release(id);
        bump();
      }, RETENTION_MS);
      timers.current.set(id, timeout);
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

  const call = useCallback(
    (id: number, action: ProjectWorkflowAction, ownerMemberId?: number | null) => {
      switch (action) {
        case "activate":
          return api.activateProject(id, ownerMemberId !== undefined ? { ownerMemberId } : undefined);
        case "return_to_backlog":
          return api.returnProjectToBacklog(id);
        case "complete":
          return api.completeProject(id);
        case "reopen":
          return api.reopenProject(id);
        case "archive":
        default:
          return api.archiveProject(id);
      }
    },
    [],
  );

  /**
   * Runs one workflow transition optimistically. `ownerMemberId` is only
   * passed for an `activate` that had to collect a driver first (the story
   * had none yet) — activation then assigns and starts in a single atomic
   * backend call.
   */
  const runAction = useCallback(
    async (
      story: ProjectWithActions,
      action: ProjectWorkflowAction,
      ownerMemberId?: number | null,
    ) => {
      const nextStatus = statusAfterAction[action];
      const optimistic: ProjectWithActions = {
        ...story,
        status: nextStatus,
        ownerMemberId: ownerMemberId !== undefined ? ownerMemberId : story.ownerMemberId,
        // Predict the next set of legal actions so the retained row can be
        // acted on again immediately, before any refetch confirms it.
        availableActions: workflowActionsByStatus[nextStatus],
      };
      setBusyId(story.id);
      clearError(story.id);
      retain({ story: optimistic, action });
      try {
        const confirmed = await call(story.id, action, ownerMemberId);
        // The response includes freshly computed next-action and stuck state.
        // Replace the status-only optimistic shape before list classification
        // can mistake a newly stuck project for a healthy parked one.
        retain({ story: confirmed, action });
        // No immediate `bump()` — see the hook comment and
        // `useTaskActions.runTransition`: `retain`'s own timer bumps exactly
        // once, when the retention window has fully elapsed.
      } catch (err) {
        release(story.id);
        setErrors((prev) => ({ ...prev, [story.id]: errorMessage(err) }));
      } finally {
        setBusyId(null);
      }
    },
    [call, clearError, retain, release],
  );

  /** Right-swipe / primary-button activation, optionally assigning the driver in the same call. */
  const activate = useCallback(
    (story: ProjectWithActions, ownerMemberId?: number | null) =>
      runAction(story, "activate", ownerMemberId),
    [runAction],
  );

  const archive = useCallback(
    (story: ProjectWithActions) => runAction(story, "archive"),
    [runAction],
  );

  /** Assigns (or, where legal, clears) the driver without changing the status. */
  const assignDriver = useCallback(
    async (story: ProjectWithActions, ownerMemberId: number | null) => {
      setBusyId(story.id);
      clearError(story.id);
      try {
        await api.updateProject(story.id, { ownerMemberId });
        bump();
      } catch (err) {
        setErrors((prev) => ({ ...prev, [story.id]: errorMessage(err) }));
        throw err;
      } finally {
        setBusyId(null);
      }
    },
    [bump, clearError],
  );

  /** Sets due/scheduled dates without changing the status. */
  const schedule = useCallback(
    async (
      story: ProjectWithActions,
      patch: { dueDate?: string | null; scheduledDate?: string | null },
    ) => {
      setBusyId(story.id);
      clearError(story.id);
      try {
        await api.updateProject(story.id, patch);
        bump();
      } catch (err) {
        setErrors((prev) => ({ ...prev, [story.id]: errorMessage(err) }));
        throw err;
      } finally {
        setBusyId(null);
      }
    },
    [bump, clearError],
  );

  return { busyId, retained, errors, clearError, runAction, activate, archive, assignDriver, schedule };
}
