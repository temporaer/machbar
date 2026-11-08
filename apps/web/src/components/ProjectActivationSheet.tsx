import { useEffect, useRef, useState } from "react";
import { isCancelledError } from "@tanstack/react-query";
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
    targetRevision: story.revision,
    selectedDrivers: {},
    nextActionTitle: "",
  };
}

function selectedDriver(story: Project, prompt: ProjectActivationPrompt): number | null {
  return prompt.selectedDrivers[story.id] ?? story.ownerMemberId;
}

function targetOnly(prompt: ProjectActivationPrompt, targetId: number) {
  return prompt.expectedProjects.some(project => project.projectId === targetId) &&
    prompt.expectedProjects.every(project => project.projectId === targetId) &&
    prompt.projects.every(project => project.projectId === targetId);
}

export function ProjectActivationSheet({
  story,
  action,
  onClose,
  onActivate,
  authoritativeProject = null,
  ...presentation
}: {
  story: ProjectWithActions & Pick<ProjectDetail, "directActivationDecisionSnapshot"> &
    Partial<Pick<ProjectDetail, "activationDecisionSnapshot">>;
  action: Extract<ProjectWorkflowAction, "activate" | "reopen">;
  onClose: () => void;
  onActivate: (ownerMemberId: number | null, resolution: ProjectActivationResolution, expectedRevision?: number) => Promise<void | boolean>;
  authoritativeProject?: ProjectDetail | null;
} & BottomSheetPresentationProps) {
  const strings = useStrings();
  const projectActions = useProjectActions();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openingRead = useRef(projectActions.captureTargetRead(story.id));
  const bindPrompt = (value: ProjectActivationPrompt, read: ReturnType<typeof projectActions.captureTargetRead>) => ({
    ...value,
    ...(!targetOnly(value, story.id) ? { readUnavailable: true } : {}),
    isCurrentRead: () => targetOnly(value, story.id) &&
      projectActions.isCurrentTargetRead(read) && projectActions.isTargetReadable(story.id),
  });
  const unavailablePrompt = (previous: ProjectActivationPrompt) => ({ ...previous, readUnavailable: true });
  const initialAuthority = authoritativeProject?.id === story.id
    ? authoritativeProject : projectActions.getCachedProject(story.id) ?? story;
  const [prompt, setPrompt] = useState<ProjectActivationPrompt>(() => {
    const initial = activationPrompt(initialAuthority);
    const bound = bindPrompt(initial, openingRead.current);
    return !("tasks" in initialAuthority && initialAuthority.directActivationDecisionSnapshot &&
      projectActions.isCurrentProjectRead(initialAuthority))
      ? { ...bound, readUnavailable: true } : bound;
  });
  const [recoveryLoading, setRecoveryLoading] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const promptRef = useRef(prompt);
  promptRef.current = prompt;
  const recover = async () => {
    if (recoveryLoading) return;
    const read = projectActions.captureTargetRead(story.id);
    const release = projectActions.pauseRetention(story.id);
    setRecoveryLoading(true);
    setRecoveryError(null);
    try {
      const received = await projectActions.readProject(story.id);
      if (!projectActions.isCurrentTargetRead(read) ||
        !projectActions.isCurrentTargetRead(received.read) ||
        !projectActions.isCurrentProjectRead(received.value)) {
        throw new Error(strings.workflowTargetUnavailable);
      }
      const snapshot = received.value.directActivationDecisionSnapshot;
      if (!snapshot) {
        setPrompt(previous => unavailablePrompt(previous));
      } else {
        const previous = promptRef.current;
        const merged = projectActivationPromptFromSnapshot(
          snapshot,
          previous,
          story.id,
          previous.targetRevision,
        );
        if (merged === previous || !targetOnly(merged, story.id)) {
          setPrompt(previous => unavailablePrompt(previous));
        } else {
          setPrompt(bindPrompt(merged, received.read));
        }
      }
    } catch (cause) {
      if (!isCancelledError(cause)) setRecoveryError(localizedErrorMessage(cause, strings));
    } finally {
      release();
      setRecoveryLoading(false);
    }
  };
  const consumedAuthority = useRef<ProjectDetail | null>(null);
  useEffect(() => {
    if (saving || !authoritativeProject || consumedAuthority.current === authoritativeProject) return;
    consumedAuthority.current = authoritativeProject;
    if (authoritativeProject.id !== story.id || !projectActions.isCurrentProjectRead(authoritativeProject)) return;
    if (!authoritativeProject.directActivationDecisionSnapshot ||
      !targetOnly(projectActivationPromptFromSnapshot(authoritativeProject.directActivationDecisionSnapshot), story.id)) {
      setPrompt(unavailablePrompt);
      return;
    }
    setPrompt(previous => {
      const merged = projectActivationPromptFromSnapshot(authoritativeProject.directActivationDecisionSnapshot!, previous, story.id, previous.targetRevision);
      if (merged === previous) return previous;
      return bindPrompt(merged, projectActions.captureTargetRead(story.id));
    });
  }, [authoritativeProject, saving]);
  const unavailable = prompt.readUnavailable || (prompt.isCurrentRead && !prompt.isCurrentRead());
  const resolution = projectActivationResolutionFromPrompt(prompt);

  const submit = async () => {
    if (saving) return;
    const continuation = projectActions.captureTargetRead(story.id);
    const requestReadsCurrent = () => projectActions.isCurrentTargetRead(continuation) &&
      projectActions.isTargetReadable(story.id) && (!prompt.isCurrentRead || prompt.isCurrentRead());
    if (!resolution || unavailable) {
      setError(strings.commitmentResolutionHint);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const targetRevision = prompt.expectedProjects.find((entry) => entry.projectId === story.id)?.revision ?? prompt.targetRevision;
      const accepted = await onActivate(selectedDriver(story, prompt), resolution, targetRevision);
      if (accepted !== false && projectActions.isCurrentTargetRead(continuation) && requestReadsCurrent()) onClose();
    } catch (cause) {
      if (!projectActions.isCurrentTargetRead(continuation) || !requestReadsCurrent()) return;
      const read = projectActions.captureTargetRead(story.id);
      const refreshedPrompt = await refreshProjectActivationPrompt(cause, story.id, prompt, "explicit_activation", projectActions.getProject,
        () => projectActions.isCurrentTargetRead(read), prompt.targetRevision);
      if (!projectActions.isCurrentTargetRead(continuation) || !requestReadsCurrent()) return;
      if (refreshedPrompt) {
        if (refreshedPrompt === promptRef.current || !targetOnly(refreshedPrompt, story.id)) {
          setPrompt(previous => unavailablePrompt(previous));
        } else {
          setPrompt(bindPrompt(refreshedPrompt, read));
        }
      }
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
        {!unavailable ? <ProjectActivationDecisionFields prompt={prompt} disabled={saving} onChange={setPrompt} /> : null}
        {unavailable && !presentation.headerStatus ? <ReadErrorState resource={strings.project}
          error={recoveryError ?? strings.workflowTargetUnavailable} refreshError={null}
          loading={recoveryLoading} refreshing={false} reload={() => void recover()} /> : null}
        {error ? <p role="alert" className="task-row-error">{error}</p> : null}
        <div className="row">
          <button type="button" className="btn" disabled={saving} onClick={onClose}>{strings.cancel}</button>
          <button type="button" className="btn btn-primary" disabled={saving || unavailable || resolution === null} onClick={() => void submit()}>
            {action === "reopen" ? strings.reopen : strings.activateStory}
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}
