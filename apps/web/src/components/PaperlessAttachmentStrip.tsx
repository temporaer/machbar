import type { PaperlessMarkdownReference } from "../lib/paperlessAttachments";
import {
  paperlessDocumentDownloadUrl,
  paperlessDocumentPreviewUrl,
  paperlessDocumentThumbnailUrl,
} from "../lib/api";
import { useStrings } from "../lib/strings";

export function PaperlessAttachmentStrip({
  attachments,
}: {
  attachments: readonly PaperlessMarkdownReference[];
}) {
  const strings = useStrings();
  if (attachments.length === 0) return null;

  return (
    <section
      className="paperless-attachment-strip"
      aria-label={strings.attachmentCount(attachments.length)}
    >
      {attachments.map((attachment, index) => (
        <a
          key={`${attachment.kind}-${attachment.id}-${index}`}
          className={`paperless-attachment-tile paperless-attachment-${attachment.kind}`}
          href={
            attachment.kind === "image"
              ? paperlessDocumentPreviewUrl(attachment.id)
              : paperlessDocumentDownloadUrl(attachment.id)
          }
          target={attachment.kind === "image" ? "_blank" : undefined}
          rel={attachment.kind === "image" ? "noopener noreferrer" : undefined}
        >
          {attachment.kind === "image" ? (
            <img
              src={paperlessDocumentThumbnailUrl(attachment.id)}
              alt=""
              loading="lazy"
            />
          ) : (
            <span className="paperless-attachment-document-icon" aria-hidden="true">
              PDF
            </span>
          )}
          <span>{attachment.label}</span>
        </a>
      ))}
    </section>
  );
}
