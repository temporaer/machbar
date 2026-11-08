import { useRetentionInteraction } from "../lib/useRetentionInteraction";
import { useEffect, useRef } from "react";
import { type ProjectDetail } from "../lib/api";
import { useProjectActions, useProjectDetailQuery } from "../lib/useProjectActions";
import { useProjectWorkflow, type ProjectWorkflowState } from "../lib/projectWorkflowContext";
import { useIdentity } from "../lib/identity";
import { MemberSelectionSheet } from "./MemberSelectionSheet";
import { ProjectDeferSheet } from "./ProjectDeferSheet";
import { ProjectStructureSheet } from "./ProjectStructureSheet";
import { ProjectTagsSheet } from "./ProjectTagsSheet";
import { ProjectDeadlineSheet } from "./ProjectDeadlineSheet";
import { ProjectContextsSheet } from "./ProjectContextsSheet";
import { MoveProjectSheet } from "./MoveProjectSheet";
import { ProjectConvertToTaskSheet } from "./ProjectConvertToTaskSheet";
import { StoryCriteriaSheet } from "./StoryCriteriaSheet";
import { CompleteWithOpenTasksSheet } from "./CompleteWithOpenTasksSheet";
import { WorkClarificationSheet } from "./WorkClarificationSheet";
import { useStrings } from "../lib/strings";
import { canClearDriver } from "../lib/projectWorkflow";
import { ProjectActivationSheet } from "./ProjectActivationSheet";
import { useLocation, useNavigate } from "react-router-dom";
import type { WorkRefinementOrigin } from "../lib/taskDetailContext";
import { BottomSheet } from "./BottomSheet";
import { ErrorState, LoadingState, ReadErrorState } from "./AsyncStates";
import type { ProjectReadToken } from "../lib/projectQueries";

function flattenTaskRevisions(tasks: ProjectDetail["tasks"]): Array<{ taskId: number; revision: number }> {
  return tasks.flatMap((task) => [{ taskId: task.id, revision: task.revision }, ...flattenTaskRevisions(task.children)]);
}

/**
 * Project counterpart of `TaskWorkflowHost.tsx` — the single place that
 * imports every focused `story.*` sheet and switches on
 * `projectWorkflow.current?.kind`. Only `useWorkItemCommands()` may call
 * `projectWorkflow.open(...)`; rows, keyboard handlers, and project-detail
 * value clicks all just `dispatch()`.
 */
export function ProjectWorkflowHost() {
  const workflow = useProjectWorkflow();
  const strings = useStrings();
  const { members } = useIdentity();
  const projectActions = useProjectActions();
  const location = useLocation();
  const navigate = useNavigate();
  const state = workflow.current;
  const opening = useRef<{ state: ProjectWorkflowState | null; opener: HTMLElement | null; key: number; reads: ReadonlyMap<number, ProjectReadToken> }>({ state: null, opener: null, key: 0, reads: new Map() });
  if (opening.current.state !== state) {
    const knownAncestors = state?.kind === "deadline"
      ? state.ancestorProjectIds ??
        projectActions.getCachedProject(state.projectId)?.ancestors?.filter(ancestor => ancestor.role === "story").map(ancestor => ancestor.id) ?? []
      : [];
    opening.current = {
      state,
      opener: document.activeElement instanceof HTMLElement ? document.activeElement : null,
      key: opening.current.key + 1,
      reads: new Map<number, ProjectReadToken>([...new Set(knownAncestors)].map(id => [id, projectActions.captureTargetRead(id)])),
    };
  }
  const projectId = state?.projectId ?? null;
  const frameRead = projectId === null ? null : projectActions.captureTargetRead(projectId);
  const projectRead = useProjectDetailQuery(projectId ?? -1, projectId !== null);
  const fetchedProject = projectRead.data && projectActions.isCurrentProjectRead(projectRead.data) ? projectRead.data : null;
  useRetentionInteraction(projectId, projectActions.pauseRetention, projectId !== null);
  const retained = projectId !== null ? projectActions.retained.get(projectId)?.story : undefined;
  const accessLost = projectId !== null && !projectActions.isTargetReadable(projectId);
  const input = fetchedProject ?? (projectId !== null ? projectActions.getCachedStory(projectId) : undefined);
  const story = accessLost ? undefined : input ? projectActions.projectStory(input)
    : projectId !== null && projectActions.isTargetReadable(projectId) ? retained : undefined;

  if (!state) return null;
  const close = () => workflow.close(state);
  const reload = () => {
    if (workflow.isCurrent(state) && projectActions.isCurrentScope(projectActions.scopeToken)) projectRead.reload();
  };
  const sheetProps = {
    onClose: close,
    restoreFocusTo: opening.current.opener,
    headerStatus: projectRead.loading || projectRead.error !== null || projectRead.refreshError !== null ? <>
      {projectRead.loading ? <LoadingState /> : null}
      <ReadErrorState resource={story?.title ?? strings.project} {...projectRead} reload={reload} />
    </> : null,
  };
  if (!story || (state.kind === "completeWithDecisions" && !fetchedProject)) {
    const titles: Record<ProjectWorkflowState["kind"], string> = {
      defer: strings.deferProject, structure: strings.structure, refinement: strings.workRefinement,
      assignDriver: strings.assignDriver, editOutcome: strings.criteria, move: strings.moveProjectTitle,
      convertToTask: strings.convertProjectToTaskTitle, completeWithDecisions: strings.completeProjectAction,
      deadline: strings.projectDeadlineTitle, tags: strings.tags, contexts: strings.physicalContexts,
      activateWithDriver: strings.activateStory, reopenWithDriver: strings.reopen,
    };
    return <BottomSheet key={opening.current.key} {...sheetProps} title={titles[state.kind]}>
      {!projectRead.loading && projectRead.error === null && projectRead.refreshError === null
        ? <ErrorState message={strings.workflowTargetUnavailable} onRetry={reload} /> : null}
    </BottomSheet>;
  }

  switch (state.kind) {
    case "defer":
      return (
        <ProjectDeferSheet
          key={opening.current.key}
          {...sheetProps}
          story={story}
          onRefresh={reload}
          withdrawalReady={fetchedProject !== null}
          onSave={async (patch) => {
            if (patch.withdrawCommitments && !fetchedProject) {
              throw new Error(strings.readLoadFailed(story.title));
            }
            if (story.status === "active" || story.status === "archived") {
              const updated = await projectActions.returnToBacklog(
                fetchedProject ?? story,
                patch.revisitAt,
                patch.withdrawCommitments,
                fetchedProject ? flattenTaskRevisions(fetchedProject.tasks) : [],
              );
              return updated !== undefined;
            } else {
              return await projectActions.schedule(story, { revisitAt: patch.revisitAt }) !== undefined;
            }
          }}
        />
      );
    case "structure":
      return <ProjectStructureSheet key={opening.current.key} {...sheetProps} story={story} />;
    case "refinement":
      return <WorkClarificationSheet {...sheetProps} targetType="project" targetId={story.id} revision={story.revision} title={story.title} onStarted={(intakeId) => {
        if (!workflow.isCurrent(state) || !frameRead || !projectActions.isCurrentTargetRead(frameRead)) return;
        const refinementOrigin: WorkRefinementOrigin = { targetType: "project", targetId: story.id, originPath: `${location.pathname}${location.search}`, entry: "page" };
        close();
        navigate(`/intake/${intakeId}`, { state: { refinementOrigin } });
      }} key={opening.current.key} />;
    case "assignDriver":
      return (
        <MemberSelectionSheet
          key={opening.current.key}
          {...sheetProps}
          title={`${strings.assignDriver}: ${story.title}`}
          label={strings.driver}
          idPrefix={`project-workflow-driver-${story.id}`}
          members={members}
          value={story.ownerMemberId}
          unassignedLabel={canClearDriver(story) ? strings.noDriver : null}
          hint={canClearDriver(story) ? undefined : strings.driverLockedHint}
          onSelect={async (ownerMemberId) => {
            const continuation = projectActions.captureTargetRead(story.id);
            const updated = await projectActions.assignDriver(story, ownerMemberId);
            return updated !== undefined && projectActions.isCurrentTargetRead(continuation);
          }}
        />
      );
    case "editOutcome":
      return <StoryCriteriaSheet key={opening.current.key} {...sheetProps} story={story} />;
    case "move":
      return <MoveProjectSheet key={opening.current.key} {...sheetProps} story={story} />;
    case "convertToTask":
      return <ProjectConvertToTaskSheet key={opening.current.key} {...sheetProps} story={story} />;
    case "completeWithDecisions":
      if (!fetchedProject) return null;
      return (
        <CompleteWithOpenTasksSheet
          key={opening.current.key}
          {...sheetProps}
          story={fetchedProject}
          onRefresh={reload}
          onComplete={async (input) => {
            const continuation = projectActions.captureTargetRead(story.id);
            const updated = await projectActions.runAction(fetchedProject, "complete", undefined, undefined, true, undefined, input);
            return updated !== undefined && projectActions.isCurrentTargetRead(continuation);
          }}
        />
      );
    case "deadline":
      return (
        <ProjectDeadlineSheet
          key={opening.current.key}
          {...sheetProps}
          story={story}
          authoritativeProject={fetchedProject}
          qualifiedReads={opening.current.reads}
          onSave={async (patch) => {
            await projectActions.schedule(story, patch);
          }}
        />
      );
    case "tags":
      return (
        <ProjectTagsSheet
          key={opening.current.key}
          {...sheetProps}
          story={story}
          onSave={async (tagIds) => {
            await projectActions.update(story, { tagIds }, undefined, true);
          }}
        />
      );
    case "contexts":
      return <ProjectContextsSheet key={opening.current.key} {...sheetProps} story={story} />;
    case "activateWithDriver":
    case "reopenWithDriver": {
      const action = state.kind === "reopenWithDriver" ? "reopen" : "activate";
      return (
        <ProjectActivationSheet
          key={opening.current.key}
          {...sheetProps}
          story={story}
          action={action}
          authoritativeProject={fetchedProject}
          onActivate={(ownerMemberId, resolution, expectedRevision) =>
            projectActions.runAction(story, action, ownerMemberId, resolution, true, expectedRevision).then(result => result !== undefined)
          }
        />
      );
    }
    default:
      return null;
  }
}
