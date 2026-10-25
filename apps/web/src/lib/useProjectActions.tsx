import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "./api";
import type { Project, ProjectActivationResolution } from "@machbar/shared";
import type { ProjectWithActions, ProjectWorkflowAction, ProjectWorkflowInput, UpdateProjectInput } from "./api";
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
 * state updates and refreshes are immediate, independently of list placement.
 * Pending state is tracked per project and cleared as soon as the request
 * resolves, so a retained row becomes actionable again right away.
 *
 * Metadata changes refresh immediately but keep their confirmed overlay until
 * the caller's authoritative project collection reaches the same revision.
 *
 * This is the underlying state/logic, instantiated exactly once by
 * `ProjectActionsProvider` below so every consumer shares one
 * optimistic/pending/error state. Call `useProjectActions(authoritative)`
 * to consume it — each caller still passes its own currently-loaded
 * project collection so retained rows release once *that* view's data
 * catches up, independent of any other mounted view.
 */
function useProjectActionsState() {
  const mutations = useRetainedMutations<RetainedStory>({ immediateRefresh: true });
  const [acknowledgedReviewIds, setAcknowledgedReviewIds] = useState<Set<number>>(new Set());
  const {
    run,
    release,
    pendingIds,
    isPending,
    retained,
    errors,
    clearError,
  } = mutations;
  const projectStory = useCallback(<T extends Project,>(current: T): T => {
    const candidate = retained.get(current.id)?.story;
    return candidate &&
      (candidate.revision > current.revision ||
        (isPending(current.id) && candidate.revision === current.revision))
      ? { ...current, ...candidate }
      : current;
  }, [isPending, retained]);

  useEffect(() => {
    setAcknowledgedReviewIds(current => {
      const next = new Set([...current].filter(id => mutations.holdingIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [mutations.holdingIds]);

  const call = useCallback(
    (
      story: ProjectWithActions,
      action: ProjectWorkflowAction,
      ownerMemberId?: number | null,
      activationResolution?: ProjectActivationResolution,
      expectedRevision?: number,
      workflowInput?: Partial<ProjectWorkflowInput>,
    ) => {
      const input = { expectedRevision: expectedRevision ?? story.revision, ...workflowInput };
      switch (action) {
        case "activate":
          return api.activateProject(story.id, {
            ...input,
            ...(ownerMemberId !== undefined ? { ownerMemberId } : {}),
            ...(activationResolution ? { activationResolution } : {}),
          });
        case "return_to_backlog":
          return api.returnProjectToBacklog(story.id, input);
        case "complete":
          return api.completeProject(story.id, input);
        case "reopen":
          return api.reopenProject(story.id, {
            ...input,
            ...(ownerMemberId !== undefined ? { ownerMemberId } : {}),
            ...(activationResolution ? { activationResolution } : {}),
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
      activationResolution?: ProjectActivationResolution,
      throwOnError = false,
      expectedRevision?: number,
      workflowInput?: Partial<ProjectWorkflowInput>,
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
        mutate: () => call(story, action, ownerMemberId, activationResolution, expectedRevision, workflowInput),
        confirmed: (confirmed) => ({ story: confirmed, action }),
        throwOnError,
      });
    },
    [call, run],
  );

  /** Right-swipe / primary-button activation, optionally assigning the driver in the same call. */
  const activate = useCallback(
    (story: ProjectWithActions, ownerMemberId?: number | null, activationResolution?: ProjectActivationResolution) =>
      runAction(story, "activate", ownerMemberId, activationResolution),
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
            expectedRevision: patch.expectedRevision ?? story.revision,
          }),
        confirmed: (confirmed) => ({ story: confirmed }),
          retainUntilRefresh: true,
          refreshImmediately: true,
          throwOnError,
      }),
    [run],
  );

  const appendNotes = useCallback((story: ProjectWithActions, content: string) => run({
    id: story.id, optimistic: { story }, mutate: () => api.appendProjectNotes(story.id, content),
    confirmed: confirmed => ({ story: confirmed }), retainUntilRefresh: true, refreshImmediately: true, throwOnError: true,
  }), [run]);

  const assignDriver = useCallback(
    (story: ProjectWithActions, ownerMemberId: number | null) =>
      update(story, { ownerMemberId }, { ownerMemberId }, true),
    [update],
  );

  const schedule = useCallback(
    (
      story: ProjectWithActions,
      patch: UpdateProjectInput,
    ) => update(story, patch, {
      ...(patch.dueDate !== undefined ? { dueDate: patch.dueDate } : {}),
      ...(patch.revisitAt !== undefined ? { revisitAt: patch.revisitAt } : {}),
    }, true),
    [update],
  );

  const returnToBacklog = useCallback(
    (story: ProjectWithActions, revisitAt: string | null, withdrawCommitments = false, expectedTaskRevisions?: Array<{ taskId: number; revision: number }>) =>
      run({
        id: story.id,
        optimistic: {
          story: {
            ...story,
            status: "backlog",
            revisitAt,
            revision: story.revision + 1,
            availableActions: workflowActionsByStatus.backlog,
          },
          action: "return_to_backlog",
        },
        mutate: () =>
          api.returnProjectToBacklog(story.id, {
            expectedRevision: story.revision,
            revisitAt,
            withdrawCommitments,
            ...(expectedTaskRevisions !== undefined ? { expectedTaskRevisions } : {}),
          }),
        confirmed: (confirmed) => ({ story: confirmed, action: "return_to_backlog" }),
        throwOnError: true,
      }),
    [run],
  );

  const setContexts = useCallback(
    (story: ProjectWithActions, contextIds: number[]) =>
      update(story, { contextIds }, undefined, true),
    [update],
  );

  const acknowledgeReview = useCallback(
    async (story: ProjectWithActions) => {
      const result = await run({
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
      });
      if (result) setAcknowledgedReviewIds(current => new Set(current).add(story.id));
      return result;
    },
    [run],
  );

  return {
    acknowledgedReviewIds,
    projectStory,
    pendingIds,
    holdingIds: mutations.holdingIds,
    pauseRetention: mutations.pauseRetention,
    isPending,
    retained,
    release,
    errors,
    clearError,
    runAction,
    activate,
    archive,
    update,
    appendNotes,
    assignDriver,
    schedule,
    returnToBacklog,
    setContexts,
    acknowledgeReview,
  };
}

type ProjectActionsValue = ReturnType<typeof useProjectActionsState>;

const ProjectActionsContext = createContext<ProjectActionsValue | null>(null);

/**
 * Mounts the single shared `useProjectActionsState()` instance for the
 * whole app (see `App.tsx`) so every consumer (Projekte tab, project
 * detail, Review, captured-project handoff, All) reads and mutates the
 * same pending/retained/error state. Test files use `renderWithProviders`,
 * which mounts this too.
 */
export function ProjectActionsProvider({ children }: { children: ReactNode }) {
  const value = useProjectActionsState();
  return (
    <ProjectActionsContext.Provider value={value}>{children}</ProjectActionsContext.Provider>
  );
}

/**
 * Consumes the shared project/story action controller mounted by
 * `ProjectActionsProvider`, releasing this caller's retained rows once its
 * own `authoritativeProjects` collection catches up to their revision.
 */
export function useProjectActions(
  authoritativeProjects: readonly ProjectWithActions[] = [],
): Omit<ProjectActionsValue, "release"> {
  const context = useContext(ProjectActionsContext);
  if (!context) {
    throw new Error("useProjectActions must be used within a ProjectActionsProvider");
  }
  const { release, retained, ...rest } = context;

  useEffect(() => {
    for (const [id, entry] of retained) {
      if (context.holdingIds.has(id) || context.isPending(id)) continue;
      const authoritative = authoritativeProjects.find((project) => project.id === id);
      if (authoritative && entry.story && authoritative.revision >= entry.story.revision) {
        release(id);
      }
    }
  }, [authoritativeProjects, release, retained, context.holdingIds, context.isPending]);

  return { retained, ...rest };
}
