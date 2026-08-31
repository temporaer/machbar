import { useState } from "react";
import type { Project } from "@machbar/shared";
import { localizedErrorMessage } from "../lib/errorMessage";
import { useStrings } from "../lib/strings";
import { BottomSheet } from "./BottomSheet";
import { HumanDateInput } from "./HumanDateInput";

/** Bottom sheet for the "Planen" chip: due/scheduled dates, same fields/shape as `TaskDetailSheet`. */
export function PlanDatesSheet({
  story,
  onClose,
  onSave,
}: {
  story: Project;
  onClose: () => void;
  onSave: (patch: { dueDate?: string | null; scheduledDate?: string | null }) => Promise<void>;
}) {
  const strings = useStrings();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const commit = async (
    patch: { dueDate?: string | null; scheduledDate?: string | null },
  ) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(patch);
      onClose();
    } catch (cause) {
      setError(localizedErrorMessage(cause, strings));
    } finally {
      setSaving(false);
    }
  };

  return (
    <BottomSheet
      title={strings.planDatesTitle}
      onClose={() => {
        if (!saving) onClose();
      }}
      labelledBy="plan-dates-title"
    >
      <div className="stack">
        <p className="text-muted">{story.title}</p>
        <div className="row">
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="story-due">{strings.due}</label>
            <HumanDateInput
              id="story-due"
              value={story.dueDate ?? ""}
              onChange={(date) => void commit({ dueDate: date })}
              disabled={saving}
            />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="story-scheduled">{strings.scheduled}</label>
            <HumanDateInput
              id="story-scheduled"
              value={story.scheduledDate ?? ""}
              onChange={(date) => void commit({ scheduledDate: date })}
              disabled={saving}
            />
          </div>
        </div>
        {error ? <p role="alert" style={{ color: "var(--color-danger)" }}>{error}</p> : null}
        <button type="button" className="btn" onClick={onClose} disabled={saving}>
          {strings.cancel}
        </button>
      </div>
    </BottomSheet>
  );
}
