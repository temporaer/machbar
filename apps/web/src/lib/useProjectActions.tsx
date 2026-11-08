import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import type { Project, ProjectActivationResolution } from "@machbar/shared";
import type {
  ConvertStoryToTaskInput,
  CreateTaskStepBatchInput,
  ProjectDetail,
  ProjectRevisionSnapshot,
  ProjectWithActions,
  ProjectWorkflowAction,
  ProjectWorkflowInput,
  UpdateProjectInput,
} from "./api";
import { statusAfterAction, workflowActionsByStatus } from "./projectWorkflow";
import { useRetainedMutations } from "./useRetainedMutations";
import { isWorkItemAccessError, localizedErrorMessage, ProjectReadRevisionRegressionError } from "./errorMessage";
import { useStrings } from "./strings";
import { identityQueryKey, useIdentityScope } from "./identity";
import { captureProjectRead, isProjectDetail, projectQueryKeys, projectReadIsAccessible, projectReadIsCurrent, projectRevisionIsPublishable, projectStructuralSharing, reconcileProjectMetadata, setProjectReadState } from "./projectQueries";
import type { ProjectRead, ProjectReadToken } from "./projectQueries";
import { useQueryClient } from "@tanstack/react-query";
import { useRefresh } from "./refresh";

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

function projectMetadata(project: ProjectWithActions & Partial<ProjectDetail>): ProjectWithActions {
  const {
    tasks, childStories, ancestors, hierarchyRevisions, externalRefs,
    activationDecisionSnapshot, directActivationDecisionSnapshot, ...story
  } = project;
  return story;
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
  const strings = useStrings();
  const identityScope = useIdentityScope();
  const identityKey = identityQueryKey(identityScope);
  const queryClient = useQueryClient();
  const { bump, version } = useRefresh();
  const [, notifyCacheChange] = useState(0);
  const captureTargetGuard = useCallback((id: number) => {
    const read = captureProjectRead(queryClient, identityKey, id);
    return () => projectReadIsCurrent(queryClient, read);
  }, [identityKey, queryClient]);
  useEffect(() => queryClient.getQueryCache().subscribe(event => {
    if (event.query.queryKey[0] !== "projects" ||
      event.query.queryKey[1] !== identityKey) return;
    const data = event.query.state.data as ProjectWithActions | undefined;
    if (event.type === "updated" && event.action.type === "success" &&
      event.action.manual !== true && typeof event.query.queryKey[3] === "number" &&
      data && isProjectDetail(data)) {
      const read = captureProjectRead(queryClient, identityKey, event.query.queryKey[3]);
      setProjectReadState(queryClient, read, false);
    }
    if (event.type === "removed" || (event.type === "updated" &&
      ["success", "error", "setState"].includes(event.action.type))) {
      notifyCacheChange(current => current + 1);
    }
  }), [identityKey, queryClient]);
  const mutations = useRetainedMutations<RetainedStory>({
    immediateRefresh: true,
    identityKey: identityScope,
    captureTargetGuard,
  });
  const previousIdentity = useRef(identityKey);
  useEffect(() => {
    if (previousIdentity.current === identityKey) return;
    queryClient.removeQueries({ queryKey: projectQueryKeys.identity(previousIdentity.current) });
    previousIdentity.current = identityKey;
  }, [identityKey, queryClient]);
  const [acknowledgedReviewIds, setAcknowledgedReviewIds] = useState<Set<number>>(new Set());
  const scope = useRef(mutations.scopeToken);
  if (scope.current !== mutations.scopeToken) {
    scope.current = mutations.scopeToken;
    if (acknowledgedReviewIds.size > 0) setAcknowledgedReviewIds(new Set());
  }
  const {
    run,
    release,
    pendingIds,
    isPending,
    retained,
    errors,
    clearError,
  } = mutations;
  const queryKey = useCallback((id: number) => projectQueryKeys.detail(identityKey, id), [identityKey]);
  const getCachedStory = useCallback((id: number) =>
    projectReadIsAccessible(queryClient, identityKey, id)
      ? queryClient.getQueryData<ProjectWithActions>(queryKey(id))
      : undefined, [identityKey, queryClient, queryKey]);
  const projectStory = useCallback(<T extends Project,>(current: T): T => {
    const cached = getCachedStory(current.id);
    const baseline = cached && cached.revision > current.revision
      ? { ...current, ...projectMetadata(cached) }
      : current;
    const candidate = retained.get(current.id)?.story;
    return candidate &&
      (candidate.revision > baseline.revision ||
        (isPending(current.id) && candidate.revision === baseline.revision))
      ? { ...baseline, ...candidate }
      : baseline;
  }, [getCachedStory, isPending, retained]);
  const captureTargetRead = useCallback((id: number): ProjectReadToken =>
    captureProjectRead(queryClient, identityKey, id), [identityKey, queryClient]);
  const queryMeta = useCallback((id: number) => {
    captureTargetRead(id);
    const meta = queryClient.getQueryCache().find({ queryKey: queryKey(id), exact: true })?.meta;
    if (!meta) throw new Error("Project query read metadata is unavailable.");
    return meta;
  }, [captureTargetRead, queryClient, queryKey]);
  const isCurrentTargetRead = useCallback((read: ProjectReadToken) =>
    read.identity === identityKey && projectReadIsCurrent(queryClient, read),
  [identityKey, queryClient]);
  const isTargetReadable = useCallback((id: number) =>
    projectReadIsAccessible(queryClient, identityKey, id), [identityKey, queryClient]);
  const isCurrentProjectRead = useCallback((project: object) => {
    const candidate = project as ProjectDetail;
    return queryClient.getQueryData<ProjectDetail>(queryKey(candidate.id)) === project &&
      projectReadIsAccessible(queryClient, identityKey, candidate.id);
  }, [identityKey, queryClient, queryKey]);
  const fetchProject = useCallback(async (
    id: number,
    signal?: AbortSignal,
    onCurrentError?: (cause: unknown) => void,
    read = captureTargetRead(id),
  ) => {
    try {
      const result = await api.getProject(id, signal);
      if (!mutations.isCurrentScope(mutations.scopeToken) || !projectReadIsCurrent(queryClient, read)) {
        throw new Error(strings.workflowTargetUnavailable);
      }
      const current = queryClient.getQueryData<ProjectWithActions>(queryKey(id));
      if (!projectRevisionIsPublishable(current, result)) {
        throw new ProjectReadRevisionRegressionError();
      }
      return result;
    } catch (cause) {
      if (!signal?.aborted && mutations.isCurrentScope(mutations.scopeToken) && projectReadIsCurrent(queryClient, read)) {
        onCurrentError?.(cause);
        if (isWorkItemAccessError(cause)) {
          setProjectReadState(queryClient, read, true);
          mutations.release(id);
          mutations.clearError(id);
        }
      }
      throw cause;
    }
  }, [captureTargetRead, identityKey, mutations.clearError, mutations.isCurrentScope, mutations.release, mutations.scopeToken, queryClient, queryKey, strings]);
  const getCachedProject = useCallback((id: number) => {
    const value = getCachedStory(id);
    return value && isProjectDetail(value) ? value : undefined;
  }, [getCachedStory]);
  const reconcileProjectSnapshot = useCallback((snapshot: ProjectRevisionSnapshot) => {
    if (!mutations.isCurrentScope(mutations.scopeToken)) return;
    reconcileProjectMetadata(queryClient, queryKey(snapshot.id), snapshot);
  }, [mutations.isCurrentScope, mutations.scopeToken, queryClient, queryKey]);
  const readProject = useCallback(async (
    id: number,
    onCurrentError?: (cause: unknown) => void,
  ): Promise<ProjectRead<ProjectDetail>> => {
    const read = captureTargetRead(id);
    await queryClient.cancelQueries({ queryKey: queryKey(id), exact: true }, { silent: true });
    let acceptedFullRead = false;
    const unsubscribe = queryClient.getQueryCache().subscribe(event => {
      if (event.type !== "updated" || event.query !== read.query ||
        event.action.type !== "success" || event.action.manual === true) return;
      const data = event.query.state.data as ProjectWithActions | undefined;
      if (data && isProjectDetail(data)) acceptedFullRead = true;
    });
    try {
      const fetched = await queryClient.fetchQuery({
        queryKey: queryKey(id),
        queryFn: ({ signal }) => fetchProject(id, signal, onCurrentError, read),
        staleTime: 0,
        retry: false,
        gcTime: Infinity,
        structuralSharing: projectStructuralSharing,
        meta: queryMeta(id),
      });
      if (!acceptedFullRead || !isProjectDetail(fetched) ||
        queryClient.getQueryData<ProjectWithActions>(queryKey(id)) !== fetched ||
        !projectReadIsCurrent(queryClient, read) ||
        !projectReadIsAccessible(queryClient, identityKey, id) ||
        !mutations.isCurrentScope(mutations.scopeToken)) {
        throw new ProjectReadRevisionRegressionError();
      }
      return { read, value: fetched };
    } finally {
      unsubscribe();
    }
  }, [captureTargetRead, fetchProject, identityKey, mutations.isCurrentScope, mutations.scopeToken, queryClient, queryKey, queryMeta]);
  const getProject = useCallback((id: number, onCurrentError?: (cause: unknown) => void) =>
    readProject(id, onCurrentError).then(result => result.value),
  [readProject]);

  const mutateProject = useCallback(async <T,>(
    id: number,
    mutate: () => Promise<T>,
    removeDetail = false,
    projectResult?: (result: T) => ProjectWithActions,
  ): Promise<T> => {
    const read = captureTargetRead(id);
    await queryClient.cancelQueries({ queryKey: queryKey(id), exact: true }, { silent: true });
    if (!mutations.isCurrentScope(mutations.scopeToken) ||
      !isCurrentTargetRead(read) || !isTargetReadable(id)) {
      throw new Error(strings.workflowTargetUnavailable);
    }
    try {
      const result = await mutate();
      if (!mutations.isCurrentScope(mutations.scopeToken) || !isCurrentTargetRead(read)) {
        throw new Error(strings.workflowTargetUnavailable);
      }
      if (removeDetail) {
        queryClient.removeQueries({ queryKey: queryKey(id), exact: true });
      } else if (projectResult) {
        reconcileProjectMetadata(queryClient, queryKey(id), projectMetadata(projectResult(result)));
      }
      return result;
    } catch (cause) {
      if (mutations.isCurrentScope(mutations.scopeToken)) {
        if (!isCurrentTargetRead(read)) {
          void queryClient.invalidateQueries({ queryKey: queryKey(id), exact: true });
        } else if (isWorkItemAccessError(cause)) {
          void queryClient.refetchQueries({ queryKey: queryKey(id), exact: true, type: "all" });
        }
      }
      throw cause;
    }
  }, [captureTargetRead, isCurrentTargetRead, isTargetReadable, mutations.isCurrentScope, mutations.scopeToken, queryClient, queryKey, strings]);
  const moveProject = useCallback(async (id: number, input: Parameters<typeof api.moveProject>[1]) => {
    const result = await mutateProject(id, () => api.moveProject(id, input), false, project => project);
    bump();
    return result;
  }, [bump, mutateProject]);
  const convertProjectToTask = useCallback(async (id: number, input: ConvertStoryToTaskInput) => {
    const result = await mutateProject(id, () => api.convertStoryToTask(id, input), true);
    bump();
    return result;
  }, [bump, mutateProject]);
  const createProjectTaskBatch = useCallback(async (id: number, input: CreateTaskStepBatchInput) => {
    const result = await mutateProject(id, () => api.createTaskStepBatchForProject(id, input), false, batch => batch.project);
    const current = getCachedProject(id);
    if (current && current.revision <= result.project.revision) {
      queryClient.setQueryData<ProjectDetail>(queryKey(id), {
        ...current,
        ...projectMetadata(result.project),
        tasks: [...new Map([...current.tasks, ...result.tasks].map(task => [task.id, task])).values()],
      });
    }
    bump();
    return result;
  }, [bump, getCachedProject, mutateProject, queryClient, queryKey]);
  const deleteProject = useCallback(async (id: number, deleteTasks: boolean) => {
    const result = await mutateProject(id, () => api.deleteProject(id, { deleteTasks }), true);
    bump();
    return result;
  }, [bump, mutateProject]);

  const invalidationVersion = useRef(version);
  useEffect(() => {
    if (invalidationVersion.current === version) return;
    invalidationVersion.current = version;
    void queryClient.invalidateQueries({ queryKey: projectQueryKeys.identity(identityKey) });
  }, [identityKey, queryClient, version]);

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
        mutate: () => mutateProject(story.id, () => call(story, action, ownerMemberId, activationResolution, expectedRevision, workflowInput), false, project => project),
        throwOnError,
      });
    },
    [call, mutateProject, run],
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
          mutateProject(story.id, () => api.updateProject(story.id, {
            ...patch,
            expectedRevision: patch.expectedRevision ?? story.revision,
          }), false, project => project),
          refreshImmediately: true,
          throwOnError,
      }),
    [mutateProject, run],
  );

  const appendNotes = useCallback((story: ProjectWithActions, content: string) => run({
    id: story.id, optimistic: { story }, mutate: () => mutateProject(story.id, () => api.appendProjectNotes(story.id, content), false, project => project),
    refreshImmediately: true, throwOnError: true,
  }), [mutateProject, run]);

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
          mutateProject(story.id, () => api.returnProjectToBacklog(story.id, {
            expectedRevision: story.revision,
            revisitAt,
            withdrawCommitments,
            ...(expectedTaskRevisions !== undefined ? { expectedTaskRevisions } : {}),
          }), false, project => project),
        throwOnError: true,
      }),
    [mutateProject, run],
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
          mutateProject(story.id, () => api.acknowledgeProjectReview(story.id, {
            expectedRevision: story.revision,
          }), false, project => project),
        refreshImmediately: true,
      });
      if (result) setAcknowledgedReviewIds(current => new Set(current).add(story.id));
      return result;
    },
    [mutateProject, run],
  );

  return {
    acknowledgedReviewIds,
    identityKey,
    queryKey,
    queryMeta,
    fetchProject,
    getCachedProject,
    getCachedStory,
    reconcileProjectSnapshot,
    readProject,
    getProject,
    moveProject,
    convertProjectToTask,
    createProjectTaskBatch,
    deleteProject,
    captureTargetRead,
    isCurrentTargetRead,
    isCurrentProjectRead,
    isTargetReadable,
    scopeToken: mutations.scopeToken,
    isCurrentScope: mutations.isCurrentScope,
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

export function useProjectDetailQuery(id: number, enabled = true) {
  const actions = useProjectActions();
  const strings = useStrings();
  const queryClient = useQueryClient();
  const queryKey = actions.queryKey(id);
  const queryHash = JSON.stringify(queryKey);
  const [stickyError, setStickyError] = useState<{ key: string; cause: unknown } | null>(null);
  const query = useQuery<ProjectWithActions>({
    queryKey,
    queryFn: ({ signal }) => actions.fetchProject(id, signal),
    enabled,
    retry: false,
    gcTime: Infinity,
    structuralSharing: projectStructuralSharing,
    meta: actions.queryMeta(id),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  useEffect(() => {
    setStickyError(previous => previous?.key === queryHash ? previous : null);
    const existing = queryClient.getQueryCache().find({ queryKey, exact: true });
    if (existing?.state.error) setStickyError({ key: queryHash, cause: existing.state.error });
    return queryClient.getQueryCache().subscribe(event => {
      if (JSON.stringify(event.query.queryKey) !== queryHash || event.type !== "updated") return;
      if (event.action.type === "error") {
        setStickyError({ key: queryHash, cause: event.action.error });
      } else if (event.action.type === "success" && event.action.manual !== true) {
        const data = event.query.state.data as ProjectWithActions | undefined;
        if (data && isProjectDetail(data)) {
          setStickyError(previous => previous?.key === queryHash ? null : previous);
        }
      }
    });
  }, [queryClient, queryHash]);
  const denied = !actions.isTargetReadable(id);
  const visibleData = !denied && query.data && isProjectDetail(query.data) ? query.data : null;
  const errorCause = query.error ?? (stickyError?.key === queryHash ? stickyError.cause : null);
  return {
    ...query,
    data: visibleData,
    loading: query.isPending,
    refreshing: query.isFetching && visibleData !== null,
    errorCause: visibleData === null ? errorCause : null,
    refreshErrorCause: visibleData === null ? null : errorCause,
    error: visibleData === null && errorCause ? localizedErrorMessage(errorCause, strings) : null,
    refreshError: visibleData !== null && errorCause ? localizedErrorMessage(errorCause, strings) : null,
    reload: () => { void query.refetch(); },
  };
}

const ProjectActionsContext = createContext<ProjectActionsValue | null>(null);

/**
 * Mounts the single shared `useProjectActionsState()` instance for the
 * whole app (see `App.tsx`) so every consumer (Projekte tab, project
 * detail, Review, All) reads and mutates the
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
