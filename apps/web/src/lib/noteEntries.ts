import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import type { Root, RootContent } from "hast";
import { markdownWithoutPaperlessReferences } from "./paperlessAttachments";
import {
  noteHeader,
  noteMarkdownPlugins,
  transformMarkdownUrl,
} from "./noteMarkdown";

export interface NoteEntry {
  instant: string;
  author: string;
}
export function stampNote(
  content: string,
  author: string,
  now = new Date(),
): string {
  const text = content.trim();
  return !text || noteHeader(text.split("\n")[0]!)
    ? text
    : `[${now.toISOString()} · ${author.replace(/[\]\r\n]/g, " ")}]\n${text}`;
}
export interface NoteToken {
  text: string;
  href?: string | undefined;
}
const processor = unified()
  .use(remarkParse)
  .use(noteMarkdownPlugins)
  .use(remarkRehype);
export function notePreview(value: string): {
  tokens: NoteToken[];
  entry?: NoteEntry | undefined;
} {
  const source = markdownWithoutPaperlessReferences(value);
  const tree = processor.runSync(processor.parse(source)) as Root;
  const tokens: NoteToken[] = [];
  let activeEntry: NoteEntry | undefined, entry: NoteEntry | undefined;
  const visit = (node: RootContent | Root, href?: string) => {
    if (node.type === "text") {
      if (node.value.trim()) {
        tokens.push({ text: node.value, href });
        entry = activeEntry;
      } else if (tokens.length) tokens.push({ text: " " });
      return;
    }
    if (node.type !== "element" && node.type !== "root") return;
    if (node.type === "element") {
      if (["img", "input"].includes(node.tagName)) return;
      if (typeof node.properties.dataNoteInstant === "string") {
        activeEntry = {
          instant: node.properties.dataNoteInstant,
          author: String(node.properties.dataNoteAuthor ?? ""),
        };
        return;
      }
      if (node.tagName === "a")
        href =
          transformMarkdownUrl(String(node.properties.href ?? "")) || undefined;
    }
    for (const child of node.children) visit(child, href);
    if (
      node.type === "element" &&
      [
        "p",
        "li",
        "h1",
        "h2",
        "h3",
        "blockquote",
        "pre",
        "br",
        "td",
        "th",
      ].includes(node.tagName)
    )
      tokens.push({ text: " " });
  };
  visit(tree);
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
