import { useState } from "react";
import type { Task } from "@machbar/shared";
import { useStrings } from "../lib/strings";
import { useTaskActions } from "../lib/useTaskActions";
import { BottomSheet } from "./BottomSheet";
import { HumanDateInput } from "./HumanDateInput";

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
  const [revisitDate, setRevisitDate] = useState(
    task.externalWait?.revisitDate ?? "",
  );
  const [resolveWait, setResolveWait] = useState(false);
  const [revisitDateValid, setRevisitDateValid] = useState(true);
  const saving = taskActions.isPending(task.id);
  const error = taskActions.errors[task.id] ?? null;
  const closeIfIdle = () => {
    if (!saving) onClose();
  };

  const save = async () => {
    taskActions.clearError(task.id);
    const updated = await taskActions.followUpExternalWait(
      task,
      resolveWait
        ? {
            action: "resolve",
            content: content.trim(),
          }
        : {
            action: "continue",
            content: content.trim(),
            waitingFor: task.externalWait?.waitingFor ?? null,
            revisitDate: revisitDate || null,
          },
    );
    if (updated) onClose();
  };

  return (
    <BottomSheet
      title={`${strings.followUp}: ${task.title}`}
      onClose={closeIfIdle}
    >
      <div className="stack">
        <div className="field">
          <label htmlFor={`follow-up-notes-${task.id}`}>{strings.notes}</label>
          <textarea
            id={`follow-up-notes-${task.id}`}
            rows={6}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            disabled={saving}
            autoFocus
          />
        </div>

        <div className="field">
          <label htmlFor={`follow-up-date-${task.id}`}>
            {strings.newRevisitDate}
          </label>
          <HumanDateInput
            id={`follow-up-date-${task.id}`}
            value={revisitDate}
            onChange={(date) => setRevisitDate(date ?? "")}
            onValidityChange={setRevisitDateValid}
            disabled={saving}
          />
        </div>

        <label className="row">
          <input
            type="checkbox"
            checked={resolveWait}
            onChange={(event) => setResolveWait(event.target.checked)}
            disabled={saving}
          />
          {strings.endWaiting}
        </label>

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
            onClick={() => void save()}
            disabled={saving || content.trim().length === 0 || !revisitDateValid}
          >
            {strings.save}
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}
