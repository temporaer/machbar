import type { Components } from "react-markdown";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import type { Link, Parent, PhrasingContent, Root, Text } from "mdast";
import {
  paperlessDocumentDownloadUrl,
  paperlessDocumentPreviewUrl,
  paperlessDocumentThumbnailUrl,
} from "../lib/api";
import { paperlessDocumentId } from "../lib/paperlessAttachments";
import { useStrings } from "../lib/strings";
import "./MarkdownNotes.css";

/**
 * Schemes intentionally supported in Markdown links. Add a future attachment
 * scheme here only after its destination and access controls are defined.
 */
export const markdownUrlSchemes = [
  "http",
  "https",
  "mailto",
  "tel",
  "sms",
  "paperless",
] as const;

const allowedMarkdownUrlSchemes = new Set<string>(markdownUrlSchemes);
const schemePattern = /^([a-z][a-z\d+.-]*):/i;
const unsafeCharacterPattern = /[\u0000-\u001f\u007f\s]/;
const actionableTokenPattern =
  /(?:tel:|sms:)\s*\+?\d[\d ()/-]{5,}\d|mailto:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\+?\d[\d ()/-]{5,}\d/gi;

/**
 * Restricts rendered Markdown URLs to local navigation and explicitly allowed
 * protocols. Returning an empty URL makes react-markdown omit unsafe targets.
 */
export function transformMarkdownUrl(url: string): string {
  if (!url || unsafeCharacterPattern.test(url)) return "";

  // Protocol-relative and backslash paths can be interpreted as cross-origin
  // navigation by browsers, so they are not relative URLs for this policy.
  if (/^(?:[/\\]{2}|\\)/.test(url)) return "";

  const match = url.match(schemePattern);
  if (!match) return url;

  const scheme = match[1]?.toLowerCase();
  if (scheme === "paperless") {
    return paperlessDocumentId(url) !== null ? url : "";
  }
  return scheme && allowedMarkdownUrlSchemes.has(scheme.toLowerCase()) ? url : "";
}

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

function actionableLink(raw: string, source: string, start: number): { href: string; label: string } | null {
  const explicit = raw.match(/^(tel:|sms:)\s*(.+)$/i);
  if (explicit) {
    const scheme = explicit[1]?.toLowerCase();
    const value = explicit[2]?.trim() ?? "";
    return scheme && value
      ? { href: `${scheme}${value.replace(/[ ()/]/g, "")}`, label: value }
      : null;
  }
  if (/^mailto:/i.test(raw)) {
    return { href: raw, label: raw.slice("mailto:".length) };
  }
  const before = source[start - 1] ?? "";
  const after = source[start + raw.length] ?? "";
  if (/[A-Z0-9]/i.test(before) || /[A-Z0-9]/i.test(after)) return null;
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(raw) || /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(raw)) {
    return null;
  }
  if ((raw.match(/\d/g) ?? []).length < 7) return null;
  return { href: `tel:${raw.replace(/[ ()/]/g, "")}`, label: raw };
}

function splitActionableText(node: Text): PhrasingContent[] {
  const nodes: PhrasingContent[] = [];
  let cursor = 0;
  for (const match of node.value.matchAll(actionableTokenPattern)) {
    const start = match.index;
    const raw = match[0];
    const link = actionableLink(raw, node.value, start);
    if (start > cursor) nodes.push({ type: "text", value: node.value.slice(cursor, start) });
    if (link) {
      nodes.push({
        type: "link",
        url: link.href,
        children: [{ type: "text", value: link.label }],
      } satisfies Link);
    } else {
      nodes.push({ type: "text", value: raw });
    }
    cursor = start + raw.length;
  }
  if (cursor < node.value.length) nodes.push({ type: "text", value: node.value.slice(cursor) });
  return nodes;
}

/** Adds mobile URI/phone actions only to plain text nodes, never code or existing links. */
function remarkActionableLinks() {
  return (tree: Root) => {
    const visit = (parent: Parent) => {
      for (let index = 0; index < parent.children.length; index += 1) {
        const child = parent.children[index];
        if (!child) continue;
        if (child.type === "text" && actionableTokenPattern.test(child.value)) {
          actionableTokenPattern.lastIndex = 0;
          const replacement = splitActionableText(child);
          parent.children.splice(index, 1, ...replacement);
          index += replacement.length - 1;
        } else if ("children" in child && child.type !== "link") {
          visit(child as Parent);
        }
      }
    };
    visit(tree);
  };
}

const markdownComponents: Components = {
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
        remarkPlugins={[remarkGfm, remarkBreaks, remarkActionableLinks]}
        urlTransform={transformMarkdownUrl}
      >
        {value}
      </ReactMarkdown>
    </div>
  );
}
