import type { Definition, ImageReference, LinkReference, Parent } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { ProjectMaterialItem } from "./projectMaterials";

type Reference = LinkReference | ImageReference;
type TextEdit = { start: number; end: number; text: string };

const markdownParser = unified().use(remarkParse);

function applyTextEdits(markdown: string, edits: TextEdit[]): string {
  return edits
    .sort((left, right) => right.start - left.start)
    .reduce(
      (result, edit) => result.slice(0, edit.start) + edit.text + result.slice(edit.end),
      markdown,
    );
}

function resolveMarkdownReferences(markdown: string): string {
  const tree = markdownParser.parse(markdown);
  const definitions = new Map<string, Definition>();

  const visit = (parent: Parent) => {
    for (const child of parent.children) {
      if (child.type === "definition") {
        if (!definitions.has(child.identifier)) definitions.set(child.identifier, child);
      } else if ("children" in child) {
        visit(child);
      }
    }
  };
  visit(tree);

  const collectReferenceEdits = (nodes: Parent["children"]): TextEdit[] => {
    const edits: TextEdit[] = [];
    for (const node of nodes) {
      if (node.type === "linkReference" || node.type === "imageReference") {
        const definition = definitions.get(node.identifier);
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        if (definition && start !== undefined && end !== undefined) {
          edits.push({
            start,
            end,
            text: renderReference(node, definition, start),
          });
        } else if ("children" in node) {
          edits.push(...collectReferenceEdits(node.children));
        }
      } else if ("children" in node) {
        edits.push(...collectReferenceEdits(node.children));
      }
    }
    return edits;
  };

  const renderReference = (
    reference: Reference,
    definition: Definition,
    start: number,
  ): string => {
    const destination = `(<${definition.url
      .replace(/&/g, "&amp;")
      .replace(/\\/g, "\\\\")
      .replace(/[<>]/g, "\\$&")}>${
      definition.title == null
        ? ""
        : ` "${definition.title
            .replace(/&/g, "&amp;")
            .replace(/\\/g, "\\\\")
            .replace(/"/g, '\\"')}"`
    })`;
    if (reference.type === "imageReference") {
      return `![${(reference.alt ?? "")
        .replace(/&/g, "&amp;")
        .replace(/[\\\[\]]/g, "\\$&")}]${destination}`;
    }

    const labelStart = reference.children[0]?.position?.start.offset ?? start + 1;
    const labelEnd = reference.children.at(-1)?.position?.end.offset ?? labelStart;
    const nestedEdits = collectReferenceEdits(reference.children).map((edit) => ({
      ...edit,
      start: edit.start - labelStart,
      end: edit.end - labelStart,
    }));
    const label = applyTextEdits(
      markdown.slice(labelStart, labelEnd),
      nestedEdits,
    );
    return `[${label}]${destination}`;
  };

  const edits = collectReferenceEdits(tree.children);
  for (const definition of definitions.values()) {
    const start = definition.position?.start.offset;
    let end = definition.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    if (markdown[end] === "\r") end += 1;
    if (markdown[end] === "\n") end += 1;
    edits.push({ start, end, text: "" });
  }

  if (!edits.length) return markdown;
  const resolved = applyTextEdits(markdown, edits);
  return resolved.replace(/^(?:\r?\n)+|(?:\r?\n)+$/g, "");
}

export function buildProjectAiPromptText(
  prompt: string,
  materials: readonly ProjectMaterialItem[],
): string {
  const sections = prompt.trim() ? [resolveMarkdownReferences(prompt.trim())] : [];
  for (const { task, parentTitles } of materials) {
    const material = [`## ${task.title}`];
    if (parentTitles.length) material.push(parentTitles.join(" › "));
    if (task.notes) material.push(resolveMarkdownReferences(task.notes));
    sections.push(material.join("\n\n"));
  }
  return sections.join("\n\n---\n\n");
}
