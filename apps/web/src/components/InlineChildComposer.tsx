import { useState } from "react";
import { useStrings } from "../lib/strings";
import { localizedErrorMessage } from "../lib/errorMessage";
import { useRefresh } from "../lib/refresh";
import { useIdentity } from "../lib/identity";
import { api } from "../lib/api";

export interface InlineChildComposerProps {
  /** The task this composer creates a direct child of — any depth, not just root tasks. */
  parentId: number;
  /** Cancel/dismiss without ever calling the API — no mutation happens. */
  onCancel: () => void;
  /**
   * Called once the child task was created successfully (after the refresh
   * bus was already bumped). The caller owns expanding its own collapsed
   * state and returning focus, since that state lives outside this component.
   */
  onCreated: () => void;
}

/**
 * Small inline composer rendered directly beneath a `TaskRow`, as an
 * alternative to opening the full `TaskDetailSheet` just to add a subtask.
 * Mirrors the focused quick-edit sheets (see `TaskQuickActionSheet`) in
 * spirit — a single field, save/cancel, errors stay visible — but renders
 * in place instead of as a sheet.
 */
export function InlineChildComposer({ parentId, onCancel, onCreated }: InlineChildComposerProps) {
  const strings = useStrings();
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { currentMemberId } = useIdentity();
  const { bump } = useRefresh();
  const inputId = `inline-child-title-${parentId}`;

  const submit = async () => {
    // Busy prevention: a stray double submit (double click / double enter)
    // must never fire a second create request while the first is in flight.
    if (saving) return;
    const trimmed = title.trim();
    if (!trimmed) return;
    setSaving(true);
    setError(null);
    try {
      await api.createChildTask(parentId, {
        title: trimmed,
        createdByMemberId: currentMemberId,
        status: "actionable",
      });
      bump();
      onCreated();
    } catch (err) {
      // Keep the composer open with the entered title and a visible error
      // so nothing is silently lost.
      setError(localizedErrorMessage(err, strings));
      setSaving(false);
    }
  };

  return (
    <form
      className="inline-child-composer"
      aria-label={strings.addChildTitle}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={inputId} className="sr-only">
        {strings.addChildTitle}
      </label>
      <input
        id={inputId}
        autoFocus
        value={title}
        placeholder={strings.addChildTitle}
        disabled={saving}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      {error ? (
        <div className="task-row-error" role="alert">
          <span>{strings.error}</span>
          <span className="text-muted">{error}</span>
        </div>
      ) : null}
      <div className="row">
        <button type="button" className="btn btn-sm btn-ghost" disabled={saving} onClick={onCancel}>
          {strings.cancel}
        </button>
        <button type="submit" className="btn btn-sm btn-primary" disabled={saving || !title.trim()}>
          {strings.save}
        </button>
      </div>
    </form>
  );
}
