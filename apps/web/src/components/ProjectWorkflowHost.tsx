import { useRef, useState } from "react";
import { useRetentionInteraction } from "../lib/useRetentionInteraction";
import { api, ApiError, type ProjectDetail } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useProjectActions } from "../lib/useProjectActions";
import { useProjectWorkflow } from "../lib/projectWorkflowContext";
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
  const lastOpening = useRef(workflow.current);
  const openingSequence = useRef(0);
  if (lastOpening.current !== workflow.current) {
    lastOpening.current = workflow.current;
    openingSequence.current += 1;
  }
  const openingId = workflow.current ? openingSequence.current : 0;
  const openingIdRef = useRef(openingId);
  openingIdRef.current = openingId;
  const workflowRef = useRef(workflow.current);
  workflowRef.current = workflow.current;
  const [activationReadState, setActivationReadState] = useState<{
    openingId: number;
    denied: boolean;
    authorityVersion: number;
    readVersion: number;
    readRevision: number | null;
  }>({ openingId: 0, denied: false, authorityVersion: 0, readVersion: 0, readRevision: null });
  const activationReadStateRef = useRef(activationReadState);
  const activationOpening = workflow.current?.kind === "activateWithDriver" ||
    workflow.current?.kind === "reopenWithDriver";
  const projectId = workflow.current?.projectId ?? null;
  const {
    data: fetchedProject,
    loading: projectLoading,
    error: projectError,
    refreshError: projectRefreshError,
    reload,
  } = useAsync(
    async () => {
      if (projectId === null) return null;
      try {
        const project = await api.getProject(projectId);
        return project;
      } catch (error) {
        if (
          activationOpening &&
          openingIdRef.current === openingId &&
          error instanceof ApiError &&
          (error.status === 403 || error.status === 404)
        ) {
          const current = activationReadStateRef.current;
          if (current.openingId !== openingId || !current.denied) {
            const denied = {
              openingId,
              denied: true,
              authorityVersion: current.openingId === openingId
                ? current.authorityVersion + 1
                : 1,
              readVersion: current.openingId === openingId ? current.readVersion : 0,
              readRevision: current.openingId === openingId ? current.readRevision : null,
            };
            activationReadStateRef.current = denied;
            setActivationReadState(denied);
          }
        }
        throw error;
      }
    },
    activationOpening ? [projectId, openingId] : [projectId],
    {
      clearDataOnError: (error) =>
        activationOpening &&
        error instanceof ApiError &&
        (error.status === 403 || error.status === 404),
      onAcceptedResult: (project) => {
        if (
          !activationOpening ||
          projectId === null ||
          project === null ||
          project.id !== projectId ||
          openingIdRef.current !== openingId
        ) return;
        const current = activationReadStateRef.current;
        const readable = {
          openingId,
          denied: false,
          authorityVersion: current.openingId === openingId ? current.authorityVersion : 0,
          readVersion: current.openingId === openingId ? current.readVersion + 1 : 1,
          readRevision: project.revision,
        };
        activationReadStateRef.current = readable;
        setActivationReadState(readable);
      },
    },
  );
  useRetentionInteraction(projectId, projectActions.pauseRetention, projectId !== null);
  const retained = projectId !== null ? projectActions.retained.get(projectId)?.story : undefined;
  const story = fetchedProject ? projectActions.projectStory(fetchedProject) : retained;

  if (!workflow.current) return null;
  const close = workflow.close;
  if (activationOpening) {
    const action = workflow.current.kind === "reopenWithDriver" ? "reopen" : "activate";
    const readState = activationReadState.openingId === openingId
      ? activationReadState
      : { openingId, denied: false, authorityVersion: 0, readVersion: 0, readRevision: null };
    const activationStory = readState.denied || !fetchedProject
      ? null
      : projectActions.projectStory(fetchedProject);
    const openingState = workflow.current;
    const sameOpeningAtVersion = (authorityVersion: number) => {
      const currentRead = activationReadStateRef.current.openingId === openingId
        ? activationReadStateRef.current
        : null;
      return workflowRef.current === openingState &&
        openingIdRef.current === openingId &&
        (currentRead?.authorityVersion ?? 0) === authorityVersion;
    };
    const currentAuthorityReadVersion = (
      authorityVersion: number,
      expectedReadVersion?: number,
      responseRevision?: number,
    ): number | null => {
      const currentRead = activationReadStateRef.current.openingId === openingId
        ? activationReadStateRef.current
        : null;
      if (!sameOpeningAtVersion(authorityVersion) || currentRead?.denied === true) return null;
      if (expectedReadVersion !== undefined) {
        if (!currentRead) return null;
        const sameRead = currentRead.readVersion === expectedReadVersion;
        const newerResponse = responseRevision !== undefined &&
          currentRead.readRevision !== null &&
          responseRevision > currentRead.readRevision;
        if (!sameRead && !newerResponse) return null;
      }
      return currentRead?.readVersion ?? 0;
    };
    const closeActivation = () => {
      if (workflowRef.current === openingState && openingIdRef.current === openingId) close();
    };
    const completeActivation = () => {
      if (currentAuthorityReadVersion(readState.authorityVersion) !== null) close();
    };
    return (
      <ProjectActivationSheet
        key={openingId}
        story={activationStory}
        action={action}
        loading={activationStory === null && projectLoading}
        readError={projectRefreshError ?? projectError}
        onRetry={() => {
          if (sameOpeningAtVersion(readState.authorityVersion)) reload();
        }}
        openingId={openingId}
        authorityVersion={readState.authorityVersion}
        readVersion={readState.readVersion}
        currentAuthorityReadVersion={currentAuthorityReadVersion}
        onClose={closeActivation}
        onActivationSuccess={completeActivation}
        onActivate={(ownerMemberId, resolution, expectedRevision) =>
          activationStory
            ? projectActions.runAction(activationStory, action, ownerMemberId, resolution, true, expectedRevision).then(() => undefined)
            : Promise.reject(new Error("Project is not currently readable."))
        }
      />
    );
  }
  if (!story) return null;

  switch (workflow.current.kind) {
    case "defer":
      return (
        <ProjectDeferSheet
          story={story}
          onClose={close}
          onRefresh={reload}
          onSave={async (patch) => {
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
      return <ProjectStructureSheet story={story} onClose={close} />;
    case "refinement":
      return <WorkClarificationSheet targetType="project" targetId={story.id} revision={story.revision} title={story.title} onClose={close} onStarted={(intakeId) => {
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
            await projectActions.assignDriver(story, ownerMemberId);
          }}
        />
      );
    case "editOutcome":
      return <StoryCriteriaSheet story={story} onClose={close} />;
    case "move":
      return <MoveProjectSheet story={story} onClose={close} />;
    case "convertToTask":
      return <ProjectConvertToTaskSheet story={story} onClose={close} />;
    case "completeWithDecisions":
      if (!fetchedProject) return null;
      return (
        <CompleteWithOpenTasksSheet
          story={fetchedProject}
          onClose={close}
          onRefresh={reload}
          onComplete={async (input) => {
            await projectActions.runAction(fetchedProject, "complete", undefined, undefined, true, undefined, input);
          }}
        />
      );
    case "deadline":
      return (
        <ProjectDeadlineSheet
          story={story}
          onClose={close}
          onSave={async (patch) => {
            await projectActions.schedule(story, patch);
          }}
        />
      );
    case "tags":
      return (
        <ProjectTagsSheet
          story={story}
          onClose={close}
          onSave={async (tagIds) => {
            await projectActions.update(story, { tagIds }, undefined, true);
          }}
        />
      );
    case "contexts":
      return <ProjectContextsSheet story={story} onClose={close} />;
    case "activateWithDriver":
    case "reopenWithDriver":
      return null;
    default:
      return null;
  }
}
