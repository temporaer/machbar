import { useState } from "react";
import { paperlessDocumentThumbnailUrl } from "../lib/api";
import type { PaperlessMarkdownReference } from "../lib/paperlessAttachments";
import { useStrings } from "../lib/strings";

export function TaskRowAttachmentPreview({
  attachment,
  count,
}: {
  attachment: PaperlessMarkdownReference;
  count: number;
}) {
  const strings = useStrings();
  const [failed, setFailed] = useState(false);

  if (failed) return null;

  return (
    <span
      className="task-row-attachment-preview"
      aria-label={strings.attachmentCount(count)}
    >
      <img
        src={paperlessDocumentThumbnailUrl(attachment.id)}
        alt=""
        loading="lazy"
        onError={() => setFailed(true)}
      />
      {count > 1 ? (
        <span className="task-row-attachment-count">+{count - 1}</span>
      ) : null}
    </span>
  );
}
