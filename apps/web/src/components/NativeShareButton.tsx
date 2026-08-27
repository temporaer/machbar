import { useState } from "react";
import { strings } from "../lib/strings";

export function NativeShareButton({
  title,
  text,
  url,
}: {
  title: string;
  text: string;
  url?: string;
}) {
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const share = async () => {
    if (busy) return;
    setBusy(true);
    setStatus(null);
    try {
      if (typeof navigator.share === "function") {
        await navigator.share({ title, text, ...(url ? { url } : {}) });
        setStatus(strings.shareCompleted);
      } else {
        const clipboardText = [text, url].filter(Boolean).join("\n\n");
        if (!navigator.clipboard?.writeText) {
          throw new Error(strings.clipboardUnavailable);
        }
        await navigator.clipboard.writeText(clipboardText);
        setStatus(strings.copiedToClipboard);
      }
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setStatus(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="native-share-control">
      <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void share()}>
        {strings.share}
      </button>
      {status ? <span className="text-muted native-share-status" role="status">{status}</span> : null}
    </span>
  );
}
