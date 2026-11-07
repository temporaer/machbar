import { useEffect, useRef, useState } from "react";
import type { Project } from "@machbar/shared";
import { localizedErrorMessage } from "../lib/errorMessage";
import { useStrings } from "../lib/strings";
import { useProjectActions } from "../lib/useProjectActions";
import { BottomSheet, type BottomSheetPresentationProps } from "./BottomSheet";
import { HumanDateInput } from "./HumanDateInput";
import { ProjectActivationDecisionFields } from "./ProjectActivationDecisionFields";
import {
  projectActivationResolutionFromPrompt,
  projectActivationPromptFromSnapshot,
  refreshProjectActivationPrompt,
  type ProjectActivationPrompt,
} from "../lib/projectActivationResolution";
import type { ProjectActivationResolution } from "@machbar/shared";
import type { ProjectDetail } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { ReadErrorState } from "./AsyncStates";

/** Bottom sheet for a project's deadline. */
export function ProjectDeadlineSheet({
  story,
  onClose,
  onSave,
  authoritativeProject = null,
  ...presentation
}: {
  story: Project;
  onClose: () => void;
  onSave: (patch: { dueDate: string | null; activationResolution?: ProjectActivationResolution; expectedRevision?: number }) => Promise<void>;
  authoritativeProject?: ProjectDetail | null;
} & BottomSheetPresentationProps) {
  const strings = useStrings();
  const projectActions = useProjectActions();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dueDate, setDueDate] = useState(story.dueDate ?? "");
  const [activationPrompt, setActivationPrompt] = useState<ProjectActivationPrompt | null>(null);
  const [recoveryRequested, setRecoveryRequested] = useState(false);
  const recovery = useAsync(() => recoveryRequested ? projectActions.readProject(story.id) : Promise.resolve(null),
    [story.id, projectActions.scopeToken, recoveryRequested]);
  const consumedAuthority = useRef(authoritativeProject);
  useEffect(() => {
    if (saving || !authoritativeProject || consumedAuthority.current === authoritativeProject) return;
    consumedAuthority.current = authoritativeProject;
    if (!projectActions.isCurrentProjectRead(authoritativeProject)) return;
    setActivationPrompt(previous => previous && (previous.readUnavailable || (previous.isCurrentRead && !previous.isCurrentRead())) &&
      authoritativeProject.activationDecisionSnapshot
      ? { ...projectActivationPromptFromSnapshot(authoritativeProject.activationDecisionSnapshot, previous),
        isCurrentRead: () => projectActions.isCurrentProjectRead(authoritativeProject) }
      : previous);
  }, [authoritativeProject, saving]);
  useEffect(() => {
    const received = recovery.data;
    if (!received || !projectActions.isCurrentTargetRead(received.read) || !received.value.activationDecisionSnapshot) return;
    projectActions.observeConfirmedStory(received.value, received.read);
    setActivationPrompt(previous => ({
      ...projectActivationPromptFromSnapshot(received.value.activationDecisionSnapshot!, previous),
      isCurrentRead: () => projectActions.isCurrentTargetRead(received.read),
    }));
  }, [recovery.data]);
  const unavailable = activationPrompt?.readUnavailable || (activationPrompt?.isCurrentRead && !activationPrompt.isCurrentRead());

  const commit = async (
    patch: { dueDate: string | null; activationResolution?: ProjectActivationResolution },
  ) => {
    if (saving || unavailable) return;
    const continuation = projectActions.captureTargetRead(story.id);
    setSaving(true);
    setError(null);
    try {
      await onSave(patch);
    } catch (cause) {
      if (!projectActions.isCurrentTargetRead(continuation)) return;
      const read = projectActions.captureTargetRead(story.id);
      const prompt = await refreshProjectActivationPrompt(cause, story.id, activationPrompt, "commitment", projectActions.getProject,
        () => projectActions.isCurrentTargetRead(read));
      if (!projectActions.isCurrentTargetRead(continuation)) return;
      if (prompt) setActivationPrompt(prompt);
      setError(localizedErrorMessage(cause, strings));
    } finally {
      setSaving(false);
    }
  };

  return (
    <BottomSheet
      {...presentation}
      title={strings.projectDeadlineTitle}
      onClose={() => {
        if (!saving) onClose();
      }}
      labelledBy="project-deadline-title"
    >
      <div className="stack">
        <p className="text-muted">{story.title}</p>
        <div className="field">
          <label htmlFor="story-due">{strings.due}</label>
          <HumanDateInput
            id="story-due"
            value={dueDate}
            onChange={(date) => {
              setDueDate(date ?? "");
              void commit({ dueDate: date });
            }}
            disabled={saving}
          />
        </div>
        {activationPrompt ? (
          <>
            <ProjectActivationDecisionFields prompt={activationPrompt} disabled={saving} onChange={setActivationPrompt} />
            <button
              type="button"
              className="btn btn-primary"
              disabled={saving || projectActivationResolutionFromPrompt(activationPrompt) === null}
              onClick={() => void commit({
                dueDate: dueDate || null,
                ...(activationPrompt.targetRevision !== undefined
                  ? { expectedRevision: activationPrompt.targetRevision }
                  : {}),
                ...(projectActivationResolutionFromPrompt(activationPrompt)
                  ? { activationResolution: projectActivationResolutionFromPrompt(activationPrompt)! }
                  : {}),
              })}
            >
              {strings.save}
            </button>
          </>
        ) : null}
        {unavailable && !presentation.headerStatus ? <ReadErrorState resource={strings.project} {...recovery}
          error={recovery.error ?? strings.workflowTargetUnavailable}
          reload={() => recoveryRequested ? recovery.reload() : setRecoveryRequested(true)} /> : null}
        {error ? <p role="alert" style={{ color: "var(--color-danger)" }}>{error}</p> : null}
        <button type="button" className="btn" onClick={onClose} disabled={saving}>
          {strings.cancel}
        </button>
      </div>
    </BottomSheet>
  );
}
