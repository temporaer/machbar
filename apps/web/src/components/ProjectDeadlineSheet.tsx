import { useState } from "react";
import type { Project } from "@machbar/shared";
import { localizedErrorMessage } from "../lib/errorMessage";
import { useStrings } from "../lib/strings";
import { BottomSheet } from "./BottomSheet";
import { HumanDateInput } from "./HumanDateInput";
import { ProjectActivationDecisionFields } from "./ProjectActivationDecisionFields";
import {
  projectActivationResolutionFromPrompt,
  refreshProjectActivationPrompt,
  type ProjectActivationPrompt,
} from "../lib/projectActivationResolution";
import type { ProjectActivationResolution } from "@machbar/shared";

/** Bottom sheet for a project's deadline. */
export function ProjectDeadlineSheet({
  story,
  onClose,
  onSave,
}: {
  story: Project;
  onClose: () => void;
  onSave: (patch: { dueDate: string | null; activationResolution?: ProjectActivationResolution; expectedRevision?: number }) => Promise<void>;
}) {
  const strings = useStrings();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dueDate, setDueDate] = useState(story.dueDate ?? "");
  const [activationPrompt, setActivationPrompt] = useState<ProjectActivationPrompt | null>(null);

  const commit = async (
    patch: { dueDate: string | null; activationResolution?: ProjectActivationResolution },
  ) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(patch);
    } catch (cause) {
      const prompt = await refreshProjectActivationPrompt(cause, story.id, activationPrompt);
      if (prompt) setActivationPrompt(prompt);
      setError(localizedErrorMessage(cause, strings));
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
        {error ? <p role="alert" style={{ color: "var(--color-danger)" }}>{error}</p> : null}
        <button type="button" className="btn" onClick={onClose} disabled={saving}>
          {strings.cancel}
        </button>
      </div>
    </BottomSheet>
  );
}
