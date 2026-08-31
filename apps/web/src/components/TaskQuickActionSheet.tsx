import { useState } from "react";
import type { Task } from "@machbar/shared";
import type { UpdateTaskInput } from "../lib/api";
import { useStrings } from "../lib/strings";
import { localizedErrorMessage } from "../lib/errorMessage";
import { BottomSheet } from "./BottomSheet";
import { ScheduleShortcuts } from "./ScheduleShortcuts";
import { MarkdownEditor } from "./MarkdownEditor";
import { HumanDateInput } from "./HumanDateInput";

export type TaskQuickAction = "owner" | "schedule" | "notes";
type TaskQuickEditorAction = Exclude<TaskQuickAction, "owner">;

interface TaskQuickActionSheetProps {
  task: Task;
  action: TaskQuickEditorAction;
  onClose: () => void;
  onSave: (
    patch: UpdateTaskInput,
    optimisticPatch?: Partial<Task>,
  ) => Promise<void>;
}

export function TaskQuickActionSheet({
  task,
  action,
  onClose,
  onSave,
}: TaskQuickActionSheetProps) {
  const strings = useStrings();
  const [scheduledDate, setScheduledDate] = useState(task.scheduledDate ?? "");
  const [notes, setNotes] = useState(task.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const title = {
    schedule: strings.schedule,
    notes: strings.notes,
  }[action];
  const closeIfIdle = () => {
    if (!saving) onClose();
  };

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave({ notes }, { notes });
      onClose();
    } catch (err) {
      setError(localizedErrorMessage(err, strings));
    } finally {
      setSaving(false);
    }
  };

  return (
    <BottomSheet title={`${title}: ${task.title}`} onClose={closeIfIdle}>
      <div className="stack task-quick-action-sheet">
        {action === "schedule" ? (
          <>
            <div className="field">
              <label htmlFor={`quick-schedule-${task.id}`}>{strings.scheduled}</label>
              <HumanDateInput
                id={`quick-schedule-${task.id}`}
                value={scheduledDate}
                onChange={(date) => {
                  const value = date ?? "";
                  setScheduledDate(value);
                  setSaving(true);
                  setError(null);
                  void onSave(
                    { scheduledDate: value || null },
                    { scheduledDate: value || null },
                  )
                    .then(onClose)
                    .catch((cause) => setError(localizedErrorMessage(cause, strings)))
                    .finally(() => setSaving(false));
                }}
                autoFocus
              />
            </div>
            <ScheduleShortcuts
              value={scheduledDate}
              onChange={(date) => {
                const value = date ?? "";
                setScheduledDate(value);
                setSaving(true);
                setError(null);
                void onSave(
                  { scheduledDate: value || null },
                  { scheduledDate: value || null },
                )
                  .then(onClose)
                  .catch((cause) => setError(localizedErrorMessage(cause, strings)))
                  .finally(() => setSaving(false));
              }}
              disabled={saving}
            />
          </>
        ) : null}

        {action === "notes" ? (
          <div className="field">
            <label htmlFor={`quick-notes-${task.id}`}>{strings.notes}</label>
            <MarkdownEditor
              id={`quick-notes-${task.id}`}
              rows={5}
              value={notes}
              onChange={setNotes}
              toolbarLabel={strings.markdownToolbar}
              autoFocus
            />
          </div>
        ) : null}

        {error ? <div className="task-row-error" role="alert">{error}</div> : null}

        <div className="row">
          <button type="button" className="btn" onClick={closeIfIdle} disabled={saving}>
            {action === "notes" ? strings.cancel : strings.close}
          </button>
          {action === "notes" ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void submit()}
              disabled={saving}
            >
              {strings.save}
            </button>
          ) : null}
        </div>
      </div>
    </BottomSheet>
  );
}
