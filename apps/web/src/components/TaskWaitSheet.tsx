import { useState } from "react";
import type { Task } from "@machbar/shared";
import { useStrings } from "../lib/strings";
import { useTaskActions } from "../lib/useTaskActions";
import { localizedErrorMessage } from "../lib/errorMessage";
import { addIsoCalendarDays, toIsoCalendarDate } from "../lib/naturalDate";
import { BottomSheet } from "./BottomSheet";
import { HumanDateInput } from "./HumanDateInput";

/**
 * The canonical `task.waitingLifecycle` workflow for a task with no
 * external wait yet — `TaskWorkflowHost` resolves to this component
 * instead of `WaitingFollowUpSheet` once `task.externalWait` is null (see
 * that component for the "already waiting" case).
 */
export function TaskWaitSheet({ task, onClose }: { task: Task; onClose: () => void }) {
  const strings = useStrings();
  const taskActions = useTaskActions();
  const [waitingFor, setWaitingFor] = useState("");
  const [revisitDate, setRevisitDate] = useState<string | null>(null);
  const [customDate, setCustomDate] = useState(false);
  const [dateValid, setDateValid] = useState(true);
  const saving = taskActions.isPending(task.id);
  const error = taskActions.errors[task.id] ?? null;

  const today = () => toIsoCalendarDate(new Date());

  const commit = async () => {
    if (saving || !waitingFor.trim() || !dateValid) return;
    taskActions.clearError(task.id);
    const updated = await taskActions.setExternalWait(
      task,
      { waitingFor: waitingFor.trim(), revisitDate },
      { throwOnError: false },
    );
    if (updated) onClose();
  };

  return (
    <BottomSheet
      title={`${strings.markAsWaiting}: ${task.title}`}
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
          <label htmlFor={`wait-for-${task.id}`}>{strings.taskWaitQuestion}</label>
          <input
            id={`wait-for-${task.id}`}
            type="text"
            value={waitingFor}
            placeholder={strings.waitingForPlaceholder}
            disabled={saving}
            autoFocus
            onChange={(event) => setWaitingFor(event.target.value)}
          />
        </div>

        <div className="field">
          <span className="field-label">{strings.taskWaitRevisitQuestion}</span>
          <div className="choice-group" role="group" aria-label={strings.taskWaitRevisitQuestion}>
            <button
              type="button"
              className="choice-chip"
              aria-pressed={!customDate && revisitDate === addIsoCalendarDays(today(), 1)}
              disabled={saving}
              onClick={() => {
                setCustomDate(false);
                setRevisitDate(addIsoCalendarDays(today(), 1));
              }}
            >
              {strings.revisitShortcutLabels.tomorrow}
            </button>
            <button
              type="button"
              className="choice-chip"
              aria-pressed={!customDate && revisitDate === addIsoCalendarDays(today(), 3)}
              disabled={saving}
              onClick={() => {
                setCustomDate(false);
                setRevisitDate(addIsoCalendarDays(today(), 3));
              }}
            >
              {strings.revisitShortcutLabels.threeDays}
            </button>
            <button
              type="button"
              className="choice-chip"
              aria-pressed={!customDate && revisitDate === addIsoCalendarDays(today(), 7)}
              disabled={saving}
              onClick={() => {
                setCustomDate(false);
                setRevisitDate(addIsoCalendarDays(today(), 7));
              }}
            >
              {strings.revisitShortcutLabels.oneWeek}
            </button>
            <button
              type="button"
              className="choice-chip"
              aria-pressed={!customDate && revisitDate === null}
              disabled={saving}
              onClick={() => {
                setCustomDate(false);
                setRevisitDate(null);
              }}
            >
              {strings.revisitShortcutLabels.noDate}
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
            <HumanDateInput
              id={`wait-revisit-${task.id}`}
              value={revisitDate ?? ""}
              onChange={(date) => setRevisitDate(date)}
              onValidityChange={setDateValid}
              disabled={saving}
            />
          ) : null}
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
            type="submit"
            className="btn btn-primary"
            disabled={saving || !waitingFor.trim() || !dateValid}
          >
            {strings.startWaitingConfirm}
          </button>
        </div>
      </form>
    </BottomSheet>
  );
}
