import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Task } from "@machbar/shared";
import type { WorkItemAncestor } from "@machbar/shared";
import type { ProjectWithActions } from "../lib/api";
import { api } from "../lib/api";
import { useRefresh } from "../lib/refresh";
import { useStrings } from "../lib/strings";
import { sortByPosition } from "../lib/taskHelpers";
import { BottomSheet } from "./BottomSheet";
import { useProjectActions } from "../lib/useProjectActions";
import { useWorkItemCommands } from "../lib/useWorkItemCommands";
import { useAsync } from "../lib/useAsync";
import { StepComposer, type StepDraft } from "./StepComposer";
import { ProjectActivationDecisionFields } from "./ProjectActivationDecisionFields";
import {
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

/** Shared atomic step-entry continuation after the existing supported
 * task-to-project conversion. */
export function CapturedProjectHandoff({
  project,
  onDone,
}: {
  project: ProjectWithActions & { ancestors?: WorkItemAncestor[] };
  onDone: (options?: { openedProjectDirectly?: boolean }) => void;
}) {
  const strings = useStrings();
  const navigate = useNavigate();
  const { bump } = useRefresh();
  const [currentProject, setCurrentProject] = useState(project);
  const [steps, setSteps] = useState<Task[] | null>(null);
  const [draftSteps, setDraftSteps] = useState<StepDraft[]>([]);
  const [addingStep, setAddingStep] = useState(false);
  const [activationState, setActivationState] = useState<{ fingerprint: string; prompt: ProjectActivationPrompt } | null>(null);
  const projectActions = useProjectActions([currentProject]);
  const dispatch = useWorkItemCommands();
  const displayedProject = projectActions.projectStory(currentProject);
  const canStart = displayedProject.availableActions.includes("activate");
  const activationReady = (displayedProject.activationReadiness.requiredDecisions ?? []).length === 0;
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
      await api.createTaskStepBatchForProject(project.id, {
        steps: draft,
        expectedRevision: currentProject.revision,
        expectedProjectRevisions,
        ...(activationResolution ? { activationResolution } : {}),
      });
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
    <BottomSheet title={project.title} onClose={() => !addingStep && onDone()}>
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
          inputIdPrefix={`captured-project-step-${project.id}`}
          label={strings.addNextAction}
          placeholder={strings.splitTaskRowPlaceholder}
          submitLabel={strings.addNextAction}
          onDraftChange={setDraftSteps}
          onPendingChange={setAddingStep}
          onSubmit={submitSteps}
          submitDisabled={activationPrompt !== null && activationResolution === null}
        />
        {canStart ? (
          <>
            <p className="text-muted">{activationReady ? strings.activationReadyHint : strings.commitmentResolutionHint}</p>
            <button type="button" className="btn btn-primary btn-block" disabled={addingStep || projectActions.isPending(displayedProject.id)}
              onClick={() => dispatch({ type: "story.activate", story: displayedProject })}>
              {strings.reviewStart}
            </button>
          </>
        ) : <p className="text-muted">{strings.activationProgressRequired}</p>}
        {projectActions.errors[displayedProject.id] ? <p className="capture-error" role="alert">{projectActions.errors[displayedProject.id]}</p> : null}
        <button type="button" className="btn btn-block" disabled={addingStep} onClick={() => {
          onDone({ openedProjectDirectly: true });
          navigate(`/projects/${project.id}`);
        }}>{strings.openProject}</button>
        <button type="button" className="btn btn-ghost btn-block" disabled={addingStep} onClick={() => onDone()}>{strings.done}</button>
      </div>
    </BottomSheet>
  );
}
