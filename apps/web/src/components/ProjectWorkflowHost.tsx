import { useRetentionInteraction } from "../lib/useRetentionInteraction";
import { useEffect, useRef } from "react";
import { api, type ProjectDetail } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useProjectActions } from "../lib/useProjectActions";
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
import { isWorkItemAccessError } from "../lib/errorMessage";

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
  const opening = useRef<{ state: ProjectWorkflowState | null; opener: HTMLElement | null }>({ state: null, opener: null });
  if (opening.current.state !== state) {
    opening.current = { state, opener: document.activeElement instanceof HTMLElement ? document.activeElement : null };
  }
  const projectId = state?.projectId ?? null;
  const projectRead = useAsync(
    () => (projectId !== null ? api.getProject(projectId) : Promise.resolve(null)),
    [state, projectActions.scopeToken],
  );
  const fetchedProject = projectRead.data;
  useRetentionInteraction(projectId, projectActions.pauseRetention, projectId !== null);
  const retained = projectId !== null ? projectActions.retained.get(projectId)?.story : undefined;
  const accessLost = isWorkItemAccessError(projectRead.errorCause) || isWorkItemAccessError(projectRead.refreshErrorCause);
  const confirmed = projectId !== null ? projectActions.getConfirmedStory(projectId) : undefined;
  const input = fetchedProject ?? confirmed;
  const story = accessLost ? undefined : input ? projectActions.projectStory(input) : retained;
  useEffect(() => {
    if (projectId === null) return;
    if (accessLost) projectActions.invalidateConfirmedStory(projectId);
    else if (fetchedProject && projectRead.error === null && projectRead.refreshError === null) projectActions.observeConfirmedStory(fetchedProject, true);
  }, [projectId, accessLost, fetchedProject, projectRead.error, projectRead.refreshError, projectActions.invalidateConfirmedStory, projectActions.observeConfirmedStory]);

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
    return <BottomSheet {...sheetProps} title={titles[state.kind]}>
      {!projectRead.loading && projectRead.error === null && projectRead.refreshError === null
        ? <ErrorState message={strings.workflowTargetUnavailable} onRetry={reload} /> : null}
    </BottomSheet>;
  }

  switch (state.kind) {
    case "defer":
      return (
        <ProjectDeferSheet
          {...sheetProps}
          story={story}
          onRefresh={reload}
          withdrawalReady={fetchedProject !== null}
          onSave={async (patch) => {
            if (patch.withdrawCommitments && !fetchedProject) {
              throw new Error(strings.readLoadFailed(story.title));
            }
            if (story.status === "active" || story.status === "archived") {
              await projectActions.returnToBacklog(
                fetchedProject ?? story,
                patch.revisitAt,
                patch.withdrawCommitments,
                fetchedProject ? flattenTaskRevisions(fetchedProject.tasks) : [],
              );
            } else {
              await projectActions.schedule(story, { revisitAt: patch.revisitAt });
            }
          }}
        />
      );
    case "structure":
      return <ProjectStructureSheet {...sheetProps} story={story} />;
    case "refinement":
      return <WorkClarificationSheet {...sheetProps} targetType="project" targetId={story.id} revision={story.revision} title={story.title} onStarted={(intakeId) => {
        if (!workflow.isCurrent(state) || !projectActions.isCurrentScope(projectActions.scopeToken)) return;
        const refinementOrigin: WorkRefinementOrigin = { targetType: "project", targetId: story.id, originPath: `${location.pathname}${location.search}`, entry: "page" };
        close();
        navigate(`/intake/${intakeId}`, { state: { refinementOrigin } });
      }} />;
    case "assignDriver":
      return (
        <MemberSelectionSheet
          {...sheetProps}
          title={`${strings.assignDriver}: ${story.title}`}
          label={strings.driver}
          idPrefix={`project-workflow-driver-${story.id}`}
          members={members}
          value={story.ownerMemberId}
          unassignedLabel={canClearDriver(story) ? strings.noDriver : null}
          hint={canClearDriver(story) ? undefined : strings.driverLockedHint}
          onSelect={async (ownerMemberId) => {
            await projectActions.assignDriver(story, ownerMemberId);
          }}
        />
      );
    case "editOutcome":
      return <StoryCriteriaSheet {...sheetProps} story={story} />;
    case "move":
      return <MoveProjectSheet {...sheetProps} story={story} />;
    case "convertToTask":
      return <ProjectConvertToTaskSheet {...sheetProps} story={story} />;
    case "completeWithDecisions":
      if (!fetchedProject) return null;
      return (
        <CompleteWithOpenTasksSheet
          {...sheetProps}
          story={fetchedProject}
          onRefresh={reload}
          onComplete={async (input) => {
            await projectActions.runAction(fetchedProject, "complete", undefined, undefined, true, undefined, input);
          }}
        />
      );
    case "deadline":
      return (
        <ProjectDeadlineSheet
          {...sheetProps}
          story={story}
          onSave={async (patch) => {
            await projectActions.schedule(story, patch);
          }}
        />
      );
    case "tags":
      return (
        <ProjectTagsSheet
          {...sheetProps}
          story={story}
          onSave={async (tagIds) => {
            await projectActions.update(story, { tagIds }, undefined, true);
          }}
        />
      );
    case "contexts":
      return <ProjectContextsSheet {...sheetProps} story={story} />;
    case "activateWithDriver":
    case "reopenWithDriver": {
      const action = state.kind === "reopenWithDriver" ? "reopen" : "activate";
      return (
        <ProjectActivationSheet
          {...sheetProps}
          story={story}
          action={action}
          onActivate={(ownerMemberId, resolution, expectedRevision) =>
            projectActions.runAction(story, action, ownerMemberId, resolution, true, expectedRevision).then(() => undefined)
          }
        />
      );
    }
    default:
      return null;
  }
}
