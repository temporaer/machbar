import { useState } from "react";
import type { Task } from "@machbar/shared";
import { useStrings } from "../lib/strings";
import { useTaskActions } from "../lib/useTaskActions";
import { localizedErrorMessage } from "../lib/errorMessage";
import { formatExactLocalDate } from "../lib/relativeDate";
import { useLocale } from "../lib/locale";
import { BottomSheet } from "./BottomSheet";

/** Focused `task.recurrence` editor — the canonical destination regardless of rail/keyboard/detail invocation. */
export function TaskRecurrenceSheet({ task, onClose }: { task: Task; onClose: () => void }) {
  const strings = useStrings();
  const { locale } = useLocale();
  const taskActions = useTaskActions();
  const [saveError, setSaveError] = useState<string | null>(null);
  const saving = taskActions.isPending(task.id);

  const patch = async (input: { repeatAfterDays: number | null; allowedDeviationDays: number | null }) => {
    setSaveError(null);
    if (input.repeatAfterDays !== null && !task.scheduledDate) {
      setSaveError(strings.recurrenceScheduleRequired);
      return;
    }
    try {
      await taskActions.update(task, input, undefined, true);
    } catch (cause) {
      setSaveError(localizedErrorMessage(cause, strings));
    }
  };

  return (
    <BottomSheet
      title={strings.recurrence}
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      <div className="stack">
        <p className="text-muted">{task.title}</p>
        <div className="row-between">
          <p className="text-muted">{strings.recurrenceHint}</p>
          <label className="recurrence-toggle">
            <input
              type="checkbox"
              checked={task.repeatAfterDays !== null}
              disabled={saving}
              onChange={(event) => {
                void patch(
                  event.target.checked
                    ? { repeatAfterDays: 7, allowedDeviationDays: 0 }
                    : { repeatAfterDays: null, allowedDeviationDays: null },
                );
              }}
            />
            <span>{strings.recurrenceEnabled}</span>
          </label>
        </div>
        {task.repeatAfterDays !== null && task.allowedDeviationDays !== null ? (
          <>
            <div className="recurrence-number-grid">
              <label className="field">
                <span>{strings.repeatAfterDays}</span>
                <input
                  key={`repeat-${task.id}-${task.repeatAfterDays}`}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  step={1}
                  defaultValue={task.repeatAfterDays}
                  disabled={saving}
                  onBlur={(event) => {
                    const value = Number(event.target.value);
                    if (Number.isInteger(value) && value >= 1) {
                      void patch({ repeatAfterDays: value, allowedDeviationDays: task.allowedDeviationDays });
                    }
                  }}
                />
              </label>
              <label className="field">
                <span>{strings.allowedDeviationDays}</span>
                <input
                  key={`deviation-${task.id}-${task.allowedDeviationDays}`}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  step={1}
                  defaultValue={task.allowedDeviationDays}
                  disabled={saving}
                  onBlur={(event) => {
                    const value = Number(event.target.value);
                    if (Number.isInteger(value) && value >= 0) {
                      void patch({ repeatAfterDays: task.repeatAfterDays, allowedDeviationDays: value });
                    }
                  }}
                />
              </label>
            </div>
            <p className="recurrence-preview">
              {strings.recurrenceDeadlinePreview(
                formatExactLocalDate(task.dueDate ?? "", locale) ?? task.dueDate ?? "–",
              )}
            </p>
          </>
        ) : null}
        {saveError ? (
          <div className="task-row-error" role="alert">
            {saveError}
          </div>
        ) : null}
        <button type="button" className="btn" disabled={saving} onClick={onClose}>
          {strings.close}
        </button>
      </div>
    </BottomSheet>
  );
}
