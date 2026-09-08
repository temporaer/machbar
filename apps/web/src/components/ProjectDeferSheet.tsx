import { useState } from "react";
import type { Project } from "@machbar/shared";
import { localizedErrorMessage } from "../lib/errorMessage";
import { useStrings } from "../lib/strings";
import { addIsoCalendarDays, toIsoCalendarDate } from "../lib/naturalDate";
import { BottomSheet } from "./BottomSheet";
import { HumanDateInput } from "./HumanDateInput";

/**
 * The canonical `story.defer` workflow — replaces the old two-equal-field
 * `PlanDatesSheet`. `scheduledDate` has explicit semantics for a project
 * ("before this date, this project is intentionally not relevant"), so
 * the primary question is "Bis wann zurückstellen?" with convenience
 * shortcuts; the existing deadline is shown separately, as a secondary
 * constraint, not an equally-weighted second field.
 */
export function ProjectDeferSheet({
  story,
  onClose,
  onSave,
}: {
  story: Project;
  onClose: () => void;
  onSave: (patch: { scheduledDate?: string | null; dueDate?: string | null }) => Promise<void>;
}) {
  const strings = useStrings();
  const [customDate, setCustomDate] = useState(false);
  const [scheduledDate, setScheduledDate] = useState(story.scheduledDate ?? "");
  const [dateValid, setDateValid] = useState(true);
  const [editingDeadline, setEditingDeadline] = useState(false);
  const [dueDate, setDueDate] = useState(story.dueDate ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const today = () => toIsoCalendarDate(new Date());

  const commit = async (patch: { scheduledDate?: string | null; dueDate?: string | null }) => {
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
      title={strings.deferProject}
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      <div className="stack">
        <p className="text-muted">{story.title}</p>
        <div className="field">
          <span className="field-label">{strings.projectDeferQuestion}</span>
          <div className="choice-group" role="group" aria-label={strings.projectDeferQuestion}>
            <button
              type="button"
              className="choice-chip"
              disabled={saving}
              onClick={() => void commit({ scheduledDate: addIsoCalendarDays(today(), 1) })}
            >
              {strings.projectDeferShortcutLabels.tomorrow}
            </button>
            <button
              type="button"
              className="choice-chip"
              disabled={saving}
              onClick={() => void commit({ scheduledDate: addIsoCalendarDays(today(), 7) })}
            >
              {strings.projectDeferShortcutLabels.nextWeek}
            </button>
            <button
              type="button"
              className="choice-chip"
              disabled={saving}
              onClick={() => void commit({ scheduledDate: addIsoCalendarDays(today(), 14) })}
            >
              {strings.projectDeferShortcutLabels.twoWeeks}
            </button>
            <button
              type="button"
              className="choice-chip"
              disabled={saving}
              onClick={() => void commit({ scheduledDate: addIsoCalendarDays(today(), 30) })}
            >
              {strings.projectDeferShortcutLabels.nextMonth}
            </button>
            <button
              type="button"
              className="choice-chip"
              aria-pressed={customDate}
              disabled={saving}
              onClick={() => setCustomDate(true)}
            >
              {strings.due} …
            </button>
          </div>
          {customDate ? (
            <div className="row">
              <HumanDateInput
                id="project-defer-date"
                value={scheduledDate}
                onChange={(date) => setScheduledDate(date ?? "")}
                onValidityChange={setDateValid}
                disabled={saving}
              />
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={saving || !dateValid}
                onClick={() => void commit({ scheduledDate: scheduledDate || null })}
              >
                {strings.save}
              </button>
            </div>
          ) : null}
        </div>

        <div className="field">
          <span className="field-label">{strings.due}</span>
          {editingDeadline ? (
            <div className="row">
              <HumanDateInput
                id="project-defer-due-date"
                value={dueDate}
                onChange={(date) => setDueDate(date ?? "")}
                onValidityChange={setDateValid}
                disabled={saving}
              />
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={saving || !dateValid}
                onClick={() => void commit({ dueDate: dueDate || null })}
              >
                {strings.save}
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setEditingDeadline(true)}
            >
              {story.dueDate ?? strings.none}
            </button>
          )}
        </div>

        {error ? (
          <div className="task-row-error" role="alert">
            {error}
          </div>
        ) : null}
        <button type="button" className="btn" disabled={saving} onClick={onClose}>
          {strings.cancel}
        </button>
      </div>
    </BottomSheet>
  );
}
