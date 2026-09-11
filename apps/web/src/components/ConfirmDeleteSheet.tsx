import { useStrings } from "../lib/strings";
import { BottomSheet } from "./BottomSheet";

/**
 * In-app confirmation for a single-outcome delete (no "with children" choice
 * — see `ProjectDeleteChoiceSheet` for the project variant that also asks
 * what should happen to child tasks). Replaces `window.confirm`, which
 * cannot be styled, tested consistently, or localized beyond its message.
 */
export function ConfirmDeleteSheet({
  title,
  itemTitle,
  prompt,
  busy,
  onConfirm,
  onClose,
}: {
  title: string;
  itemTitle: string;
  prompt: string;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const strings = useStrings();
  return (
    <BottomSheet
      title={title}
      onClose={() => {
        if (!busy) onClose();
      }}
      labelledBy="confirm-delete-title"
    >
      <p className="text-muted">{itemTitle}</p>
      <p>{prompt}</p>
      <div className="stack">
        <button
          type="button"
          className="btn btn-block btn-danger"
          disabled={busy}
          onClick={onConfirm}
        >
          {strings.delete}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-block"
          disabled={busy}
          onClick={onClose}
        >
          {strings.cancel}
        </button>
      </div>
    </BottomSheet>
  );
}
