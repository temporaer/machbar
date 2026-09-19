import { useState } from "react";
import type { Task } from "@machbar/shared";
import { useStrings } from "../lib/strings";
import { useTaskActions } from "../lib/useTaskActions";
import { useWorkItemCommands } from "../lib/useWorkItemCommands";
import {
  absolutePresetIsFuture,
  resolveAbsolutePreset,
} from "../lib/reminderPresets";
import { localDateForInstant, localDateTimeToIso } from "../lib/localDateTime";
import { resolveScheduleShortcut } from "./ScheduleShortcuts";
import { localizedErrorMessage } from "../lib/errorMessage";
import { BottomSheet } from "./BottomSheet";
import { HumanDateInput } from "./HumanDateInput";

/**
 * Focused `task.availability` workflow: edits the global "Ab …" availability gate.
 * Planning commitments and deadlines stay in the separate `task.plan`
 * workflow, reached by dispatching `task.plan` so `useWorkItemCommands()`
 * remains the only place deciding which workflow a command opens.
 */
export function TaskAvailabilitySheet({ task, onClose }: { task: Task; onClose: () => void }) {
  const strings = useStrings();
  const taskActions = useTaskActions();
  const dispatch = useWorkItemCommands();
  const [customDate, setCustomDate] = useState("");
  const [customTime, setCustomTime] = useState("08:00");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dateValid, setDateValid] = useState(true);
  const tonightAvailable = absolutePresetIsFuture("tonight");

  const customNotBeforeAt = () => {
    if (!customDate) return null;
    return localDateTimeToIso(customDate, customTime);
  };

  const applyNotBefore = async (notBeforeAt: string | null, notBeforeDate: string | null) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await taskActions.update(
        task,
        { notBeforeAt, notBeforeDate },
        { notBeforeAt, notBeforeDate },
        true,
      );
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
          <p className="text-muted">{strings.availabilitySameDayHint}</p>
          <div className="choice-group" role="group" aria-label={strings.availabilitySameDayGroup}>
            <button
              type="button"
              className="choice-chip"
              disabled={saving}
              onClick={() => {
                const instant = resolveAbsolutePreset("in3Hours");
                void applyNotBefore(instant, localDateForInstant(instant));
              }}
            >
              {strings.availabilityInAWhile}
            </button>
            {tonightAvailable ? (
              <button
                type="button"
                className="choice-chip"
                disabled={saving}
                onClick={() => {
                  if (!absolutePresetIsFuture("tonight")) return;
                  const instant = resolveAbsolutePreset("tonight");
                  void applyNotBefore(instant, localDateForInstant(instant));
                }}
              >
                {strings.availabilityTonight}
              </button>
            ) : null}
          </div>
        </div>
        <div>
          <p className="text-muted">{strings.availabilityFutureHint}</p>
          <div className="choice-group" role="group" aria-label={strings.availabilityFutureGroup}>
            <button
              type="button"
              className="choice-chip"
              disabled={saving}
              onClick={() => {
                const date = resolveScheduleShortcut("tomorrow");
                if (date) void applyNotBefore(localDateTimeToIso(date, "00:00"), date);
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
                if (date) void applyNotBefore(localDateTimeToIso(date, "00:00"), date);
              }}
            >
              {strings.scheduleShortcutLabels.weekend}
            </button>
          </div>
          <div className="field">
            <label htmlFor={`availability-custom-date-${task.id}`}>
              {strings.availabilityCustomDate}
            </label>
            <HumanDateInput
              id={`availability-custom-date-${task.id}`}
              value={customDate}
              onChange={(date) => setCustomDate(date ?? "")}
              onValidityChange={setDateValid}
              disabled={saving}
            />
          </div>
          <div className="field">
            <label htmlFor={`availability-custom-time-${task.id}`}>
              {strings.availabilityCustomTime}
            </label>
            <input
              id={`availability-custom-time-${task.id}`}
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
            onClick={() => void applyNotBefore(null, null)}
          >
            {strings.clearNotBefore}
          </button>
          <button
            type="button"
            className="btn"
            disabled={saving}
            onClick={() => dispatch({ type: "task.plan", taskId: task.id })}
          >
            {strings.availabilityMorePlanningOptions}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={saving || !dateValid || customNotBeforeAt() === null}
            onClick={() => void applyNotBefore(customNotBeforeAt(), customDate)}
          >
            {strings.confirmDone}
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}
