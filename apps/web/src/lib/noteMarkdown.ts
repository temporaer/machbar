import type { Parent, Root, RootContent, PhrasingContent } from "mdast";
import type { PluggableList } from "unified";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { splitActionableText } from "./markdownActionableLinks";
import { paperlessDocumentId } from "./paperlessAttachments";

const header =
  /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})) · ([^\]\n]+)\]$/;
export function noteHeader(line: string) {
  const match = line.match(header);
  return match && Number.isFinite(Date.parse(match[1]!))
    ? { instant: match[1]!, author: match[2]! }
    : undefined;
}

/** Replace standalone entry headers only after Markdown parsing; code stays code.
 * The root document and its reference definitions remain intact for remark-rehype.
 */
function remarkNoteEntries() {
  return (tree: Root) => {
    tree.children = tree.children.flatMap((node): RootContent[] => {
      if (node.type !== "paragraph") return [node];
      const result: RootContent[] = [];
      let paragraph: PhrasingContent[] = [];
      let line: PhrasingContent[] = [];
      const flushParagraph = () => {
        if (paragraph.length)
          result.push({ type: "paragraph", children: paragraph });
        paragraph = [];
      };
      const flushLine = (lineBreak?: PhrasingContent) => {
        const entry =
          line.length === 1 && line[0]?.type === "text"
            ? noteHeader(line[0].value)
            : undefined;
        if (entry) {
          // Drop the separator before metadata; retain all other Markdown nodes.
          if (paragraph.at(-1)?.type === "break") paragraph.pop();
          flushParagraph();
          result.push({
            type: "paragraph",
            children: [],
            data: {
              hName: "div",
              hProperties: {
                dataNoteInstant: entry.instant,
                dataNoteAuthor: entry.author,
              },
            },
          });
        } else {
          paragraph.push(...line);
          if (lineBreak) paragraph.push(lineBreak);
        }
        line = [];
      };
      for (const child of node.children) {
        if (child.type === "break") flushLine(child);
        else line.push(child);
      }
      flushLine();
      flushParagraph();
      return result;
    });
  };
}

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
  return scheme && allowedMarkdownUrlSchemes.has(scheme.toLowerCase())
    ? url
    : "";
}

/** Adds mobile URI/phone actions only to plain text nodes, never code or existing links. */
function remarkActionableLinks() {
  return (tree: Root) => {
    const visit = (parent: Parent) => {
      for (let index = 0; index < parent.children.length; index += 1) {
        const child = parent.children[index];
        if (!child) continue;
        if (child.type === "text") {
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

/** Full notes and tails share parsing extensions and Machbar transforms. */
export const noteMarkdownPlugins: PluggableList = [
  remarkGfm,
  remarkBreaks,
  remarkNoteEntries,
  remarkActionableLinks,
];
