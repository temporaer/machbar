import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { Task } from "@machbar/shared";
import { BottomSheet } from "./BottomSheet";
import { useStrings } from "../lib/strings";
import { useHouseholdTimezone } from "../lib/householdTimezone";
import { calendarDateForInstant } from "@machbar/shared";
import { addIsoCalendarDays } from "../lib/naturalDate";
import { useTaskActions } from "../lib/useTaskActions";
import { localizedErrorMessage } from "../lib/errorMessage";

export function TaskClarificationSheet({
  task,
  onClose,
}: {
  task: Task;
  onClose: () => void;
}) {
  const strings = useStrings();
  const { timezone, loaded } = useHouseholdTimezone();
  const taskActions = useTaskActions();
  const today = calendarDateForInstant(new Date().toISOString(), timezone) ?? "";
  const [date, setDate] = useState(
    task.clarificationRevisitDate ?? (today ? addIsoCalendarDays(today, 1) : ""),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loaded || task.clarificationRevisitDate) return;
    const currentDate = calendarDateForInstant(new Date().toISOString(), timezone);
    if (currentDate) setDate(addIsoCalendarDays(currentDate, 1));
  }, [loaded, task.clarificationRevisitDate, timezone]);

  const minDate = today ? addIsoCalendarDays(today, 1) : undefined;
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!minDate || date < minDate) {
      setError(strings.clarificationRevisitFutureError);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await taskActions.deferClarification(task, date, true);
      onClose();
    } catch (cause) {
      setError(localizedErrorMessage(cause, strings));
    } finally {
      setSaving(false);
    }
  };

  return (
    <BottomSheet title={strings.clarificationRevisitTitle} onClose={onClose}>
      <form className="stack" onSubmit={(event) => void submit(event)}>
        <p className="text-muted">{strings.clarificationRevisitNote}</p>
        <label htmlFor={`clarification-revisit-${task.id}`}>
          {strings.clarificationRevisitDate}
        </label>
        <input
          id={`clarification-revisit-${task.id}`}
          type="date"
          min={minDate}
          value={date}
          disabled={!loaded || saving}
          onChange={(event) => setDate(event.target.value)}
          required
        />
        {error ? <p className="human-date-error" role="alert">{error}</p> : null}
        <div className="row row-end">
          <button type="button" className="btn" disabled={saving} onClick={onClose}>
            {strings.cancel}
          </button>
          <button type="submit" className="btn btn-primary" disabled={!loaded || saving || !date}>
            {saving ? strings.saving : strings.save}
          </button>
        </div>
      </form>
    </BottomSheet>
  );
}
