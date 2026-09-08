import { useState } from "react";
import type { Task } from "@machbar/shared";
import { useStrings } from "../lib/strings";
import { useTaskActions } from "../lib/useTaskActions";
import { addIsoCalendarDays, toIsoCalendarDate } from "../lib/naturalDate";
import { BottomSheet } from "./BottomSheet";
import { HumanDateInput } from "./HumanDateInput";

/**
 * The canonical `task.waitingLifecycle` workflow for a task that already
 * has an external wait ("Nachhaken") — `TaskWorkflowHost` resolves here
 * whenever `task.externalWait` is set (see `TaskWaitSheet` for the "start
 * waiting" case). The decision is structured around the outcome first
 * ("Was ist passiert?"), then either "Weiter warten" with quick revisit
 * shortcuts or a separate, equally-weighted "Warten beenden" — not a
 * generic textarea + date + checkbox + Save form.
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
  const [content, setContent] = useState("");
  const [revisitDate, setRevisitDate] = useState<string | null>(
    task.externalWait?.revisitDate ?? null,
  );
  const [customDate, setCustomDate] = useState(false);
  const [dateValid, setDateValid] = useState(true);
  const saving = taskActions.isPending(task.id);
  const error = taskActions.errors[task.id] ?? null;
  const closeIfIdle = () => {
    if (!saving) onClose();
  };
  const today = () => toIsoCalendarDate(new Date());

  const continueWaiting = async (nextRevisitDate: string | null) => {
    if (saving || !dateValid) return;
    taskActions.clearError(task.id);
    const updated = await taskActions.followUpExternalWait(task, {
      action: "continue",
      content: content.trim(),
      waitingFor: task.externalWait?.waitingFor ?? null,
      revisitDate: nextRevisitDate,
    });
    if (updated) onClose();
  };

  const endWaiting = async () => {
    if (saving) return;
    taskActions.clearError(task.id);
    const updated = await taskActions.followUpExternalWait(task, {
      action: "resolve",
      content: content.trim(),
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
          <label htmlFor={`follow-up-notes-${task.id}`}>{strings.whatHappened}</label>
          <textarea
            id={`follow-up-notes-${task.id}`}
            rows={4}
            value={content}
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
              disabled={saving}
              onClick={() => void continueWaiting(addIsoCalendarDays(today(), 1))}
            >
              {strings.revisitShortcutLabels.tomorrow}
            </button>
            <button
              type="button"
              className="choice-chip"
              disabled={saving}
              onClick={() => void continueWaiting(addIsoCalendarDays(today(), 3))}
            >
              {strings.revisitShortcutLabels.threeDays}
            </button>
            <button
              type="button"
              className="choice-chip"
              disabled={saving}
              onClick={() => void continueWaiting(addIsoCalendarDays(today(), 7))}
            >
              {strings.revisitShortcutLabels.oneWeek}
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
                id={`follow-up-date-${task.id}`}
                value={revisitDate ?? ""}
                onChange={(date) => setRevisitDate(date)}
                onValidityChange={setDateValid}
                disabled={saving}
              />
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={saving || !dateValid}
                onClick={() => void continueWaiting(revisitDate)}
              >
                {strings.save}
              </button>
            </div>
          ) : null}
        </div>

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
            className="btn btn-primary btn-danger"
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
