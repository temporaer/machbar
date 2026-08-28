import { useState } from "react";
import { useStrings } from "../lib/strings";
import { IconActionButton } from "./IconActionButton";
import { localizedErrorMessage } from "../lib/errorMessage";

export function NativeShareButton({
  title,
  text,
  url,
  showStatus = true,
  onStatusChange,
}: {
  title: string;
  text: string;
  url?: string;
  showStatus?: boolean;
  onStatusChange?: (status: string | null) => void;
}) {
  const strings = useStrings();
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const updateStatus = (nextStatus: string | null) => {
    setStatus(nextStatus);
    onStatusChange?.(nextStatus);
  };

  const share = async () => {
    if (busy) return;
    setBusy(true);
    updateStatus(null);
    try {
      if (typeof navigator.share === "function") {
        await navigator.share({ title, text, ...(url ? { url } : {}) });
        updateStatus(strings.shareCompleted);
      } else {
        const clipboardText = [text, url].filter(Boolean).join("\n\n");
        if (!navigator.clipboard?.writeText) {
          throw new Error(strings.clipboardUnavailable);
        }
        await navigator.clipboard.writeText(clipboardText);
        updateStatus(strings.copiedToClipboard);
      }
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      updateStatus(localizedErrorMessage(cause, strings));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="native-share-control">
      <IconActionButton
        kind="share"
        label={strings.share}
        disabled={busy}
        onClick={() => void share()}
      />
      {showStatus && status ? (
        <span className="text-muted native-share-status" role="status">{status}</span>
      ) : null}
    </span>
  );
}
