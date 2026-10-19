import { splitActionableText } from "./markdownActionableLinks";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { RootContent } from "mdast";
import { markdownWithoutPaperlessReferences } from "./paperlessAttachments";

// The existing external-wait convention, deliberately not arbitrary bracketed prose.
const header =
  /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})) · ([^\]\n]+)\]$/;
export interface NoteEntry {
  instant?: string | undefined;
  author?: string | undefined;
  content: string;
}
export function noteEntries(value: string): NoteEntry[] {
  const entries: NoteEntry[] = [];
  let current: NoteEntry = { content: "" };
  let fence: string | null = null;
  for (const line of value.split("\n")) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    const match = !fence && line.match(header);
    if (match && Number.isFinite(Date.parse(match[1]!))) {
      if (current.content.trim() || current.instant) entries.push(current);
      current = { instant: match[1], author: match[2], content: "" };
    } else current.content += (current.content ? "\n" : "") + line;
    if (marker) {
      if (!fence) fence = marker[1]!;
      else if (marker[1]![0] === fence[0] && marker[1]!.length >= fence.length)
        fence = null;
    }
  }
  if (current.content.trim() || current.instant) entries.push(current);
  return entries;
}
export function stampNote(
  content: string,
  author: string,
  now = new Date(),
): string {
  const text = content.trim();
  return !text || header.test(text.split("\n")[0]!)
    ? text
    : `[${now.toISOString()} · ${author.replace(/[\]\r\n]/g, " ")}]\n${text}`;
}
export interface NoteToken {
  text: string;
  href?: string | undefined;
}
export function notePreview(value: string): {
  tokens: NoteToken[];
  entry?: NoteEntry | undefined;
} {
  const entries = noteEntries(markdownWithoutPaperlessReferences(value));
  const tokens: NoteToken[] = [];
  let entry: NoteEntry | undefined;
  const visit = (node: RootContent, href?: string | undefined) => {
    if (
      node.type === "image" ||
      node.type === "imageReference" ||
      node.type === "definition" ||
      node.type === "html"
    )
      return;
    if (node.type === "text" && !href) {
      for (const part of splitActionableText(node)) {
        if (part.type === "text") tokens.push({ text: part.value });
        else if (part.type === "link")
          tokens.push({
            text: part.children
              .map((child) => ("value" in child ? child.value : ""))
              .join(""),
            href: part.url,
          });
      }
    } else if ("value" in node) tokens.push({ text: node.value, href });
    else if ("children" in node) {
      for (const child of node.children)
        visit(child as RootContent, node.type === "link" ? node.url : href);
      if (
        ["paragraph", "heading", "listItem", "code", "blockquote"].includes(
          node.type,
        )
      )
        tokens.push({ text: " " });
    }
  };
  for (const part of entries) {
    const before = tokens.length;
    for (const node of fromMarkdown(part.content).children) visit(node);
    if (tokens.slice(before).some((t) => t.text.trim())) entry = part;
  }
  while (tokens.length && !tokens[tokens.length - 1]!.text.trim()) tokens.pop();
  return { tokens, entry };
}
export function sliceNoteTokens(
  tokens: NoteToken[],
  start: number,
): NoteToken[] {
  return tokens.flatMap((token) => {
    const skip = Math.min(start, token.text.length);
    start -= skip;
    const text = token.text.slice(skip);
    return text ? [{ ...token, text }] : [];
  });
}
