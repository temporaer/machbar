import { useState } from "react";
import type { Task } from "@machbar/shared";
import { useStrings } from "../lib/strings";
import { useTaskActions } from "../lib/useTaskActions";
import { localizedErrorMessage } from "../lib/errorMessage";
import { BottomSheet } from "./BottomSheet";

const PRIORITIES = [1, 2, 3, 4, 5] as const;

/** Focused `task.priority` editor — the canonical destination regardless of rail/keyboard/detail invocation. */
export function TaskPrioritySheet({ task, onClose }: { task: Task; onClose: () => void }) {
  const strings = useStrings();
  const taskActions = useTaskActions();
  const [saveError, setSaveError] = useState<string | null>(null);
  const saving = taskActions.isPending(task.id);

  const choose = async (priority: number | null) => {
    setSaveError(null);
    try {
      await taskActions.update(task, { priority }, { priority }, true);
      onClose();
    } catch (cause) {
      setSaveError(localizedErrorMessage(cause, strings));
    }
  };

  return (
    <BottomSheet
      title={`${strings.priority}: ${task.title}`}
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      <div className="stack">
        <div className="choice-group" role="group" aria-label={strings.priority}>
          <button
            type="button"
            className="choice-chip"
            aria-pressed={task.priority === null}
            disabled={saving}
            onClick={() => void choose(null)}
          >
            {strings.none}
          </button>
          {PRIORITIES.map((value) => (
            <button
              key={value}
              type="button"
              className="choice-chip"
              aria-pressed={task.priority === value}
              disabled={saving}
              onClick={() => void choose(value)}
            >
              {value === 1
                ? `1 – ${strings.priorityHighest}`
                : value === 5
                  ? `5 – ${strings.priorityLowest}`
                  : String(value)}
            </button>
          ))}
        </div>
        {saveError ? (
          <div className="task-row-error" role="alert">
            {saveError}
          </div>
        ) : null}
        <button type="button" className="btn" disabled={saving} onClick={onClose}>
          {strings.cancel}
        </button>
      </div>
    </BottomSheet>
  );
}
