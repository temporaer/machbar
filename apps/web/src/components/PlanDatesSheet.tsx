import { useState } from "react";
import type { Project } from "@machbar/shared";
import { strings } from "../lib/strings";
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
  onSave: (patch: { dueDate: string | null; scheduledDate: string | null }) => Promise<void>;
}) {
  const [dueDate, setDueDate] = useState(story.dueDate ?? "");
  const [scheduledDate, setScheduledDate] = useState(story.scheduledDate ?? "");
  const [saving, setSaving] = useState(false);
  const [dueDateValid, setDueDateValid] = useState(true);
  const [scheduledDateValid, setScheduledDateValid] = useState(true);
  const closeIfValid = () => {
    if (dueDateValid && scheduledDateValid) onClose();
  };

  const submit = async () => {
    setSaving(true);
    try {
      await onSave({ dueDate: dueDate || null, scheduledDate: scheduledDate || null });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <BottomSheet title={strings.planDatesTitle} onClose={closeIfValid} labelledBy="plan-dates-title">
      <div className="stack">
        <p className="text-muted">{story.title}</p>
        <div className="row">
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="story-due">{strings.due}</label>
            <HumanDateInput
              id="story-due"
              value={dueDate}
              onChange={(date) => setDueDate(date ?? "")}
              onValidityChange={setDueDateValid}
            />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="story-scheduled">{strings.scheduled}</label>
            <HumanDateInput
              id="story-scheduled"
              value={scheduledDate}
              onChange={(date) => setScheduledDate(date ?? "")}
              onValidityChange={setScheduledDateValid}
            />
          </div>
        </div>
        <div className="row">
          <button type="button" className="btn" onClick={closeIfValid}>
            {strings.cancel}
          </button>
          <button
            type="button"
            className="btn btn-primary btn-block"
            disabled={saving || !dueDateValid || !scheduledDateValid}
            onClick={() => void submit()}
          >
            {strings.save}
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}
