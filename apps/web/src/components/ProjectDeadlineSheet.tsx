import { useState } from "react";
import type { Project } from "@machbar/shared";
import { hasApiErrorCode, isReadAccessError, isStaleWriteConflict, localizedErrorMessage } from "../lib/errorMessage";
import { api } from "../lib/api";
import { useStrings } from "../lib/strings";
import { BottomSheet } from "./BottomSheet";
import { HumanDateInput } from "./HumanDateInput";
import { ProjectActivationDecisionFields } from "./ProjectActivationDecisionFields";
import {
  projectActivationResolutionFromPrompt,
  projectActivationPromptFromError,
  projectActivationPromptFromSnapshot,
  type ProjectActivationPrompt,
} from "../lib/projectActivationResolution";
import type { ProjectActivationResolution } from "@machbar/shared";

/** Bottom sheet for a project's deadline. */
export function ProjectDeadlineSheet({
  story,
  onClose,
  onSave,
  onFailure,
}: {
  story: Project;
  onClose: () => void;
  onFailure?: (cause: unknown) => void;
  onSave: (patch: { dueDate: string | null; activationResolution?: ProjectActivationResolution; expectedRevision?: number }) => Promise<void>;
}) {
  const strings = useStrings();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dueDate, setDueDate] = useState(story.dueDate ?? "");
  const [activationPrompt, setActivationPrompt] = useState<ProjectActivationPrompt | null>(null);
  const [requirementsReloadNeeded, setRequirementsReloadNeeded] = useState(false);

  const reloadRequirements = async () => {
    try {
      const current = await api.getProject(story.id);
      setActivationPrompt(projectActivationPromptFromSnapshot(
        current.activationDecisionSnapshot ?? {
          projects: [],
          expectedProjects: [],
          targetRevision: current.revision,
        },
      ));
      setRequirementsReloadNeeded(false);
    } catch (cause) {
      onFailure?.(cause);
      setError(localizedErrorMessage(cause, strings));
    }
  };

  const retryRequirements = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await reloadRequirements();
    } finally {
      setSaving(false);
    }
  };

  const commit = async (
    patch: { dueDate: string | null; activationResolution?: ProjectActivationResolution },
  ) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(patch);
    } catch (cause) {
      onFailure?.(cause);
      setError(localizedErrorMessage(cause, strings));
      if (isStaleWriteConflict(cause)) {
        setActivationPrompt(null);
        setRequirementsReloadNeeded(true);
        await reloadRequirements();
      } else if (hasApiErrorCode(cause, "project_commitment_resolution_required")) {
        setActivationPrompt(projectActivationPromptFromError(cause));
      } else if (!activationPrompt && !isReadAccessError(cause)) {
        setRequirementsReloadNeeded(true);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <BottomSheet
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
              if (!requirementsReloadNeeded) void commit({ dueDate: date });
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
        {requirementsReloadNeeded ? (
          <button type="button" className="btn" disabled={saving} onClick={() => void retryRequirements()}>
            {strings.retry}
          </button>
        ) : null}
        {error ? <p role="alert" style={{ color: "var(--color-danger)" }}>{error}</p> : null}
        <button type="button" className="btn" onClick={onClose} disabled={saving}>
          {strings.cancel}
        </button>
      </div>
    </BottomSheet>
  );
}
