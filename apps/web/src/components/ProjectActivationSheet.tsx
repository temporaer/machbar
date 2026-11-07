import { useEffect, useRef, useState } from "react";
import type { Project, ProjectActivationResolution } from "@machbar/shared";
import type { ProjectDetail, ProjectWithActions, ProjectWorkflowAction } from "../lib/api";
import { localizedErrorMessage } from "../lib/errorMessage";
import { useStrings } from "../lib/strings";
import { useProjectActions } from "../lib/useProjectActions";
import {
  projectActivationPromptFromSnapshot,
  projectActivationResolutionFromPrompt,
  refreshProjectActivationPrompt,
  type ProjectActivationPrompt,
} from "../lib/projectActivationResolution";
import { ProjectActivationDecisionFields } from "./ProjectActivationDecisionFields";
import { BottomSheet, type BottomSheetPresentationProps } from "./BottomSheet";
import { useAsync } from "../lib/useAsync";
import { ReadErrorState } from "./AsyncStates";

function activationPrompt(story: ProjectWithActions & Pick<ProjectDetail, "directActivationDecisionSnapshot">): ProjectActivationPrompt {
  if (story.directActivationDecisionSnapshot) return projectActivationPromptFromSnapshot(story.directActivationDecisionSnapshot);
  const required = story.activationReadiness.requiredDecisions ?? [];
  return {
    projects: required.length > 0 ? [{
      projectId: story.id,
      title: story.title,
      revision: story.revision,
      ownerMemberId: story.ownerMemberId,
      required,
    }] : [],
    expectedProjects: [{ projectId: story.id, revision: story.revision }],
    selectedDrivers: {},
    nextActionTitle: "",
  };
}

function selectedDriver(story: Project, prompt: ProjectActivationPrompt): number | null {
  return prompt.selectedDrivers[story.id] ?? story.ownerMemberId;
}

export function ProjectActivationSheet({
  story,
  action,
  onClose,
  onActivate,
  authoritativeProject = null,
  ...presentation
}: {
  story: ProjectWithActions & Pick<ProjectDetail, "directActivationDecisionSnapshot">;
  action: Extract<ProjectWorkflowAction, "activate" | "reopen">;
  onClose: () => void;
  onActivate: (ownerMemberId: number | null, resolution: ProjectActivationResolution, expectedRevision?: number) => Promise<void | boolean>;
  authoritativeProject?: ProjectDetail | null;
} & BottomSheetPresentationProps) {
  const strings = useStrings();
  const projectActions = useProjectActions();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState(() => activationPrompt(story));
  const [recoveryRequested, setRecoveryRequested] = useState(false);
  const recovery = useAsync(() => recoveryRequested ? projectActions.readProject(story.id) : Promise.resolve(null),
    [story.id, projectActions.scopeToken, recoveryRequested]);
  const consumedAuthority = useRef(authoritativeProject);
  useEffect(() => {
    if (saving || !authoritativeProject || consumedAuthority.current === authoritativeProject) return;
    consumedAuthority.current = authoritativeProject;
    if (!projectActions.isCurrentProjectRead(authoritativeProject) || !authoritativeProject.directActivationDecisionSnapshot) return;
    setPrompt(previous => previous.readUnavailable || (previous.isCurrentRead && !previous.isCurrentRead())
      ? { ...projectActivationPromptFromSnapshot(authoritativeProject.directActivationDecisionSnapshot!, previous),
        isCurrentRead: () => projectActions.isCurrentProjectRead(authoritativeProject) }
      : previous);
  }, [authoritativeProject, saving]);
  useEffect(() => {
    const received = recovery.data;
    if (!received || !projectActions.isCurrentTargetRead(received.read) || !received.value.directActivationDecisionSnapshot) return;
    projectActions.observeConfirmedStory(received.value, received.read);
    setPrompt(previous => ({
      ...projectActivationPromptFromSnapshot(received.value.directActivationDecisionSnapshot!, previous),
      isCurrentRead: () => projectActions.isCurrentTargetRead(received.read),
    }));
  }, [recovery.data]);
  const unavailable = prompt.readUnavailable || (prompt.isCurrentRead && !prompt.isCurrentRead());
  const resolution = projectActivationResolutionFromPrompt(prompt);

  const submit = async () => {
    if (saving) return;
    const continuation = projectActions.captureTargetRead(story.id);
    if (!resolution) {
      setError(strings.commitmentResolutionHint);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const targetRevision = prompt.expectedProjects.find((entry) => entry.projectId === story.id)?.revision ?? prompt.targetRevision;
      const accepted = await onActivate(selectedDriver(story, prompt), resolution, targetRevision);
      if (accepted !== false && projectActions.isCurrentTargetRead(continuation)) onClose();
    } catch (cause) {
      if (!projectActions.isCurrentTargetRead(continuation)) return;
      const read = projectActions.captureTargetRead(story.id);
      const refreshedPrompt = await refreshProjectActivationPrompt(cause, story.id, prompt, "explicit_activation", projectActions.getProject,
        () => projectActions.isCurrentTargetRead(read));
      if (!projectActions.isCurrentTargetRead(continuation)) return;
      if (refreshedPrompt) setPrompt(refreshedPrompt);
      setError(localizedErrorMessage(cause, strings));
    } finally {
      setSaving(false);
    }
  };

  return (
    <BottomSheet {...presentation} title={action === "reopen" ? strings.reopen : strings.activateStory} onClose={() => {
      if (!saving) onClose();
    }}>
      <div className="stack">
        <p className="text-muted">{story.title}</p>
        <ProjectActivationDecisionFields prompt={prompt} disabled={saving} onChange={setPrompt} />
        {unavailable && !presentation.headerStatus ? <ReadErrorState resource={strings.project} {...recovery}
          error={recovery.error ?? strings.workflowTargetUnavailable}
          reload={() => recoveryRequested ? recovery.reload() : setRecoveryRequested(true)} /> : null}
        {error ? <p role="alert" className="task-row-error">{error}</p> : null}
        <div className="row">
          <button type="button" className="btn" disabled={saving} onClick={onClose}>{strings.cancel}</button>
          <button type="button" className="btn btn-primary" disabled={saving || resolution === null} onClick={() => void submit()}>
            {action === "reopen" ? strings.reopen : strings.activateStory}
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}
