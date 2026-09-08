import { useState } from "react";
import type { Task } from "@machbar/shared";
import { useStrings } from "../lib/strings";
import { useTaskActions } from "../lib/useTaskActions";
import { localizedErrorMessage } from "../lib/errorMessage";
import { BottomSheet } from "./BottomSheet";
import { ScheduleShortcuts } from "./ScheduleShortcuts";
import { HumanDateInput } from "./HumanDateInput";

/**
 * The one canonical `task.plan` workflow — reached identically from the
 * left-swipe rail, keyboard `s`, a click on the task detail's scheduled/
 * deadline value, and Review's plan repair. Scheduled date and deadline
 * are one small planning transaction: both fields are held as local draft
 * state and committed together on `Fertig`, not on every keystroke.
 */
export function TaskPlanSheet({ task, onClose }: { task: Task; onClose: () => void }) {
  const strings = useStrings();
  const taskActions = useTaskActions();
  const [scheduledDate, setScheduledDate] = useState(task.scheduledDate ?? "");
  const [dueDate, setDueDate] = useState(task.dueDate ?? "");
  const [showDeadline, setShowDeadline] = useState(Boolean(task.dueDate));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dateValid, setDateValid] = useState(true);

  const dirty = (scheduledDate || null) !== task.scheduledDate || (dueDate || null) !== task.dueDate;

  const commit = async () => {
    if (saving || !dateValid) return;
    setSaving(true);
    setError(null);
    try {
      await taskActions.update(
        task,
        { scheduledDate: scheduledDate || null, dueDate: dueDate || null },
        { scheduledDate: scheduledDate || null, dueDate: dueDate || null },
        true,
      );
      onClose();
    } catch (cause) {
      setError(localizedErrorMessage(cause, strings));
    } finally {
      setSaving(false);
    }
  };

  return (
    <BottomSheet
      title={`${strings.plan}: ${task.title}`}
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          void commit();
        }}
      >
        <div className="field">
          <label htmlFor={`plan-scheduled-${task.id}`}>{strings.taskPlanQuestion}</label>
          <HumanDateInput
            id={`plan-scheduled-${task.id}`}
            value={scheduledDate}
            onChange={(date) => setScheduledDate(date ?? "")}
            onValidityChange={setDateValid}
            disabled={saving}
            autoFocus
          />
        </div>
        <ScheduleShortcuts
          value={scheduledDate}
          onChange={(date) => setScheduledDate(date ?? "")}
          disabled={saving}
        />

        {showDeadline ? (
          <div className="field">
            <label htmlFor={`plan-due-${task.id}`}>{strings.due}</label>
            <HumanDateInput
              id={`plan-due-${task.id}`}
              value={dueDate}
              onChange={(date) => setDueDate(date ?? "")}
              onValidityChange={setDateValid}
              disabled={saving}
            />
          </div>
        ) : (
          <button
            type="button"
            className="btn btn-sm btn-ghost task-detail-add-property"
            onClick={() => setShowDeadline(true)}
          >
            {strings.addDeadline}
          </button>
        )}

        {error ? (
          <div className="task-row-error" role="alert">
            <span>{strings.error}</span>
            <span className="text-muted">{error}</span>
          </div>
        ) : null}

        <div className="row">
          <button type="button" className="btn" disabled={saving} onClick={onClose}>
            {strings.cancel}
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving || !dateValid || !dirty}>
            {strings.confirmDone}
          </button>
        </div>
      </form>
    </BottomSheet>
  );
}
