import { useEffect, useMemo, useState } from "react";
import { useIdentity } from "../lib/identity";
import type { Task } from "@machbar/shared";
import type { WorkItemAncestor } from "@machbar/shared";
import type { ProjectWithActions } from "../lib/api";
import { api } from "../lib/api";
import type { TargetRead } from "../lib/useRetainedMutations";
import { useRefresh } from "../lib/refresh";
import { useStrings } from "../lib/strings";
import { sortByPosition } from "../lib/taskHelpers";
import { BottomSheet } from "./BottomSheet";
import { useAsync } from "../lib/useAsync";
import { useProjectActions } from "../lib/useProjectActions";
import { StepComposer, type StepDraft } from "./StepComposer";
import { ProjectActivationDecisionFields } from "./ProjectActivationDecisionFields";
import {
  projectActivationPromptFromSnapshot,
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
  onClose,
}: {
  project: ProjectWithActions & { ancestors?: WorkItemAncestor[] };
  onClose: () => void;
}) {
  const strings = useStrings();
  const projectActions = useProjectActions();
  const { currentMemberId } = useIdentity();
  const { bump } = useRefresh();
  const [projectSnapshot, setProjectSnapshot] = useState<TargetRead<typeof project>>(() => ({
    value: project, read: projectActions.captureTargetRead(project.id),
  }));
  const currentProject = projectSnapshot.value;
  const current = projectActions.isCurrentTargetRead(projectSnapshot.read);
  const [steps, setSteps] = useState<Task[] | null>(null);
  const [draftSteps, setDraftSteps] = useState<StepDraft[]>([]);
  const [addingStep, setAddingStep] = useState(false);
  const [activationState, setActivationState] = useState<{ fingerprint: string; prompt: ProjectActivationPrompt } | null>(null);
  const requestFingerprint = fingerprint(draftSteps);
  const activationPrompt = activationState?.fingerprint === requestFingerprint ? activationState.prompt : null;
  const activationResolution = activationPrompt ? projectActivationResolutionFromPrompt(activationPrompt) : null;
  const expectedProjectRevisions = useMemo(() => projectRevisionSnapshot(currentProject), [currentProject]);
  const { data: projectRead, error: projectLoadError } = useAsync(() => projectActions.readProject(project.id), [project.id, projectActions.scopeToken]);
  const projectDetail = projectRead && projectActions.isCurrentTargetRead(projectRead.read) ? projectRead : null;

  useEffect(() => {
    if (projectDetail) {
      setProjectSnapshot(projectDetail);
      setSteps(sortByPosition(projectDetail.value.tasks));
    }
  }, [projectDetail]);

  const refreshProject = async () => {
    const refreshed = await projectActions.readProject(project.id);
    if (!projectActions.isCurrentTargetRead(refreshed.read)) return;
    setProjectSnapshot(refreshed);
    setSteps(sortByPosition(refreshed.value.tasks));
  };

  const submitSteps = async (draft: StepDraft[]) => {
    if (!current) throw new Error(strings.workflowTargetUnavailable);
    const continuation = projectActions.captureTargetRead(project.id);
    try {
      const input = {
        steps: draft,
        expectedRevision: currentProject.revision,
        expectedProjectRevisions,
        ...(activationPrompt?.projects.length && activationResolution ? { activationResolution } : {}),
      };
      if (!activationPrompt && draft.some(step => step.dueDate || step.scheduledDate)) {
        const preview = await api.previewProjectSteps(project.id, input);
        if (!projectActions.isCurrentTargetRead(continuation)) return false;
        if (preview.activatingProjects.length) {
          setActivationState({ fingerprint: fingerprint(draft), prompt: projectActivationPromptFromSnapshot(preview.decision) });
          return false;
        }
      }
      if (!projectActions.isCurrentTargetRead(continuation)) return false;
      const saved = await api.createTaskStepBatchForProject(project.id, input);
      if (!projectActions.isCurrentTargetRead(continuation)) return false;
      setProjectSnapshot(previous => ({ value: { ...previous.value, ...saved.project }, read: continuation }));
      setSteps(previous => sortByPosition([...new Map([...(previous ?? []), ...saved.tasks].map(task => [task.id, task])).values()]));
      setActivationState(null);
      bump();
    } catch (cause) {
      if (!projectActions.isCurrentTargetRead(continuation)) return false;
      const prompt = projectActivationPromptFromError(cause, activationPrompt);
      if (prompt) setActivationState({ fingerprint: fingerprint(draft), prompt });
      else if ((cause as { code?: string })?.code === "stale_write_conflict") {
        setActivationState(null);
        try { await refreshProject(); } catch { /* keep the batch draft for a visible retry */ }
      }
      if (!projectActions.isCurrentTargetRead(continuation)) return false;
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
        {projectLoadError ? <p role="alert" className="task-row-error">{projectLoadError}</p> : null}
        {!current && !projectLoadError ? <p role="alert">{strings.workflowTargetUnavailable}</p> : null}
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
          submitDisabled={!current || (activationPrompt !== null && activationResolution === null)}
        />
        <p className="text-muted">{strings.projectTaskDraftHint}</p>
        <button type="button" className="btn btn-ghost btn-block" disabled={addingStep} onClick={onClose}>{strings.close}</button>
      </div>
    </BottomSheet>
  );
}
