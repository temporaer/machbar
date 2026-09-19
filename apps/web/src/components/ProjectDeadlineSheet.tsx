import { useState } from "react";
import type { Project } from "@machbar/shared";
import { localizedErrorMessage } from "../lib/errorMessage";
import { useStrings } from "../lib/strings";
import { BottomSheet } from "./BottomSheet";
import { HumanDateInput } from "./HumanDateInput";

/** Bottom sheet for a project's deadline. */
export function ProjectDeadlineSheet({
  story,
  onClose,
  onSave,
}: {
  story: Project;
  onClose: () => void;
  onSave: (patch: { dueDate: string | null }) => Promise<void>;
}) {
  const strings = useStrings();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const commit = async (
    patch: { dueDate: string | null },
  ) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(patch);
    } catch (cause) {
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
            value={story.dueDate ?? ""}
            onChange={(date) => void commit({ dueDate: date })}
            disabled={saving}
          />
        </div>
        {error ? <p role="alert" style={{ color: "var(--color-danger)" }}>{error}</p> : null}
        <button type="button" className="btn" onClick={onClose} disabled={saving}>
          {strings.cancel}
        </button>
      </div>
    </BottomSheet>
  );
}
