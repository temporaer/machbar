import { useMemo, useState } from "react";
import type { Task } from "@machbar/shared";
import { api } from "../lib/api";
import { useIdentity } from "../lib/identity";
import { useRefresh } from "../lib/refresh";
import { strings } from "../lib/strings";
import { BottomSheet } from "./BottomSheet";
import { HumanDateInput } from "./HumanDateInput";

export function followUpEntryHeader(memberName: string, now = new Date()): string {
  const timestamp = new Intl.DateTimeFormat("de-DE", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(now);
  return `[${timestamp} · ${memberName}]`;
}

function initialFollowUpNote(task: Task, memberName: string): string {
  const prefix = task.notes.trim() ? `${task.notes.trimEnd()}\n\n` : "";
  return `${prefix}${followUpEntryHeader(memberName)}\n`;
}

export function WaitingFollowUpSheet({
  task,
  onClose,
}: {
  task: Task;
  onClose: () => void;
}) {
  const { currentMember } = useIdentity();
  const { bump } = useRefresh();
  const memberName = currentMember?.name ?? strings.unknownMember;
  const initialNotes = useMemo(
    () => initialFollowUpNote(task, memberName),
    [task, memberName],
  );
  const [notes, setNotes] = useState(initialNotes);
  const [scheduledDate, setScheduledDate] = useState(task.scheduledDate ?? "");
  const [makeActionable, setMakeActionable] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scheduledDateValid, setScheduledDateValid] = useState(true);
  const closeIfValid = () => {
    if (scheduledDateValid) onClose();
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.updateTask(task.id, {
        notes,
        scheduledDate: scheduledDate || null,
        ...(makeActionable ? { status: "actionable" as const } : {}),
      });
      bump();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <BottomSheet
      title={`${strings.followUp}: ${task.title}`}
      onClose={closeIfValid}
    >
      <div className="stack">
        <div className="field">
          <label htmlFor={`follow-up-notes-${task.id}`}>{strings.notes}</label>
          <textarea
            id={`follow-up-notes-${task.id}`}
            rows={6}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
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
          />
        </div>

        <label className="row">
          <input
            type="checkbox"
            checked={makeActionable}
            onChange={(event) => setMakeActionable(event.target.checked)}
          />
          {strings.makeActionable}
        </label>

        {error ? (
          <div className="task-row-error" role="alert">
            {error}
          </div>
        ) : null}

        <div className="row">
          <button type="button" className="btn" onClick={closeIfValid} disabled={saving}>
            {strings.close}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void save()}
            disabled={saving || notes.trim().length === 0 || !scheduledDateValid}
          >
            {strings.saveChanges}
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}
