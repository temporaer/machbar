import { useState } from "react";
import { MarkdownEditor } from "./MarkdownEditor";
import { useIdentity } from "../lib/identity";
import { useStrings } from "../lib/strings";
import { stampNote } from "../lib/noteEntries";
import { localizedErrorMessage } from "../lib/errorMessage";

/** A draft-only composer; task/project actions own persistence and invalidation. */
export function NotesAppend({
  onAppend,
  disabled = false,
}: {
  onAppend: (content: string) => Promise<unknown>;
  disabled?: boolean;
}) {
  const strings = useStrings();
  const { currentMember } = useIdentity();
  const [open, setOpen] = useState(false),
    [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false),
    [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (pending || disabled || !draft.trim()) return;
    setPending(true);
    setError(null);
    try {
      const result = await onAppend(
        stampNote(draft, currentMember?.name ?? "Unknown actor"),
      );
      if (result === false || result === null || result === undefined)
        throw new Error(strings.error);
      setDraft("");
      setOpen(false);
    } catch (cause) {
      setError(localizedErrorMessage(cause, strings));
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="notes-append">
      {!open ? (
        <button
          type="button"
          className="btn btn-sm"
          disabled={disabled}
          onClick={() => setOpen(true)}
        >
          {strings.appendNote}
        </button>
      ) : (
        <>
          <MarkdownEditor
            aria-label={strings.appendNote}
            value={draft}
            onChange={setDraft}
            rows={3}
            disabled={disabled || pending}
          />
          {error ? <p role="alert">{error}</p> : null}
          <div className="row">
            <button
              type="button"
              className="btn btn-sm"
              disabled={pending}
              onClick={() => {
                setOpen(false);
                setError(null);
              }}
            >
              {strings.cancel}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={disabled || pending || !draft.trim()}
              onClick={() => void submit()}
            >
              {strings.appendNote}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
