import { useEffect, useState } from "react";
import type { Task } from "@machbar/shared";
import { api, type CreateTaskStepBatchInput, type ProjectRevisionSnapshot } from "../lib/api";
import { localizedErrorMessage } from "../lib/errorMessage";
import { InteractionScopeProvider } from "../lib/interactionScope";
import { useRefresh } from "../lib/refresh";
import { useStrings } from "../lib/strings";
import { sortByPosition } from "../lib/taskHelpers";
import {
  projectActivationPromptFromSnapshot,
  projectActivationPromptFromError,
  projectActivationResolutionFromPrompt,
  type ProjectActivationPrompt,
} from "../lib/projectActivationResolution";
import { BottomSheet, type BottomSheetPresentationProps } from "./BottomSheet";
import { TaskOutline } from "./TaskOutline";
import { StepComposer, type StepDraft } from "./StepComposer";
import { ProjectActivationDecisionFields } from "./ProjectActivationDecisionFields";
import { useNavigate } from "react-router-dom";
import { useIdentity } from "../lib/identity";
import { useTaskDetail } from "../lib/taskDetailContext";
import { useTaskActions } from "../lib/useTaskActions";
import { useProjectActions } from "../lib/useProjectActions";
import type { TargetReadToken } from "../lib/useRetainedMutations";
import { useAsync } from "../lib/useAsync";
import { ReadErrorState } from "./AsyncStates";

function fingerprint(steps: StepDraft[], convert: boolean, projectId: number | null): string {
  return JSON.stringify({ steps, convert, projectId });
}

function projectRevisions(project: ProjectRevisionSnapshot) {
  const ancestors = (project.ancestors ?? [])
    .filter((ancestor) => ancestor.role === "story" && typeof ancestor.revision === "number")
    .map((ancestor) => ({ projectId: ancestor.id, revision: ancestor.revision! }));
  return [...ancestors, { projectId: project.id, revision: project.revision }];
}

/** The shared task-step workflow combines the existing outline organizer with
 * one atomic, revision-checked batch creation. */
export function TaskSplitSheet({
  parentId,
  parentTitle,
  parentRevision,
  parentStatus = "actionable",
  projectId = null,
  existingChildren = [],
  onClose,
  ...presentation
}: {
  parentId: number;
  parentTitle?: string;
  parentRevision?: number;
  parentStatus?: Task["status"];
  projectId?: number | null;
  existingChildren?: Task[];
  onClose: () => void;
} & BottomSheetPresentationProps) {
  const strings = useStrings();
  const taskActions = useTaskActions();
  const projectActions = useProjectActions();
  const navigate = useNavigate();
  const detail = useTaskDetail();
  const { currentMemberId } = useIdentity();
  const { bump } = useRefresh();
  const [draftSteps, setDraftSteps] = useState<StepDraft[]>([]);
  const [convertParent, setConvertParent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [activationState, setActivationState] = useState<{ fingerprint: string; prompt: ProjectActivationPrompt } | null>(null);
  const [projectSnapshot, setProjectSnapshot] = useState<{ value: ProjectRevisionSnapshot; read: TargetReadToken } | null>(null);
  const currentProject = projectSnapshot && projectActions.isCurrentTargetRead(projectSnapshot.read) ? projectSnapshot.value : null;
  const setCurrentProject = (value: ProjectRevisionSnapshot | null, read: TargetReadToken | null = null) => {
    setProjectSnapshot(value && read ? { value, read } : null);
  };
  const [parentRead, setParentRead] = useState(() => taskActions.captureTargetRead(parentId));
  const parentCurrent = taskActions.isCurrentTargetRead(parentRead);
  const [currentParentRevision, setCurrentParentRevision] = useState(parentRevision);
  const [currentParentStatus, setCurrentParentStatus] = useState(parentStatus);
  const [currentProjectId, setCurrentProjectId] = useState(projectId);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);

  const projectState = useAsync(() => currentProjectId === null ? Promise.resolve(null) : projectActions.readProject(currentProjectId),
    [currentProjectId, projectActions.scopeToken]);
  useEffect(() => {
    const received = projectState.data;
    if (currentProjectId === null) {
      setCurrentProject(null);
      setSnapshotError(null);
    } else if (received && projectActions.isCurrentTargetRead(received.read) && received.value.id === currentProjectId &&
      (!currentProject || received.value.revision >= currentProject.revision)) {
      setCurrentProject(received.value, received.read);
      setSnapshotError(null);
    }
  }, [projectState.data, currentProjectId]);

  const requestFingerprint = fingerprint(draftSteps, convertParent, currentProjectId);
  const activationPrompt = activationState?.fingerprint === requestFingerprint ? activationState.prompt : null;
  const activationUnavailable = activationPrompt?.readUnavailable || (activationPrompt?.isCurrentRead && !activationPrompt.isCurrentRead());
  const activationResolution = activationPrompt ? projectActivationResolutionFromPrompt(activationPrompt) : null;
  const expectedProjectRevisions = currentProjectId === null
    ? []
    : currentProject?.id === currentProjectId ? projectRevisions(currentProject) : null;

  const refreshSnapshots = async () => {
    let nextProjectId = currentProjectId;
    if (parentId > 0) {
      const task = await taskActions.readTask(parentId);
      if (!taskActions.isCurrentTargetRead(task.read)) return;
      setParentRead(task.read);
      setCurrentParentRevision(task.value.revision);
      setCurrentParentStatus(task.value.status);
      nextProjectId = task.value.projectId;
      setCurrentProjectId(nextProjectId);
    }
    if (nextProjectId === null) {
      setCurrentProject(null);
    } else {
      const project = await projectActions.readProject(nextProjectId);
      setCurrentProject(project.value, project.read);
    }
  };

  const submit = async (steps: StepDraft[]) => {
    if (!parentCurrent) return false;
    const taskContinuation = taskActions.captureTargetRead(parentId);
    const projectContinuation = currentProjectId !== null ? projectActions.captureTargetRead(currentProjectId) : null;
    const isCurrent = () => taskActions.isCurrentTargetRead(taskContinuation) &&
      (!projectContinuation || projectActions.isCurrentTargetRead(projectContinuation));
    if (currentParentRevision === undefined) throw new Error(strings.stepParentRevisionMissing);
    if (expectedProjectRevisions === null) throw new Error(strings.loading);
    const input: CreateTaskStepBatchInput = {
      steps,
      expectedRevision: currentParentRevision,
      expectedProjectRevisions: convertParent ? [] : expectedProjectRevisions,
      ...(convertParent ? { convertParentToProject: true } : {}),
      ...(activationPrompt?.projects.length && activationResolution ? { activationResolution } : {}),
    };
    try {
      if ((!activationPrompt || activationUnavailable) && (currentProjectId !== null || convertParent)) {
        const preview = await api.previewTaskSteps(parentId, input);
        if (!isCurrent()) return false;
        if (preview.activatingProjects.length) {
          setActivationState({ fingerprint: fingerprint(steps, convertParent, currentProjectId), prompt: {
            ...projectActivationPromptFromSnapshot(preview.decision, activationPrompt), isCurrentRead: isCurrent,
          } });
          return false;
        }
      }
      if (!isCurrent()) return false;
      const result = await api.createTaskStepBatchForTask(parentId, input);
      if (!isCurrent()) return false;
      if (result.parent) {
        setParentRead(taskContinuation);
        setCurrentParentRevision(result.parent.revision);
        setCurrentParentStatus(result.parent.status);
        setCurrentProjectId(result.parent.projectId);
        setCurrentProject(result.projectSnapshot ?? null, projectContinuation);
      }
      bump();
      setActivationState(null);
      if (result.convertedProject) {
        onClose();
        detail.close();
        navigate(`/projects/${result.convertedProject.id}`, { state: { createdProjectId: result.convertedProject.id } });
      }
    } catch (cause) {
      if (!isCurrent()) return false;
      const prompt = projectActivationPromptFromError(cause, activationPrompt);
      if (prompt) setActivationState({ fingerprint: fingerprint(steps, convertParent, currentProjectId), prompt: {
        ...prompt, isCurrentRead: isCurrent,
      } });
      else if ((cause as { code?: string })?.code === "stale_write_conflict") {
        setActivationState(null);
        try { await refreshSnapshots(); } catch (refreshCause) {
          setSnapshotError(localizedErrorMessage(refreshCause, strings));
        }
      }
      if (!isCurrent()) return false;
      throw cause;
    }
  };


  return (
    <BottomSheet {...presentation} title={strings.splitTask} onClose={() => !busy && onClose()}>
      <div className="stack task-split-outliner">
        {parentTitle ? <p className="text-muted">{parentTitle}</p> : null}
        {existingChildren.length > 0 ? (
          <div className="stack">
            <h3 className="task-split-section-heading">{strings.splitTaskExistingHeading}</h3>
            <InteractionScopeProvider>
              <TaskOutline tasks={sortByPosition(existingChildren)} emptyMessage={strings.noSubtasks} organizable showSwipeHint={false} />
            </InteractionScopeProvider>
          </div>
        ) : null}
        {currentProject?.title ? <p className="text-muted">{currentProject.title}</p> : null}
        {snapshotError ? <p role="alert" className="task-row-error">{snapshotError}</p> : null}
        {currentProjectId !== null ? <ReadErrorState resource={strings.project} {...projectState}
          error={projectState.error ?? (!currentProject && !projectState.loading ? strings.workflowTargetUnavailable : null)} /> : null}
        {currentParentStatus === "captured" ? (
          <label className="row">
            <input type="checkbox" checked={convertParent} disabled={busy}
              onChange={(event) => setConvertParent(event.target.checked)} />
            <span>{strings.stepTreatAsProject}</span>
          </label>
        ) : null}
        {activationPrompt ? (
          <ProjectActivationDecisionFields prompt={activationPrompt} disabled={busy} onChange={(prompt) =>
            setActivationState({ fingerprint: requestFingerprint, prompt })} />
        ) : null}
        <StepComposer
          key={`task-${parentId}-member-${currentMemberId ?? "shared"}`}
          inputIdPrefix={`task-step-${parentId}`}
          draftKey={`task-${parentId}-member-${currentMemberId ?? "shared"}`}
          label={strings.splitTaskAddHeading}
          placeholder={strings.splitTaskRowPlaceholder}
          submitLabel={strings.splitTaskCount(draftSteps.length)}
          onDraftChange={setDraftSteps}
          onPendingChange={setBusy}
          onSubmit={submit}
          onCancel={onClose}
          submitDisabled={!parentCurrent || expectedProjectRevisions === null || projectState.refreshing || (activationPrompt !== null && !activationUnavailable && activationResolution === null)}
        />
      </div>
    </BottomSheet>
  );
}
