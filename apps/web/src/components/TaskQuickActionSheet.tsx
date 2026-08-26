import { useState } from "react";
import type { InheritanceMode, Task } from "@machbar/shared";
import type { UpdateTaskInput } from "../lib/api";
import { strings } from "../lib/strings";
import { AssignOwnerSheet } from "./AssignOwnerSheet";
import { BottomSheet } from "./BottomSheet";
import { ScheduleShortcuts } from "./ScheduleShortcuts";

export type TaskQuickAction = "owner" | "schedule" | "notes";

/**
 * Patch (plus its optimistic counterpart) for a task ownership change.
 * Exported so every targeted assignment surface derives the exact same
 * `ownerMemberId`/`ownerInheritanceMode` pair — an explicit member always
 * becomes an `explicit` owner, clearing it drops inheritance entirely
 * (`none`) rather than falling back to the parent/project owner.
 */
export function ownerAssignmentPatch(ownerMemberId: number | null): {
  ownerMemberId: number | null;
  ownerInheritanceMode: InheritanceMode;
} {
  return {
    ownerMemberId,
    ownerInheritanceMode: ownerMemberId === null ? "none" : "explicit",
  };
}

interface TaskQuickActionSheetProps {
  task: Task;
  action: TaskQuickAction;
  onClose: () => void;
  onSave: (
    patch: UpdateTaskInput,
    optimisticPatch?: Partial<Task>,
  ) => Promise<void>;
}

export function TaskQuickActionSheet({
  task,
  action,
  onClose,
  onSave,
}: TaskQuickActionSheetProps) {
  const [scheduledDate, setScheduledDate] = useState(task.scheduledDate ?? "");
  const [notes, setNotes] = useState(task.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const title = {
    owner: strings.assign,
    schedule: strings.schedule,
    notes: strings.notes,
  }[action];

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      if (action === "schedule") {
        await onSave(
          { scheduledDate: scheduledDate || null },
          { scheduledDate: scheduledDate || null },
        );
      } else {
        await onSave({ notes }, { notes });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  // Assignment is its own reusable focused sheet, shared verbatim with the
  // refinement list's `Zuweisen` chip — see `AssignOwnerSheet`.
  if (action === "owner") {
    return (
      <AssignOwnerSheet
        title={`${title}: ${task.title}`}
        groupId={`quick-owner-${task.id}`}
        currentOwnerId={task.effectiveOwnerId}
        onClose={onClose}
        onAssign={(ownerMemberId) =>
          onSave(ownerAssignmentPatch(ownerMemberId), {
            ...ownerAssignmentPatch(ownerMemberId),
            effectiveOwnerId: ownerMemberId,
            effectiveOwnerSource: ownerMemberId === null ? "none" : "task",
          })
        }
      />
    );
  }

  return (
    <BottomSheet title={`${title}: ${task.title}`} onClose={onClose}>
      <div className="stack task-quick-action-sheet">
        {action === "schedule" ? (
          <>
            <div className="field">
              <label htmlFor={`quick-schedule-${task.id}`}>{strings.scheduled}</label>
              <input
                id={`quick-schedule-${task.id}`}
                type="date"
                value={scheduledDate}
                onChange={(event) => setScheduledDate(event.target.value)}
                autoFocus
              />
            </div>
            <ScheduleShortcuts value={scheduledDate} onChange={setScheduledDate} disabled={saving} />
          </>
        ) : null}

        {action === "notes" ? (
          <div className="field">
            <label htmlFor={`quick-notes-${task.id}`}>{strings.notes}</label>
            <textarea
              id={`quick-notes-${task.id}`}
              rows={5}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              autoFocus
            />
          </div>
        ) : null}

        {error ? <div className="task-row-error" role="alert">{error}</div> : null}

        <div className="row">
          <button type="button" className="btn" onClick={onClose} disabled={saving}>
            {strings.close}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={saving}>
            {strings.saveChanges}
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}
