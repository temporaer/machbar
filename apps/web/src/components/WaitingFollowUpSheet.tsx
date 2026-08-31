import { useState } from "react";
import type { Task } from "@machbar/shared";
import { api } from "../lib/api";
import { useRefresh } from "../lib/refresh";
import { useStrings } from "../lib/strings";
import { BottomSheet } from "./BottomSheet";
import { HumanDateInput } from "./HumanDateInput";
import {
  isStaleWriteConflict,
  localizedErrorMessage,
} from "../lib/errorMessage";

export function WaitingFollowUpSheet({
  task,
  onClose,
}: {
  task: Task;
  onClose: () => void;
}) {
  const strings = useStrings();
  const { bump } = useRefresh();
  const [content, setContent] = useState("");
  const [scheduledDate, setScheduledDate] = useState(task.scheduledDate ?? "");
  const [resolveWait, setResolveWait] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scheduledDateValid, setScheduledDateValid] = useState(true);
  const closeIfIdle = () => {
    if (!saving) onClose();
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.followUpExternalWait(
        task.id,
        resolveWait
          ? {
              action: "resolve",
              content: content.trim(),
              expectedRevision: task.revision,
            }
          : {
              action: "continue",
              content: content.trim(),
              waitingFor: task.externalWait?.waitingFor ?? null,
              scheduledDate: scheduledDate || null,
              expectedRevision: task.revision,
            },
      );
      bump();
      onClose();
    } catch (err) {
      if (isStaleWriteConflict(err)) bump();
      setError(localizedErrorMessage(err, strings));
    } finally {
      setSaving(false);
    }
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
            value={scheduledDate}
            onChange={(date) => setScheduledDate(date ?? "")}
            onValidityChange={setScheduledDateValid}
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
          {strings.resolveExternalWait}
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
            disabled={saving || content.trim().length === 0 || !scheduledDateValid}
          >
            {strings.save}
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}
