import {
  paperlessDocumentUiUrl,
  type PaperlessMarkdownReference,
} from "../lib/paperlessAttachments";
import {
  api,
  paperlessDocumentDownloadUrl,
  paperlessDocumentPreviewUrl,
  paperlessDocumentThumbnailUrl,
} from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useStrings } from "../lib/strings";

export function PaperlessAttachmentStrip({
  attachments,
}: {
  attachments: readonly PaperlessMarkdownReference[];
}) {
  const strings = useStrings();
  const { data: paperlessStatus } = useAsync(
    () =>
      attachments.length > 0 && typeof api.getPaperlessStatus === "function"
        ? api.getPaperlessStatus()
        : Promise.resolve(null),
    [attachments.length],
  );
  const paperlessUiBaseUrl = paperlessStatus?.documentUiBaseUrl ?? null;
  if (attachments.length === 0) return null;

  return (
    <section
      className="paperless-attachment-strip"
      aria-label={strings.attachmentCount(attachments.length)}
    >
      {attachments.map((attachment, index) => {
        const paperlessUiUrl = paperlessDocumentUiUrl(
          paperlessUiBaseUrl,
          attachment.id,
        );
        return (
          <div
            key={`${attachment.kind}-${attachment.id}-${index}`}
            className={`paperless-attachment-tile paperless-attachment-${attachment.kind}`}
          >
            <a
              className="paperless-attachment-primary"
              href={
                attachment.kind === "image"
                  ? paperlessDocumentPreviewUrl(attachment.id)
                  : paperlessDocumentDownloadUrl(attachment.id)
              }
              target={attachment.kind === "image" ? "_blank" : undefined}
              rel={
                attachment.kind === "image" ? "noopener noreferrer" : undefined
              }
            >
              {attachment.kind === "image" ? (
                <img
                  src={paperlessDocumentThumbnailUrl(attachment.id)}
                  alt=""
                  loading="lazy"
                />
              ) : (
                <span
                  className="paperless-attachment-document-icon"
                  aria-hidden="true"
                >
                  PDF
                </span>
              )}
              <span>{attachment.label}</span>
            </a>
            {paperlessUiUrl ? (
              <a
                className="paperless-attachment-external"
                href={paperlessUiUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={strings.openInPaperlessLabel(attachment.label)}
              >
                {strings.openInPaperless}
              </a>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}
