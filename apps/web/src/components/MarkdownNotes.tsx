import { noteMarkdownPlugins, transformMarkdownUrl } from "../lib/noteMarkdown";
export { transformMarkdownUrl, markdownUrlSchemes } from "../lib/noteMarkdown";
import type { Components } from "react-markdown";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  paperlessDocumentDownloadUrl,
  paperlessDocumentPreviewUrl,
  paperlessDocumentThumbnailUrl,
} from "../lib/api";
import { paperlessDocumentId } from "../lib/paperlessAttachments";
import { useStrings } from "../lib/strings";
import "./MarkdownNotes.css";
import { NoteEntryTime } from "./NoteEntryTime";

function isExternalWebLink(href: string | undefined): boolean {
  return href !== undefined && /^https?:/i.test(href);
}

function PaperlessImage({ id, alt }: { id: number; alt: string }) {
  const strings = useStrings();
  const [failed, setFailed] = useState(false);
  const previewUrl = paperlessDocumentPreviewUrl(id);

  if (failed) {
    return (
      <a
        className="paperless-attachment-fallback"
        href={previewUrl}
        target="_blank"
        rel="noopener noreferrer"
      >
        {alt || strings.paperlessImageUnavailable}
      </a>
    );
  }

  return (
    <a
      className="paperless-image-link"
      href={previewUrl}
      target="_blank"
      rel="noopener noreferrer"
    >
      <img
        className="paperless-image"
        src={paperlessDocumentThumbnailUrl(id)}
        alt={alt}
        onError={() => setFailed(true)}
      />
    </a>
  );
}

const markdownComponents: Components = {
  div({ node, children, ...props }) {
    const instant = node?.properties.dataNoteInstant;
    return typeof instant === "string" ? (
      <NoteEntryTime
        instant={instant}
        author={String(node?.properties.dataNoteAuthor ?? "")}
      />
    ) : (
      <div {...props}>{children}</div>
    );
  },
  a({ href, children, node: _node, ...props }) {
    const paperlessId = paperlessDocumentId(href);
    if (paperlessId !== null) {
      return (
        <a
          {...props}
          className="paperless-document-link"
          href={paperlessDocumentDownloadUrl(paperlessId)}
        >
          {children}
        </a>
      );
    }
    return (
      <a
        {...props}
        href={href}
        {...(isExternalWebLink(href)
          ? { target: "_blank", rel: "noopener noreferrer" }
          : {})}
      >
        {children}
      </a>
    );
  },
  img({ src, alt = "" }) {
    const paperlessId = paperlessDocumentId(src);
    if (paperlessId !== null) {
      return <PaperlessImage id={paperlessId} alt={alt} />;
    }
    if (!src) return <span>{alt}</span>;
    return <img src={src} alt={alt} />;
  },
};

export interface MarkdownNotesProps {
  value: string;
  className?: string;
}

/**
 * Displays user-authored notes without interpreting raw HTML.
 */
export function MarkdownNotes({ value, className }: MarkdownNotesProps) {
  return (
    <div className={["markdown-notes", className].filter(Boolean).join(" ")}>
      <ReactMarkdown
        components={markdownComponents}
        remarkPlugins={noteMarkdownPlugins}
        urlTransform={transformMarkdownUrl}
      >
        {value}
      </ReactMarkdown>
    </div>
  );
}
