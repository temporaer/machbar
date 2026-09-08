import { useState } from "react";
import type { Task } from "@machbar/shared";
import { api } from "../lib/api";
import { useStrings } from "../lib/strings";
import { useIdentity } from "../lib/identity";
import { useRefresh } from "../lib/refresh";
import { localizedErrorMessage } from "../lib/errorMessage";
import { BottomSheet } from "./BottomSheet";

/** Focused `task.addSuccessor` workflow — the canonical destination regardless of rail/keyboard/detail invocation. */
export function TaskSuccessorSheet({ task, onClose }: { task: Task; onClose: () => void }) {
  const strings = useStrings();
  const { currentMemberId } = useIdentity();
  const { bump } = useRefresh();
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const value = title.trim();
    if (saving || !value) return;
    setSaving(true);
    setError(null);
    try {
      await api.createTaskSuccessor(task.id, {
        title: value,
        createdByMemberId: currentMemberId,
        status: "actionable",
      });
      bump();
      onClose();
    } catch (cause) {
      setError(localizedErrorMessage(cause, strings));
      setSaving(false);
    }
  };

  return (
    <BottomSheet title={`${strings.addSuccessor}: ${task.title}`} onClose={() => !saving && onClose()}>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="field">
          <label htmlFor={`successor-title-${task.id}`}>{strings.addSuccessor}</label>
          <input
            id={`successor-title-${task.id}`}
            type="text"
            value={title}
            placeholder={strings.successorPlaceholder}
            disabled={saving}
            autoFocus
            onChange={(event) => setTitle(event.target.value)}
          />
        </div>
        {error ? (
          <div className="task-row-error" role="alert">
            {error}
          </div>
        ) : null}
        <div className="row">
          <button type="button" className="btn" disabled={saving} onClick={onClose}>
            {strings.cancel}
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving || !title.trim()}>
            {strings.save}
          </button>
        </div>
      </form>
    </BottomSheet>
  );
}
