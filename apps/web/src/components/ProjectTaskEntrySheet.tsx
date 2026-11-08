import { useEffect, useMemo, useState } from "react";
import { useIdentity } from "../lib/identity";
import { api } from "../lib/api";
import type { ProjectDetail } from "../lib/api";
import { useStrings } from "../lib/strings";
import { localizedErrorMessage } from "../lib/errorMessage";
import { isProjectDetail } from "../lib/projectQueries";
import { sortByPosition } from "../lib/taskHelpers";
import { BottomSheet } from "./BottomSheet";
import { ReadErrorState } from "./AsyncStates";
import { useProjectActions, useProjectDetailQuery } from "../lib/useProjectActions";
import { StepComposer, type StepDraft } from "./StepComposer";
import { ProjectActivationDecisionFields } from "./ProjectActivationDecisionFields";
import {
  projectActivationPromptFromSnapshot,
  projectActivationTargetIds,
  projectActivationPromptFromError,
  projectActivationResolutionFromPrompt,
  type ProjectActivationPrompt,
} from "../lib/projectActivationResolution";

function projectRevisionSnapshot(project: ProjectDetail) {
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
  projectId,
  onClose,
}: {
  projectId: number;
  onClose: () => void;
}) {
  const strings = useStrings();
  const projectActions = useProjectActions();
  const { currentMemberId } = useIdentity();
  const projectState = useProjectDetailQuery(projectId);
  const currentProject = projectState.data && isProjectDetail(projectState.data) &&
    projectActions.isCurrentProjectRead(projectState.data)
    ? projectState.data : null;
  const projectRead = projectActions.captureTargetRead(projectId);
  const current = currentProject !== null && projectActions.isCurrentTargetRead(projectRead);
  const [draftSteps, setDraftSteps] = useState<StepDraft[]>([]);
  const [addingStep, setAddingStep] = useState(false);
  const [failedProjectRead, setFailedProjectRead] = useState<{ id: number; error: string } | null>(null);
  const [activationState, setActivationState] = useState<{ fingerprint: string; prompt: ProjectActivationPrompt } | null>(null);
  const requestFingerprint = fingerprint(draftSteps);
  const storedActivationPrompt = activationState?.fingerprint === requestFingerprint ? activationState.prompt : null;
  const activationUnavailable = storedActivationPrompt?.readUnavailable ||
    (storedActivationPrompt?.isCurrentRead && !storedActivationPrompt.isCurrentRead());
  const activationPrompt = current && !activationUnavailable ? storedActivationPrompt : null;
  const activationResolution = activationPrompt ? projectActivationResolutionFromPrompt(activationPrompt) : null;
  const expectedProjectRevisions = useMemo(
    () => currentProject ? projectRevisionSnapshot(currentProject) : [],
    [currentProject],
  );

  useEffect(() => {
    if (!currentProject || !current) return;
    const affectedIds = new Set(projectActivationTargetIds(currentProject.id, currentProject.ancestors));
    setFailedProjectRead(previous =>
      previous && previous.id !== currentProject.id && affectedIds.has(previous.id) ? previous : null);
  }, [currentProject, current]);

  const refreshProject = async () => {
    const refreshed = await projectActions.getProject(projectId);
    if (!projectActions.isCurrentProjectRead(refreshed)) return;
  };

  const retryProjectRead = async () => {
    if (addingStep) return;
    if (!failedProjectRead || failedProjectRead.id === projectId || !currentProject || !current) { projectState.reload(); return; }
    setAddingStep(true);
    try {
      const latest = await projectActions.getProject(failedProjectRead.id, cause => {
        if (projectActions.isCurrentTargetRead(projectRead)) setFailedProjectRead({ id: failedProjectRead.id, error: localizedErrorMessage(cause, strings) });
      });
        if (projectActions.isCurrentTargetRead(projectRead) && projectActions.isCurrentProjectRead(latest)) setFailedProjectRead(null);
    } catch { /* Preserve the batch draft and the matching read failure. */ }
    finally { setAddingStep(false); }
  };

  const submitSteps = async (draft: StepDraft[]) => {
    if (!current || !currentProject) throw new Error(strings.workflowTargetUnavailable);
    const affectedIds = new Set(projectActivationTargetIds(projectId, currentProject.ancestors));
    const continuations = [...affectedIds].map(projectActions.captureTargetRead);
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
        const preview = await api.previewProjectSteps(projectId, input);
        if (!isCurrent()) return false;
        if (preview.activatingProjects.length) {
          setActivationState({ fingerprint: fingerprint(draft), prompt: {
            ...projectActivationPromptFromSnapshot(preview.decision, storedActivationPrompt),
            isCurrentRead: () => isCurrent() && (preview.decision?.projects ?? []).every(project => affectedIds.has(project.projectId)) &&
              (preview.decision?.expectedProjects ?? []).every(project => affectedIds.has(project.projectId)),
          } });
          return false;
        }
      }
      if (!isCurrent()) return false;
      const saved = await projectActions.createProjectTaskBatch(projectId, input);
      if (!isCurrent()) return false;
      setActivationState(null);
    } catch (cause) {
      if (!isCurrent()) return false;
      const prompt = projectActivationPromptFromError(cause, storedActivationPrompt);
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
          {(current && currentProject ? sortByPosition(currentProject.tasks) : []).map((step) => <li key={step.id} className="handoff-step-row">{step.title}</li>)}
        </ul>
        {activationPrompt ? (
          <ProjectActivationDecisionFields prompt={activationPrompt} disabled={addingStep} onChange={(prompt) =>
            setActivationState({ fingerprint: requestFingerprint, prompt })} />
        ) : null}
        <ReadErrorState resource={strings.project} {...projectState}
          error={projectState.error ?? failedProjectRead?.error ?? (!current && !projectState.loading ? strings.workflowTargetUnavailable : null)}
          refreshing={projectState.refreshing || addingStep} reload={() => void retryProjectRead()} />
        <StepComposer
          key={`project-${projectId}-member-${currentMemberId ?? "shared"}`}
          inputIdPrefix={`project-step-${projectId}`}
          label={strings.projectTasksTitle}
          placeholder={strings.splitTaskRowPlaceholder}
          submitLabel={strings.addProjectTaskCount}
          draftKey={`project-${projectId}-member-${currentMemberId ?? "shared"}`}
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
