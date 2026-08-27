import { useRef, useState } from "react";
import { api } from "../lib/api";
import { strings } from "../lib/strings";
import { useIdentity } from "../lib/identity";
import { useRefresh } from "../lib/refresh";

export function InlineSuccessorComposer({
  predecessorId,
  onCancel,
  onCreated,
}: {
  predecessorId: number;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const { currentMemberId } = useIdentity();
  const { bump } = useRefresh();
  const inputId = `inline-successor-title-${predecessorId}`;

  const submit = async () => {
    if (savingRef.current) return;
    const trimmed = title.trim();
    if (!trimmed) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await api.createTaskSuccessor(predecessorId, {
        title: trimmed,
        createdByMemberId: currentMemberId,
        status: "actionable",
      });
      bump();
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <form
      className="inline-child-composer"
      aria-label={strings.addSuccessor}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={inputId} className="sr-only">
        {strings.addSuccessor}
      </label>
      <input
        id={inputId}
        autoFocus
        value={title}
        placeholder={strings.successorPlaceholder}
        disabled={saving}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
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
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          disabled={saving}
          onClick={onCancel}
        >
          {strings.cancel}
        </button>
        <button
          type="submit"
          className="btn btn-sm btn-primary"
          disabled={saving || !title.trim()}
        >
          {strings.save}
        </button>
      </div>
    </form>
  );
}
