import { useEffect, useState } from "react";
import {
  calendarDateForInstant,
  type Task,
} from "@machbar/shared";
import { useStrings } from "../lib/strings";
import { useTaskActions } from "../lib/useTaskActions";
import { addIsoCalendarDays, toIsoCalendarDate } from "../lib/naturalDate";
import { BottomSheet } from "./BottomSheet";
import { HumanDateInput } from "./HumanDateInput";
import { taskRevisitForLocalDate } from "../lib/taskAvailability";
import { useHouseholdTimezone } from "../lib/householdTimezone";

/**
 * The canonical `task.waitingLifecycle` workflow for a task that already
 * has an external wait ("Nachhaken") — `TaskWorkflowHost` resolves here
 *  whenever `task.externalWait` is set (see `TaskWaitSheet` for the "start
 *  waiting" case). Notes are optional; continuing or ending a wait is a
 *  complete action without text.
 */
export function WaitingFollowUpSheet({
  task,
  onClose,
}: {
  task: Task;
  onClose: () => void;
}) {
  const strings = useStrings();
  const taskActions = useTaskActions();
  const { timezone: householdTimezone, loaded: timezoneLoaded } =
    useHouseholdTimezone();
  const [content, setContent] = useState("");
  const [dateDraftChanged, setDateDraftChanged] = useState(false);
  const [revisitDate, setRevisitDate] = useState<string | null>(
    task.revisitAt
      ? calendarDateForInstant(task.revisitAt, householdTimezone)
      : null,
  );
  const [customDate, setCustomDate] = useState(false);
  const [dateValid, setDateValid] = useState(true);
  const [revisitError, setRevisitError] = useState(false);
  const saving = taskActions.isPending(task.id);
  const error = taskActions.errors[task.id] ?? null;
  const customRevisitAt = revisitDate
    ? taskRevisitForLocalDate(revisitDate, task.revisitAt, householdTimezone)
    : null;
  const invalidCustomDate =
    customDate &&
    (!revisitDate || !dateValid || !customRevisitAt);
  const closeIfIdle = () => {
    if (!saving) onClose();
  };
  const today = () =>
    calendarDateForInstant(new Date().toISOString(), householdTimezone) ??
    toIsoCalendarDate(new Date());

  useEffect(() => {
    if (dateDraftChanged) return;
    setRevisitDate(
      task.revisitAt
        ? calendarDateForInstant(task.revisitAt, householdTimezone)
        : null,
    );
  }, [dateDraftChanged, householdTimezone, task.revisitAt]);

  const continueWaiting = async (
    nextRevisitDate: string | null,
    fromShortcut = false,
  ) => {
    if (
      saving ||
      !timezoneLoaded ||
      (!fromShortcut && customDate && !dateValid)
    ) return;
    if (!fromShortcut && customDate && !nextRevisitDate) {
      setRevisitError(true);
      return;
    }
    const revisitAt = nextRevisitDate
      ? taskRevisitForLocalDate(
          nextRevisitDate,
          task.revisitAt,
          householdTimezone,
        )
      : null;
    if (nextRevisitDate && !revisitAt) {
      setRevisitError(true);
      return;
    }
    setRevisitError(false);
    taskActions.clearError(task.id);
    const updated = await taskActions.followUpExternalWait(task, {
      action: "continue",
      ...(content.trim() ? { content: content.trim() } : {}),
      waitingFor: task.externalWait?.waitingFor ?? null,
      revisitAt,
    });
    if (updated) onClose();
  };

  const endWaiting = async () => {
    if (saving) return;
    taskActions.clearError(task.id);
    const updated = await taskActions.followUpExternalWait(task, {
      action: "resolve",
      ...(content.trim() ? { content: content.trim() } : {}),
    });
    if (updated) onClose();
  };

  return (
    <BottomSheet
      title={`${strings.followUp}: ${task.title}`}
      onClose={closeIfIdle}
    >
      <div className="stack">
        <div className="field">
          <label htmlFor={`follow-up-notes-${task.id}`}>
            {strings.waitingFollowUpNote}
          </label>
          <textarea
            id={`follow-up-notes-${task.id}`}
            rows={4}
            value={content}
            placeholder={strings.waitingFollowUpNotePlaceholder}
            onChange={(event) => setContent(event.target.value)}
            disabled={saving}
            autoFocus
            aria-label={strings.notes}
          />
        </div>

        <div className="field">
          <span className="field-label">{strings.continueWaiting}</span>
          <div className="choice-group" role="group" aria-label={strings.continueWaiting}>
            <button
              type="button"
              className="choice-chip"
              disabled={saving || !timezoneLoaded}
              onClick={() => {
                setCustomDate(false);
                setDateValid(true);
                setRevisitError(false);
                void continueWaiting(addIsoCalendarDays(today(), 1), true);
              }}
            >
              {strings.revisitShortcutLabels.tomorrow}
            </button>
            <button
              type="button"
              className="choice-chip"
              disabled={saving || !timezoneLoaded}
              onClick={() => {
                setCustomDate(false);
                setDateValid(true);
                setRevisitError(false);
                void continueWaiting(addIsoCalendarDays(today(), 3), true);
              }}
            >
              {strings.revisitShortcutLabels.threeDays}
            </button>
            <button
              type="button"
              className="choice-chip"
              disabled={saving || !timezoneLoaded}
              onClick={() => {
                setCustomDate(false);
                setDateValid(true);
                setRevisitError(false);
                void continueWaiting(addIsoCalendarDays(today(), 7), true);
              }}
            >
              {strings.revisitShortcutLabels.oneWeek}
            </button>
            <button
              type="button"
              className="choice-chip"
              aria-pressed={customDate}
              disabled={saving || !timezoneLoaded}
              onClick={() => setCustomDate(true)}
            >
              {strings.chooseRevisitDate}
            </button>
          </div>
          {customDate ? (
            <div className="row">
              <HumanDateInput
                id={`follow-up-date-${task.id}`}
                value={revisitDate ?? ""}
                onChange={(date) => {
                  setRevisitDate(date);
                  setDateDraftChanged(true);
                  setRevisitError(false);
                }}
                onValidityChange={setDateValid}
                disabled={saving || !timezoneLoaded}
              />
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={
                  saving || !timezoneLoaded || !dateValid || invalidCustomDate
                }
                onClick={() => void continueWaiting(revisitDate)}
              >
                {strings.save}
              </button>
            </div>
          ) : null}
        </div>

        {revisitError || invalidCustomDate ? (
          <div className="task-row-error" role="alert">
            {!revisitDate && dateValid
              ? strings.revisitDateRequired
              : strings.invalidRevisitTime}
          </div>
        ) : null}
        {error ? (
          <div className="task-row-error" role="alert">
            {error}
          </div>
        ) : null}

        <div className="row">
          <button type="button" className="btn" onClick={closeIfIdle} disabled={saving}>
            {strings.cancel}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void endWaiting()}
            disabled={saving}
          >
            {strings.endWaiting}
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}
