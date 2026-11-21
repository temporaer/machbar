import { noteMarkdownPlugins, transformMarkdownUrl } from "../lib/noteMarkdown";
export { transformMarkdownUrl, markdownUrlSchemes } from "../lib/noteMarkdown";
import type { Components } from "react-markdown";
import type { ElementContent } from "hast";
import { createContext, useContext, useState } from "react";
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

const previewComponents: Components = {
  ...markdownComponents,
  a({ children }) {
    return <span>{children}</span>;
  },
  img({ alt = "" }) {
    return <span>{alt}</span>;
  },
};

const checklistContext = createContext<{
  value: string;
  onToggle: (value: string) => void;
  disabled: boolean;
} | null>(null);
const checklistItemContext = createContext<{ offset: number; label: string } | null>(null);

const checklistComponents: Components = {
  ...markdownComponents,
  li({ node, children, ...props }) {
    const checklist = useContext(checklistContext);
    const start = node?.position?.start.offset;
    const match = start === undefined ? null
      : checklist?.value.slice(start).match(/^(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|\r?\n[ \t>]+)\[([ \txX])\]/);
    const offset = match && start !== undefined ? start + match[0].length - 2 : -1;
    const text = (nodes: ElementContent[]): string => nodes.map(child => {
      if (child.type === "text") return child.value;
      if (child.type === "element" && child.tagName === "img") return String(child.properties.alt ?? "");
      if (child.type === "element" && child.tagName !== "ul" && child.tagName !== "ol") return text(child.children);
      return "";
    }).join("");
    const label = node ? text(node.children).trim() : "";
    return <li {...props}><checklistItemContext.Provider value={offset < 0 ? null : { offset, label }}>
      {children}
    </checklistItemContext.Provider></li>;
  },
  input({ node: _node, checked, ...props }) {
    const checklist = useContext(checklistContext);
    const item = useContext(checklistItemContext);
    const strings = useStrings();
    if (!checklist || !item || props.type !== "checkbox") return <input {...props} checked={checked} />;
    return <label className="markdown-checklist-toggle"><input {...props} disabled={false}
      data-checklist-toggle="" aria-disabled={checklist.disabled} checked={checked} aria-label={item.label || strings.markdownTaskList}
      onClick={event => { if (checklist.disabled) event.preventDefault(); }}
      onChange={event => {
        const marker = checklist.value[item.offset];
        if (!checklist.disabled && ((checked && (marker === "x" || marker === "X")) || (!checked && (marker === " " || marker === "\t")))) {
          checklist.onToggle(checklist.value.slice(0, item.offset) + (event.target.checked ? "x" : " ") + checklist.value.slice(item.offset + 1));
        }
      }} /></label>;
  },
};

export interface MarkdownNotesProps {
  value: string;
  className?: string;
  interactive?: boolean;
  onChecklistToggle?: ((value: string) => void) | undefined;
  checklistDisabled?: boolean;
}

/**
 * Displays user-authored notes without interpreting raw HTML.
 */
export function MarkdownNotes({ value, className, interactive = true, onChecklistToggle, checklistDisabled = false }: MarkdownNotesProps) {
  return (
    <div className={["markdown-notes", className].filter(Boolean).join(" ")}>
      <checklistContext.Provider value={interactive && onChecklistToggle ? { value, onToggle: onChecklistToggle, disabled: checklistDisabled } : null}>
      <ReactMarkdown
        components={interactive ? (onChecklistToggle ? checklistComponents : markdownComponents) : previewComponents}
        remarkPlugins={noteMarkdownPlugins}
        urlTransform={transformMarkdownUrl}
      >
        {value}
      </ReactMarkdown>
      </checklistContext.Provider>
    </div>
  );
}
