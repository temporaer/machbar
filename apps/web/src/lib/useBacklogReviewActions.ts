import { useCallback, useEffect, useRef, useState } from "react";
import type { Project } from "@machbar/shared";
import { api } from "./api";
import { useRefresh } from "./refresh";
// Reuses the exact same "how long does a just-transitioned row stay put"
// constant as the task list (see `useTaskActions`), so the whole app agrees
// on one retention window rather than two subtly different magic numbers.
import { RETENTION_MS } from "./useTaskActions";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Backlog-review counterpart of `useTaskActions`: centralises the
 * activate/archive workflow transitions (which remove a story from the
 * backlog list) plus the driver-assignment/scheduling edits (which don't).
 *
 * Activate/archive are optimistic and retained for `RETENTION_MS`, mirroring
 * `TaskRow`'s "stays crossed out for ~4s before disappearing" behaviour —
 * see that hook's extensive comments for why the global refresh (`bump()`)
 * is deliberately deferred until the retention window elapses rather than
 * fired immediately. Assigning a driver or (re)scheduling never removes the
 * story from the backlog list, so those simply patch the project and bump
 * right away.
 */
export function useBacklogReviewActions() {
  const { bump } = useRefresh();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [retained, setRetained] = useState<Map<number, Project>>(new Map());
  const [errors, setErrors] = useState<Record<number, string>>({});
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

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
    (optimisticStory: Project) => {
      setRetained((prev) => {
        const next = new Map(prev);
        next.set(optimisticStory.id, optimisticStory);
        return next;
      });
      const existing = timers.current.get(optimisticStory.id);
      if (existing) clearTimeout(existing);
      const timeout = setTimeout(() => {
        release(optimisticStory.id);
        bump();
      }, RETENTION_MS);
      timers.current.set(optimisticStory.id, timeout);
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
    async (story: Project, optimisticStory: Project, job: () => Promise<unknown>) => {
      setBusyId(story.id);
      clearError(story.id);
      retain(optimisticStory);
      try {
        await job();
        // No immediate `bump()` here either — see the hook-level comment
        // and `useTaskActions.runTransition`. `retain`'s own timer bumps
        // exactly once, once the retention window has fully elapsed.
      } catch (err) {
        release(story.id);
        setErrors((prev) => ({ ...prev, [story.id]: errorMessage(err) }));
      } finally {
        setBusyId(null);
      }
    },
    [clearError, retain, release],
  );

  /**
   * Right-swipe / non-gesture activate control. `ownerMemberId` is only
   * passed when the caller just collected it from the driver-assignment
   * sheet (i.e. the story had none yet) — otherwise the story's own current
   * driver is kept.
   */
  const activate = useCallback(
    (story: Project, ownerMemberId?: number | null) => {
      const optimistic: Project = {
        ...story,
        status: "active",
        ownerMemberId: ownerMemberId !== undefined ? ownerMemberId : story.ownerMemberId,
      };
      return runTransition(story, optimistic, () =>
        api.activateProject(
          story.id,
          ownerMemberId !== undefined ? { ownerMemberId } : undefined,
        ),
      );
    },
    [runTransition],
  );

  const archive = useCallback(
    (story: Project) => {
      const optimistic: Project = { ...story, status: "archived" };
      return runTransition(story, optimistic, () => api.archiveProject(story.id));
    },
    [runTransition],
  );

  /** Assigns (or clears) the driver without leaving the backlog. */
  const assignDriver = useCallback(
    async (story: Project, ownerMemberId: number | null) => {
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

  /** Sets due/scheduled dates without leaving the backlog. */
  const schedule = useCallback(
    async (story: Project, patch: { dueDate?: string | null; scheduledDate?: string | null }) => {
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

  return { busyId, retained, errors, clearError, activate, archive, assignDriver, schedule };
}
