import { useState } from "react";
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

function AttachmentThumbnail({
  attachment,
}: {
  attachment: PaperlessMarkdownReference;
}) {
  const [failed, setFailed] = useState(false);

  if (attachment.kind === "document" && failed) {
    return (
      <span className="paperless-attachment-document-icon" aria-hidden="true">
        PDF
      </span>
    );
  }

  return (
    <img
      src={paperlessDocumentThumbnailUrl(attachment.id)}
      alt=""
      loading="lazy"
      onError={attachment.kind === "document" ? () => setFailed(true) : undefined}
    />
  );
}

function PaperlessAttachmentStripWithStatus({
  attachments,
}: {
  attachments: readonly PaperlessMarkdownReference[];
}) {
  const { data: paperlessStatus } = useAsync(
    () =>
      attachments.length > 0 && typeof api.getPaperlessStatus === "function"
        ? api.getPaperlessStatus()
        : Promise.resolve(null),
    [attachments.length],
  );

  return (
    <PaperlessAttachmentStripView
      attachments={attachments}
      paperlessUiBaseUrl={paperlessStatus?.documentUiBaseUrl ?? null}
    />
  );
}

export function PaperlessAttachmentStrip({
  attachments,
  paperlessUiBaseUrl,
}: {
  attachments: readonly PaperlessMarkdownReference[];
  paperlessUiBaseUrl?: string | null | undefined;
}) {
  if (paperlessUiBaseUrl === undefined) {
    return <PaperlessAttachmentStripWithStatus attachments={attachments} />;
  }
  return (
    <PaperlessAttachmentStripView
      attachments={attachments}
      paperlessUiBaseUrl={paperlessUiBaseUrl}
    />
  );
}

function PaperlessAttachmentStripView({
  attachments,
  paperlessUiBaseUrl,
}: {
  attachments: readonly PaperlessMarkdownReference[];
  paperlessUiBaseUrl: string | null;
}) {
  const strings = useStrings();
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
              <AttachmentThumbnail attachment={attachment} />
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
