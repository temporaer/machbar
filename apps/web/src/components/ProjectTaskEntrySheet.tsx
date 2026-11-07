import { useEffect, useMemo, useState } from "react";
import { useIdentity } from "../lib/identity";
import type { Task } from "@machbar/shared";
import type { WorkItemAncestor } from "@machbar/shared";
import type { ProjectWithActions } from "../lib/api";
import { api } from "../lib/api";
import type { TargetRead, TargetReadToken } from "../lib/useRetainedMutations";
import { useRefresh } from "../lib/refresh";
import { useStrings } from "../lib/strings";
import { localizedErrorMessage } from "../lib/errorMessage";
import { sortByPosition } from "../lib/taskHelpers";
import { BottomSheet } from "./BottomSheet";
import { useAsync } from "../lib/useAsync";
import { ReadErrorState } from "./AsyncStates";
import { useProjectActions } from "../lib/useProjectActions";
import { StepComposer, type StepDraft } from "./StepComposer";
import { ProjectActivationDecisionFields } from "./ProjectActivationDecisionFields";
import {
  projectActivationPromptFromSnapshot,
  projectActivationTargetIds,
  projectActivationPromptFromError,
  projectActivationResolutionFromPrompt,
  type ProjectActivationPrompt,
} from "../lib/projectActivationResolution";

function projectRevisionSnapshot(project: ProjectWithActions & { ancestors?: WorkItemAncestor[] }) {
  const ancestors = (project.ancestors ?? [])
    .filter((ancestor) => ancestor.role === "story" && typeof ancestor.revision === "number")
    .map((ancestor) => ({ projectId: ancestor.id, revision: ancestor.revision! }));
  return [...ancestors, { projectId: project.id, revision: project.revision }];
}

function fingerprint(steps: StepDraft[]) {
  return JSON.stringify(steps);
}

/** Explicit project-owned task entry. Creation/conversion has already finished. */
export function ProjectTaskEntrySheet({
  project,
  initialRead,
  onClose,
}: {
  project: ProjectWithActions & { ancestors?: WorkItemAncestor[] };
  initialRead?: TargetReadToken;
  onClose: () => void;
}) {
  const strings = useStrings();
  const projectActions = useProjectActions();
  const { currentMemberId } = useIdentity();
  const { bump } = useRefresh();
  const [projectSnapshot, setProjectSnapshot] = useState<TargetRead<typeof project>>(() => ({
    value: project, read: initialRead ?? projectActions.captureTargetRead(project.id),
  }));
  const currentProject = projectSnapshot.value;
  const current = projectActions.isCurrentTargetRead(projectSnapshot.read);
  const [steps, setSteps] = useState<Task[] | null>(null);
  const [draftSteps, setDraftSteps] = useState<StepDraft[]>([]);
  const [addingStep, setAddingStep] = useState(false);
  const [failedProjectRead, setFailedProjectRead] = useState<{ id: number; error: string } | null>(null);
  const [activationState, setActivationState] = useState<{ fingerprint: string; prompt: ProjectActivationPrompt } | null>(null);
  const requestFingerprint = fingerprint(draftSteps);
  const activationPrompt = activationState?.fingerprint === requestFingerprint ? activationState.prompt : null;
  const activationUnavailable = activationPrompt?.readUnavailable || (activationPrompt?.isCurrentRead && !activationPrompt.isCurrentRead());
  const activationResolution = activationPrompt ? projectActivationResolutionFromPrompt(activationPrompt) : null;
  const expectedProjectRevisions = useMemo(() => projectRevisionSnapshot(currentProject), [currentProject]);
  const projectState = useAsync(() => projectActions.readProject(project.id), [project.id, projectActions.scopeToken]);
  const projectRead = projectState.data;
  const projectDetail = projectRead && projectActions.isCurrentTargetRead(projectRead.read) ? projectRead : null;

  useEffect(() => {
    if (projectDetail && projectActions.isCurrentTargetRead(projectDetail.read)) {
      if (projectDetail.value.revision < currentProject.revision) return;
      setProjectSnapshot(projectDetail);
      setSteps(sortByPosition(projectDetail.value.tasks));
      const affectedIds = new Set(projectActivationTargetIds(projectDetail.value.id, projectDetail.value.ancestors));
      setFailedProjectRead(previous => previous && previous.id !== projectDetail.value.id && affectedIds.has(previous.id) ? previous : null);
    }
  }, [projectDetail]);

  const refreshProject = async () => {
    const refreshed = await projectActions.readProject(project.id);
    if (!projectActions.isCurrentTargetRead(refreshed.read)) return;
    setProjectSnapshot(refreshed);
    setSteps(sortByPosition(refreshed.value.tasks));
  };

  const retryProjectRead = async () => {
    if (addingStep) return;
    if (!failedProjectRead || failedProjectRead.id === project.id || !current) { projectState.reload(); return; }
    if (addingStep || !current) return;
    setAddingStep(true);
    try {
      const latest = await projectActions.getProject(failedProjectRead.id, cause => {
        if (projectActions.isCurrentTargetRead(projectSnapshot.read)) setFailedProjectRead({ id: failedProjectRead.id, error: localizedErrorMessage(cause, strings) });
      });
      if (projectActions.isCurrentTargetRead(projectSnapshot.read) && projectActions.isCurrentProjectRead(latest)) setFailedProjectRead(null);
    } catch { /* Preserve the batch draft and the matching read failure. */ }
    finally { setAddingStep(false); }
  };

  const submitSteps = async (draft: StepDraft[]) => {
    if (!current) throw new Error(strings.workflowTargetUnavailable);
    const affectedIds = new Set(projectActivationTargetIds(project.id, currentProject.ancestors));
    const continuations = [...affectedIds].map(projectActions.captureTargetRead);
    const continuation = continuations.find(read => read.id === project.id)!;
    const isCurrent = () => continuations.every(projectActions.isCurrentTargetRead);
    try {
      for (const id of affectedIds) {
        if (!projectActions.isTargetReadable(id)) {
          const current = await projectActions.getProject(id, cause => {
            if (isCurrent()) setFailedProjectRead({ id, error: localizedErrorMessage(cause, strings) });
          });
          if (!isCurrent() || !projectActions.isCurrentProjectRead(current)) return false;
        }
      }
      const input = {
        steps: draft,
        expectedRevision: currentProject.revision,
        expectedProjectRevisions,
        ...(activationPrompt?.projects.length && activationResolution ? { activationResolution } : {}),
      };
      if ((!activationPrompt && draft.some(step => step.dueDate || step.scheduledDate)) || activationUnavailable) {
        const preview = await api.previewProjectSteps(project.id, input);
        if (!isCurrent()) return false;
        if (preview.activatingProjects.length) {
          setActivationState({ fingerprint: fingerprint(draft), prompt: {
            ...projectActivationPromptFromSnapshot(preview.decision, activationPrompt),
            isCurrentRead: () => isCurrent() && (preview.decision?.projects ?? []).every(project => affectedIds.has(project.projectId)) &&
              (preview.decision?.expectedProjects ?? []).every(project => affectedIds.has(project.projectId)),
          } });
          return false;
        }
      }
      if (!isCurrent()) return false;
      const saved = await api.createTaskStepBatchForProject(project.id, input);
      if (!isCurrent()) return false;
      setProjectSnapshot(previous => ({ value: { ...previous.value, ...saved.project }, read: continuation }));
      setSteps(previous => sortByPosition([...new Map([...(previous ?? []), ...saved.tasks].map(task => [task.id, task])).values()]));
      setActivationState(null);
      bump();
    } catch (cause) {
      if (!isCurrent()) return false;
      const prompt = projectActivationPromptFromError(cause, activationPrompt);
      if (prompt) setActivationState({ fingerprint: fingerprint(draft), prompt: {
        ...prompt, isCurrentRead: () => isCurrent() && prompt.projects.every(project => affectedIds.has(project.projectId)) &&
          prompt.expectedProjects.every(project => affectedIds.has(project.projectId)),
      } });
      else if ((cause as { code?: string })?.code === "stale_write_conflict") {
        setActivationState(null);
        try { await refreshProject(); } catch { /* keep the batch draft for a visible retry */ }
      }
      if (!isCurrent()) return false;
      throw cause;
    }
  };

  return (
    <BottomSheet title={strings.projectTasksTitle} onClose={() => !addingStep && onClose()}>
      <p className="text-muted">{strings.oneTaskPerLine}</p>
      <div className="stack">
        <ul className="handoff-steps-list" aria-label={strings.projectSteps}>
          {(current ? steps ?? [] : []).map((step) => <li key={step.id} className="handoff-step-row">{step.title}</li>)}
        </ul>
        {activationPrompt ? (
          <ProjectActivationDecisionFields prompt={activationPrompt} disabled={addingStep} onChange={(prompt) =>
            setActivationState({ fingerprint: requestFingerprint, prompt })} />
        ) : null}
        <ReadErrorState resource={strings.project} {...projectState}
          error={projectState.error ?? failedProjectRead?.error ?? (!current && !projectState.loading ? strings.workflowTargetUnavailable : null)}
          refreshing={projectState.refreshing || addingStep} reload={() => void retryProjectRead()} />
        <StepComposer
          key={`project-${project.id}-member-${currentMemberId ?? "shared"}`}
          inputIdPrefix={`project-step-${project.id}`}
          label={strings.projectTasksTitle}
          placeholder={strings.splitTaskRowPlaceholder}
          submitLabel={strings.addProjectTaskCount}
          draftKey={`project-${project.id}-member-${currentMemberId ?? "shared"}`}
          onDraftChange={setDraftSteps}
          onPendingChange={setAddingStep}
          onSubmit={submitSteps}
          submitDisabled={!current || failedProjectRead !== null || addingStep || projectState.refreshing || (activationPrompt !== null && !activationUnavailable && activationResolution === null)}
        />
        <p className="text-muted">{strings.projectTaskDraftHint}</p>
        <button type="button" className="btn btn-ghost btn-block" disabled={addingStep} onClick={onClose}>{strings.close}</button>
      </div>
    </BottomSheet>
  );
}
