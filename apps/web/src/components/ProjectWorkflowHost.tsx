import { useLayoutEffect, useRef, useState } from "react";
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
import { isReadAccessError, isStaleWriteConflict, localizedErrorMessage } from "../lib/errorMessage";

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
  const { currentMemberId } = useIdentity();
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const current = useRef({ opening: workflow.current, currentMemberId });
  current.current = { opening: workflow.current, currentMemberId };
  const lastOpening = useRef(workflow.current);
  const sequence = useRef(0);
  if (lastOpening.current !== workflow.current) {
    lastOpening.current = workflow.current;
    sequence.current += 1;
  }
  if (!workflow.current) return null;
  const opening = workflow.current;
  return <ProjectWorkflowContent
    key={`${currentMemberId}:${sequence.current}`}
    opening={opening}
    isCurrent={() => mounted.current && current.current.opening === opening && current.current.currentMemberId === currentMemberId}
  />;
}

function ProjectWorkflowContent({
  opening,
  isCurrent,
}: {
  opening: ProjectWorkflowState;
  isCurrent: () => boolean;
}) {
  const workflow = useProjectWorkflow();
  const strings = useStrings();
  const { members } = useIdentity();
  const projectActions = useProjectActions();
  const location = useLocation();
  const navigate = useNavigate();
  const [endedError, setEndedError] = useState<string | null>(null);
  const [requirementsEpoch, setRequirementsEpoch] = useState(0);
  const ended = useRef(false);
  const endOnDenied = (cause: unknown) => {
    if (isCurrent() && isReadAccessError(cause)) {
      ended.current = true;
      setEndedError(localizedErrorMessage(cause, strings));
    }
  };
  const run = async (command: () => Promise<unknown>) => {
    try {
      await command();
    } catch (cause) {
      endOnDenied(cause);
      if (isCurrent() && !ended.current && isStaleWriteConflict(cause) &&
        (opening.kind === "completeWithDecisions" || opening.kind === "defer")) {
        setRequirementsEpoch((value) => value + 1);
      }
      throw cause;
    }
  };
  const projectId = opening.projectId;
  const {
    data: story,
    loading: projectLoading,
    error: projectError,
    refreshError: projectRefreshError,
    reload,
  } = useAsync(
    async () => {
      try {
        if (ended.current) return null;
        return await api.getProject(projectId);
      } catch (error) {
        endOnDenied(error);
        throw error;
      }
    },
    [projectId, requirementsEpoch],
  );
  const dismiss = () => { if (isCurrent()) workflow.close(); };
  const close = () => { if (!ended.current) dismiss(); };
  if (endedError || !story && projectError) {
    return <BottomSheet title={strings.error} onClose={dismiss}>
      <div className="stack">
        {endedError || projectError ? <p role="alert">{endedError ?? projectError}</p> : requirementsEpoch > 0 ? <p role="alert">{strings.activationRequirementsChanged}</p> : null}
        {!endedError && projectLoading ? <p role="status">{strings.loading}</p> : null}
        {!endedError && projectError ? <button className="btn" onClick={reload}>{strings.retry}</button> : null}
        <button className="btn" onClick={dismiss}>{strings.close}</button>
      </div>
    </BottomSheet>;
  }
  if (opening.kind === "activateWithDriver" || opening.kind === "reopenWithDriver") {
    const action = opening.kind === "reopenWithDriver" ? "reopen" : "activate";
    return (
      <ProjectActivationSheet
        key={requirementsEpoch}
        story={story}
        loading={projectLoading}
        action={action}
        readError={projectRefreshError ?? projectError}
        requirementsChanged={requirementsEpoch > 0}
        onRetry={reload}
        onRequirementsChanged={() => {
          if (!isCurrent() || ended.current) return;
          setRequirementsEpoch((value) => value + 1);
        }}
        isCurrent={() => isCurrent() && !ended.current}
        onClose={close}
        onActivationSuccess={close}
        onActivate={(ownerMemberId, resolution, expectedRevision) =>
          story
            ? run(() => projectActions.runAction(story, action, ownerMemberId, resolution, true, expectedRevision))
            : Promise.resolve()
        }
      />
    );
  }
  if (!story) return projectLoading ? <p role="status">{strings.loading}</p> : null;

  switch (opening.kind) {
    case "defer":
      return (
        <ProjectDeferSheet
          story={story}
          onClose={close}
          onRefresh={reload}
          onSave={async (patch) => {
            if (story.status === "active" || story.status === "archived") {
              await run(() => projectActions.returnToBacklog(
                story,
                patch.revisitAt,
                patch.withdrawCommitments,
                flattenTaskRevisions(story.tasks),
              ));
            } else {
              await run(() => projectActions.schedule(story, { revisitAt: patch.revisitAt }));
            }
          }}
        />
      );
    case "structure":
      return <ProjectStructureSheet story={story} onClose={close} />;
    case "refinement":
      return <WorkClarificationSheet targetType="project" targetId={story.id} revision={story.revision} title={story.title} onClose={close} onFailure={endOnDenied} onStarted={(intakeId) => {
        if (!isCurrent() || ended.current) return;
        const refinementOrigin: WorkRefinementOrigin = { targetType: "project", targetId: story.id, originPath: `${location.pathname}${location.search}`, entry: "page" };
        close();
        navigate(`/intake/${intakeId}`, { state: { refinementOrigin } });
      }} />;
    case "assignDriver":
      return (
        <MemberSelectionSheet
          title={`${strings.assignDriver}: ${story.title}`}
          label={strings.driver}
          idPrefix={`project-workflow-driver-${story.id}`}
          members={members}
          value={story.ownerMemberId}
          unassignedLabel={canClearDriver(story) ? strings.noDriver : null}
          hint={canClearDriver(story) ? undefined : strings.driverLockedHint}
          onClose={close}
          onSelect={async (ownerMemberId) => {
            await run(() => projectActions.assignDriver(story, ownerMemberId));
          }}
        />
      );
    case "editOutcome":
      return <StoryCriteriaSheet story={story} onClose={close} onFailure={endOnDenied} />;
    case "move":
      return <MoveProjectSheet story={story} onClose={close} onFailure={endOnDenied} isCurrent={() => isCurrent() && !ended.current} />;
    case "convertToTask":
      return <ProjectConvertToTaskSheet story={story} onClose={close} onFailure={endOnDenied} isCurrent={() => isCurrent() && !ended.current} />;
    case "completeWithDecisions":
      return (
        <CompleteWithOpenTasksSheet
          story={story}
          onClose={close}
          onRefresh={reload}
          onComplete={async (input) => {
            await run(() => projectActions.runAction(story, "complete", undefined, undefined, true, undefined, input));
          }}
        />
      );
    case "deadline":
      return (
        <ProjectDeadlineSheet
          story={story}
          onClose={close}
          onFailure={endOnDenied}
          onSave={async (patch) => {
            await run(() => projectActions.schedule(story, patch));
          }}
        />
      );
    case "tags":
      return (
        <ProjectTagsSheet
          story={story}
          onClose={close}
          onFailure={endOnDenied}
          onSave={async (tagIds) => {
            await run(() => projectActions.update(story, { tagIds }, true));
          }}
        />
      );
    case "contexts":
      return <ProjectContextsSheet story={story} onClose={close} onFailure={endOnDenied} />;
    default:
      return null;
  }
}
