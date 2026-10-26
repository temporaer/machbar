import { useEffect, useMemo, useState } from "react";
import { useIdentity } from "../lib/identity";
import type { Task } from "@machbar/shared";
import type { WorkItemAncestor } from "@machbar/shared";
import type { ProjectWithActions } from "../lib/api";
import { api } from "../lib/api";
import { useRefresh } from "../lib/refresh";
import { useStrings } from "../lib/strings";
import { sortByPosition } from "../lib/taskHelpers";
import { BottomSheet } from "./BottomSheet";
import { useAsync } from "../lib/useAsync";
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
  const { currentMemberId } = useIdentity();
  const { bump } = useRefresh();
  const [currentProject, setCurrentProject] = useState(project);
  const [steps, setSteps] = useState<Task[] | null>(null);
  const [draftSteps, setDraftSteps] = useState<StepDraft[]>([]);
  const [addingStep, setAddingStep] = useState(false);
  const [activationState, setActivationState] = useState<{ fingerprint: string; prompt: ProjectActivationPrompt } | null>(null);
  const requestFingerprint = fingerprint(draftSteps);
  const activationPrompt = activationState?.fingerprint === requestFingerprint ? activationState.prompt : null;
  const activationResolution = activationPrompt ? projectActivationResolutionFromPrompt(activationPrompt) : null;
  const expectedProjectRevisions = useMemo(() => projectRevisionSnapshot(currentProject), [currentProject]);
  const { data: projectDetail, error: projectLoadError } = useAsync(() => api.getProject(project.id), [project.id]);

  useEffect(() => {
    if (projectDetail) {
      const detail = projectDetail;
      setCurrentProject(detail);
      setSteps(sortByPosition(detail.tasks));
    }
  }, [projectDetail]);

  const refreshProject = async () => {
    const refreshed = await api.getProject(project.id);
    setCurrentProject(refreshed);
    setSteps(sortByPosition(refreshed.tasks));
  };

  const submitSteps = async (draft: StepDraft[]) => {
    try {
      const input = {
        steps: draft,
        expectedRevision: currentProject.revision,
        expectedProjectRevisions,
        ...(activationPrompt?.projects.length && activationResolution ? { activationResolution } : {}),
      };
      if (!activationPrompt && draft.some(step => step.dueDate || step.scheduledDate)) {
        const preview = await api.previewProjectSteps(project.id, input);
        if (preview.activatingProjects.length) {
          setActivationState({ fingerprint: fingerprint(draft), prompt: projectActivationPromptFromSnapshot(preview.decision) });
          return false;
        }
      }
      const saved = await api.createTaskStepBatchForProject(project.id, input);
      setCurrentProject(previous => ({ ...previous, ...saved.project }));
      setSteps(previous => sortByPosition([...new Map([...(previous ?? []), ...saved.tasks].map(task => [task.id, task])).values()]));
      setActivationState(null);
      bump();
    } catch (cause) {
      const prompt = projectActivationPromptFromError(cause, activationPrompt);
      if (prompt) setActivationState({ fingerprint: fingerprint(draft), prompt });
      else if ((cause as { code?: string })?.code === "stale_write_conflict") {
        setActivationState(null);
        try { await refreshProject(); } catch { /* keep the batch draft for a visible retry */ }
      }
      throw cause;
    }
  };

  return (
    <BottomSheet title={strings.projectTasksTitle} onClose={() => !addingStep && onClose()}>
      <p className="text-muted">{strings.oneTaskPerLine}</p>
      <div className="stack">
        <ul className="handoff-steps-list" aria-label={strings.projectSteps}>
          {(steps ?? []).map((step) => <li key={step.id} className="handoff-step-row">{step.title}</li>)}
        </ul>
        {activationPrompt ? (
          <ProjectActivationDecisionFields prompt={activationPrompt} disabled={addingStep} onChange={(prompt) =>
            setActivationState({ fingerprint: requestFingerprint, prompt })} />
        ) : null}
        {projectLoadError ? <p role="alert" className="task-row-error">{projectLoadError}</p> : null}
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
          submitDisabled={activationPrompt !== null && activationResolution === null}
        />
        <p className="text-muted">{strings.projectTaskDraftHint}</p>
        <button type="button" className="btn btn-ghost btn-block" disabled={addingStep} onClick={onClose}>{strings.close}</button>
      </div>
    </BottomSheet>
  );
}
