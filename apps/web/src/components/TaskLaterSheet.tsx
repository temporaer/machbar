import { useState } from "react";
import type { Task } from "@machbar/shared";
import { useStrings } from "../lib/strings";
import { useTaskActions } from "../lib/useTaskActions";
import { useWorkItemCommands } from "../lib/useWorkItemCommands";
import { resolveAbsolutePreset } from "../lib/reminderPresets";
import { resolveScheduleShortcut } from "./ScheduleShortcuts";
import { localizedErrorMessage } from "../lib/errorMessage";
import { BottomSheet } from "./BottomSheet";
import { HumanDateInput } from "./HumanDateInput";

/**
 * Focused `task.later` workflow: edits the global "Ab …" availability gate.
 * Planning commitments and deadlines stay in the separate `task.plan`
 * workflow, reached by dispatching `task.plan` so `useWorkItemCommands()`
 * remains the only place deciding which workflow a command opens.
 */
export function TaskLaterSheet({ task, onClose }: { task: Task; onClose: () => void }) {
  const strings = useStrings();
  const taskActions = useTaskActions();
  const dispatch = useWorkItemCommands();
  const [customDate, setCustomDate] = useState("");
  const [customTime, setCustomTime] = useState("08:00");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dateValid, setDateValid] = useState(true);

  const customNotBeforeAt = () => {
    if (!customDate) return null;
    const [hours, minutes] = customTime.split(":").map(Number);
    if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
    const date = new Date(`${customDate}T00:00:00`);
    date.setHours(hours!, minutes!, 0, 0);
    return date.toISOString();
  };

  const startOfLocalDay = (date: string) => new Date(`${date}T00:00:00`).toISOString();

  const applyNotBefore = async (notBeforeAt: string | null) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await taskActions.update(task, { notBeforeAt }, { notBeforeAt }, true);
      onClose();
    } catch (cause) {
      setError(localizedErrorMessage(cause, strings));
      setSaving(false);
    }
  };

  return (
    <BottomSheet title={`${strings.notBefore}: ${task.title}`} onClose={() => !saving && onClose()}>
      <div className="stack">
        <div>
          <p className="text-muted">{strings.laterSameDayHint}</p>
          <div className="choice-group" role="group" aria-label={strings.laterSameDayGroup}>
            <button
              type="button"
              className="choice-chip"
              disabled={saving}
              onClick={() => void applyNotBefore(resolveAbsolutePreset("in3Hours"))}
            >
              {strings.laterInAWhile}
            </button>
            <button
              type="button"
              className="choice-chip"
              disabled={saving}
              onClick={() => void applyNotBefore(resolveAbsolutePreset("tonight"))}
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
              onClick={() => {
                const date = resolveScheduleShortcut("tomorrow");
                if (date) void applyNotBefore(startOfLocalDay(date));
              }}
            >
              {strings.scheduleShortcutLabels.tomorrow}
            </button>
            <button
              type="button"
              className="choice-chip"
              disabled={saving}
              onClick={() => {
                const date = resolveScheduleShortcut("weekend");
                if (date) void applyNotBefore(startOfLocalDay(date));
              }}
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
          <div className="field">
            <label htmlFor={`later-custom-time-${task.id}`}>{strings.laterCustomTime}</label>
            <input
              id={`later-custom-time-${task.id}`}
              type="time"
              value={customTime}
              onChange={(event) => setCustomTime(event.target.value)}
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
            disabled={saving || task.notBeforeAt === null}
            onClick={() => void applyNotBefore(null)}
          >
            {strings.clearNotBefore}
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
            disabled={saving || !dateValid || customNotBeforeAt() === null}
            onClick={() => void applyNotBefore(customNotBeforeAt())}
          >
            {strings.confirmDone}
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}
