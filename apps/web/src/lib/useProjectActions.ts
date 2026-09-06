import { useCallback, useEffect } from "react";
import { api } from "./api";
import type { ProjectWithActions, ProjectWorkflowAction, UpdateProjectInput } from "./api";
import { statusAfterAction, workflowActionsByStatus } from "./projectWorkflow";
import { useRetainedMutations } from "./useRetainedMutations";

/**
 * An optimistically transitioned story plus the transition that produced it,
 * so a row can render the matching past-tense confirmation badge
 * ("Aktiviert", "Abgeschlossen", …) instead of guessing from the new status
 * (`active`, for instance, is reachable both by activating and by reopening).
 */
export interface RetainedStory {
  story: ProjectWithActions;
  action?: ProjectWorkflowAction;
}

/**
 * Project/story counterpart of `useTaskActions`: centralises **every**
 * lifecycle transition (activate / return to backlog / complete / reopen /
 * archive) plus project metadata edits (title, notes, driver, tags, and
 * scheduling), for the project editor, Projekte tab, and Review.
 *
 * Transitions are optimistic and retained for `RETENTION_MS`, mirroring
 * `TaskRow`'s "stays visible for ~4s before the list drops it" behaviour —
 * see `useTaskActions` for why the global refresh (`bump()`) is deliberately
 * deferred until the retention window elapses rather than fired immediately.
 * Pending state is tracked per project and cleared as soon as the request
 * resolves, so a retained row becomes actionable again right away.
 *
 * Metadata changes refresh immediately but keep their confirmed overlay until
 * the caller's authoritative project collection reaches the same revision.
 */
export function useProjectActions(
  authoritativeProjects: readonly ProjectWithActions[] = [],
) {
  const mutations = useRetainedMutations<RetainedStory>();
  const {
    run,
    release,
    pendingIds,
    isPending,
    retained,
    errors,
    clearError,
  } = mutations;

  useEffect(() => {
    for (const [id, entry] of retained) {
      if (entry.action !== undefined) continue;
      const authoritative = authoritativeProjects.find((project) => project.id === id);
      if (authoritative && authoritative.revision >= entry.story.revision) {
        release(id);
      }
    }
  }, [authoritativeProjects, release, retained]);

  const call = useCallback(
    (
      story: ProjectWithActions,
      action: ProjectWorkflowAction,
      ownerMemberId?: number | null,
    ) => {
      const input = { expectedRevision: story.revision };
      switch (action) {
        case "activate":
          return api.activateProject(story.id, {
            ...input,
            ...(ownerMemberId !== undefined ? { ownerMemberId } : {}),
          });
        case "return_to_backlog":
          return api.returnProjectToBacklog(story.id, input);
        case "complete":
          return api.completeProject(story.id, input);
        case "reopen":
          return api.reopenProject(story.id, {
            ...input,
            ...(ownerMemberId !== undefined ? { ownerMemberId } : {}),
          });
        case "archive":
        default:
          return api.archiveProject(story.id, input);
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
      return run({
        id: story.id,
        optimistic: { story: optimistic, action },
        mutate: () => call(story, action, ownerMemberId),
        confirmed: (confirmed) => ({ story: confirmed, action }),
      });
    },
    [call, run],
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

  const update = useCallback(
    (
      story: ProjectWithActions,
      patch: UpdateProjectInput,
      optimisticPatch: Partial<ProjectWithActions> = patch,
      throwOnError = false,
    ) =>
      run({
        id: story.id,
        optimistic: {
          story: {
            ...story,
            ...optimisticPatch,
            revision: story.revision + 1,
          },
        },
        mutate: () =>
          api.updateProject(story.id, {
            ...patch,
            expectedRevision: story.revision,
          }),
        confirmed: (confirmed) => ({ story: confirmed }),
          retainUntilRefresh: true,
          refreshImmediately: true,
          throwOnError,
      }),
    [run],
  );

  const assignDriver = useCallback(
    (story: ProjectWithActions, ownerMemberId: number | null) =>
      update(story, { ownerMemberId }, { ownerMemberId }, true),
    [update],
  );

  const schedule = useCallback(
    (
      story: ProjectWithActions,
      patch: { dueDate?: string | null; scheduledDate?: string | null },
    ) => update(story, patch, patch, true),
    [update],
  );

  const setContexts = useCallback(
    (story: ProjectWithActions, contextIds: number[]) =>
      update(story, { contextIds }, undefined, true),
    [update],
  );

  const acknowledgeReview = useCallback(
    (story: ProjectWithActions) =>
      run({
        id: story.id,
        optimistic: {
          story: {
            ...story,
            revision: story.revision + 1,
            reviewedAt: new Date().toISOString(),
          },
        },
        mutate: () =>
          api.acknowledgeProjectReview(story.id, {
            expectedRevision: story.revision,
          }),
        confirmed: (confirmed) => ({ story: confirmed }),
        refreshImmediately: true,
        retainUntilRefresh: true,
      }),
    [run],
  );

  return {
    pendingIds,
    isPending,
    retained,
    errors,
    clearError,
    runAction,
    activate,
    archive,
    update,
    assignDriver,
    schedule,
    setContexts,
    acknowledgeReview,
  };
}
