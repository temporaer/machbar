import { useState } from "react";
import type { Task } from "@machbar/shared";
import { useStrings } from "../lib/strings";
import { useTaskActions } from "../lib/useTaskActions";
import { useWorkItemCommands } from "../lib/useWorkItemCommands";
import { useTaskSnooze } from "../lib/taskSnoozeContext";
import { resolveAbsolutePreset } from "../lib/reminderPresets";
import { resolveScheduleShortcut } from "./ScheduleShortcuts";
import { localizedErrorMessage } from "../lib/errorMessage";
import { BottomSheet } from "./BottomSheet";
import { HumanDateInput } from "./HumanDateInput";

/**
 * Focused `task.later` workflow — one smart "when should this come back to
 * my attention?" sheet. Same-day choices ("Heute Abend" / "In einer Weile")
 * only write the member-scoped, ephemeral snooze (`taskSnoozeContext.tsx`):
 * today is still the scheduled day, so they never touch `scheduledDate`.
 * "Morgen" / "Wochenende" / a custom date instead schedule the task through
 * the same commit path `TaskPlanSheet` uses. `laterMorePlanningOptions` is
 * the escape hatch into the full `task.plan` workflow (deadline, etc.) —
 * reached by dispatching `task.plan` rather than opening it directly, so
 * `useWorkItemCommands()` stays the only place deciding which workflow a
 * command opens.
 */
export function TaskLaterSheet({ task, onClose }: { task: Task; onClose: () => void }) {
  const strings = useStrings();
  const taskActions = useTaskActions();
  const dispatch = useWorkItemCommands();
  const { snooze } = useTaskSnooze();
  const [customDate, setCustomDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dateValid, setDateValid] = useState(true);

  const applySnooze = (preset: "tonight" | "in3Hours") => {
    snooze(task.id, new Date(resolveAbsolutePreset(preset)));
    onClose();
  };

  const applySchedule = async (date: string | null) => {
    if (saving || !date) return;
    setSaving(true);
    setError(null);
    try {
      await taskActions.update(task, { scheduledDate: date }, { scheduledDate: date }, true);
      onClose();
    } catch (cause) {
      setError(localizedErrorMessage(cause, strings));
      setSaving(false);
    }
  };

  return (
    <BottomSheet title={`${strings.later}: ${task.title}`} onClose={() => !saving && onClose()}>
      <div className="stack">
        <div>
          <p className="text-muted">{strings.laterSameDayHint}</p>
          <div className="choice-group" role="group" aria-label={strings.laterSameDayGroup}>
            <button
              type="button"
              className="choice-chip"
              disabled={saving}
              onClick={() => applySnooze("in3Hours")}
            >
              {strings.laterInAWhile}
            </button>
            <button
              type="button"
              className="choice-chip"
              disabled={saving}
              onClick={() => applySnooze("tonight")}
            >
              {strings.laterTonight}
            </button>
          </div>
        </div>
        <div>
          <p className="text-muted">{strings.laterFutureHint}</p>
          <div className="choice-group" role="group" aria-label={strings.laterFutureGroup}>
            <button
              type="button"
              className="choice-chip"
              disabled={saving}
              onClick={() => void applySchedule(resolveScheduleShortcut("tomorrow"))}
            >
              {strings.scheduleShortcutLabels.tomorrow}
            </button>
            <button
              type="button"
              className="choice-chip"
              disabled={saving}
              onClick={() => void applySchedule(resolveScheduleShortcut("weekend"))}
            >
              {strings.scheduleShortcutLabels.weekend}
            </button>
          </div>
          <div className="field">
            <label htmlFor={`later-custom-date-${task.id}`}>{strings.laterCustomDate}</label>
            <HumanDateInput
              id={`later-custom-date-${task.id}`}
              value={customDate}
              onChange={(date) => setCustomDate(date ?? "")}
              onValidityChange={setDateValid}
              disabled={saving}
            />
          </div>
        </div>

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
          <button
            type="button"
            className="btn"
            disabled={saving}
            onClick={() => dispatch({ type: "task.plan", taskId: task.id })}
          >
            {strings.laterMorePlanningOptions}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={saving || !dateValid || !customDate}
            onClick={() => void applySchedule(customDate || null)}
          >
            {strings.confirmDone}
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}
