import { useState } from "react";
import type { GoalArea, GoalWithInterventions } from "@machbar/shared";
import { localizedErrorMessage } from "../lib/errorMessage";
import { useStrings } from "../lib/strings";
import { BottomSheet } from "./BottomSheet";

/**
 * Create or edit a goal's authored fields (title, notes, and — on creation —
 * its area). Atomic goal metadata saves through the one canonical goal
 * mutation path owned by the Goals page; this sheet only collects input.
 */
export function GoalFormSheet({
  goal,
  onClose,
  onSave,
}: {
  goal?: GoalWithInterventions;
  onClose: () => void;
  onSave: (input: { title: string; notes: string; area: GoalArea }) => Promise<void>;
}) {
  const strings = useStrings();
  const editing = goal !== undefined;
  const [title, setTitle] = useState(goal?.title ?? "");
  const [notes, setNotes] = useState(goal?.notes ?? "");
  const [area, setArea] = useState<GoalArea>(goal?.area ?? "personal");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (saving) return;
    const trimmed = title.trim();
    if (!trimmed) {
      setError(strings.goalTitleLabel);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({ title: trimmed, notes: notes.trim(), area });
      onClose();
    } catch (cause) {
      setError(localizedErrorMessage(cause, strings));
    } finally {
      setSaving(false);
    }
  };

  return (
    <BottomSheet
      title={editing ? strings.editGoal : strings.newGoal}
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      <div className="stack">
        <label className="field">
          <span className="field-label">{strings.goalTitleLabel}</span>
          <input
            type="text"
            value={title}
            disabled={saving}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">{strings.goalNotesLabel}</span>
          <textarea
            value={notes}
            rows={3}
            disabled={saving}
            onChange={(event) => setNotes(event.target.value)}
          />
        </label>
        {editing ? null : (
          <div className="field">
            <span className="field-label">{strings.goalAreaLabel}</span>
            <div className="choice-group" role="group" aria-label={strings.goalAreaLabel}>
              {(
                [
                  ["personal", strings.goalAreaPersonal],
                  ["work", strings.goalAreaWork],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className="choice-chip"
                  aria-pressed={area === value}
                  disabled={saving}
                  onClick={() => setArea(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}
        {error ? (
          <div className="task-row-error" role="alert">
            {error}
          </div>
        ) : null}
        <div className="row">
          <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void submit()}>
            {editing ? strings.saveGoal : strings.createGoal}
          </button>
          <button type="button" className="btn" disabled={saving} onClick={onClose}>
            {strings.cancel}
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}
