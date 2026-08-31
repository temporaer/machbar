import { useRef, useState } from "react";
import { localizedErrorMessage } from "../lib/errorMessage";
import { useStrings } from "../lib/strings";

export interface InlineTaskComposerProps {
  inputId: string;
  label: string;
  placeholder: string;
  onCancel: () => void;
  onSave: (title: string) => Promise<void>;
  onPendingChange?: (pending: boolean) => void;
}

export function InlineTaskComposer({
  inputId,
  label,
  placeholder,
  onCancel,
  onSave,
  onPendingChange,
}: InlineTaskComposerProps) {
  const strings = useStrings();
  const [title, setTitle] = useState("");
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (pendingRef.current) return;
    const trimmed = title.trim();
    if (!trimmed) return;

    pendingRef.current = true;
    setPending(true);
    onPendingChange?.(true);
    setError(null);
    try {
      await onSave(trimmed);
    } catch (err) {
      setError(localizedErrorMessage(err, strings));
      pendingRef.current = false;
      setPending(false);
      onPendingChange?.(false);
    }
  };

  return (
    <form
      className="inline-child-composer"
      aria-label={label}
      aria-busy={pending}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={inputId} className="sr-only">
        {label}
      </label>
      <input
        id={inputId}
        autoFocus
        value={title}
        placeholder={placeholder}
        disabled={pending}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !pendingRef.current) {
            event.preventDefault();
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
          disabled={pending}
          onClick={onCancel}
        >
          {strings.cancel}
        </button>
        <button type="submit" className="btn btn-sm btn-primary" disabled={pending || !title.trim()}>
          {strings.save}
        </button>
      </div>
    </form>
  );
}
