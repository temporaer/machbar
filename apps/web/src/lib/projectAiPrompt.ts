import type {
  Definition,
  FootnoteDefinition,
  ImageReference,
  LinkReference,
  Parent,
} from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { ProjectMaterialItem } from "./projectMaterials";

type Reference = LinkReference | ImageReference;
type TextEdit = { start: number; end: number; text: string };

const markdownParser = unified().use(remarkParse).use(remarkGfm);

function applyTextEdits(markdown: string, edits: TextEdit[]): string {
  return edits
    .sort((left, right) => right.start - left.start)
    .reduce(
      (result, edit) => result.slice(0, edit.start) + edit.text + result.slice(edit.end),
      markdown,
    );
}

function resolveMarkdownReferences(markdown: string, sectionId: string): string {
  const tree = markdownParser.parse(markdown);
  const definitions = new Map<string, Definition>();
  const definitionNodes: Definition[] = [];
  const footnoteDefinitions: FootnoteDefinition[] = [];

  const visit = (parent: Parent) => {
    for (const child of parent.children) {
      if (child.type === "definition") {
        definitionNodes.push(child);
        if (!definitions.has(child.identifier)) definitions.set(child.identifier, child);
      } else if (child.type === "footnoteDefinition") {
        footnoteDefinitions.push(child);
        visit(child);
      } else if ("children" in child) {
        visit(child);
      }
    }
  };
  visit(tree);

  const scopedFootnoteIdentifier = (identifier: string) =>
    `machbar-${sectionId}-${Array.from(identifier, (character) =>
      character.codePointAt(0)!.toString(16),
    ).join("-")}`;

  const collectInlineEdits = (nodes: Parent["children"]): TextEdit[] => {
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
          edits.push(...collectInlineEdits(node.children));
        }
      } else if (node.type === "footnoteReference") {
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        if (start !== undefined && end !== undefined) {
          edits.push({
            start,
            end,
            text: `[^${scopedFootnoteIdentifier(node.identifier)}]`,
          });
        }
      } else if ("children" in node) {
        edits.push(...collectInlineEdits(node.children));
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
      return `![${(reference.alt ?? "").replace(/[\\`*_{}\[\]()#+.!|><~&-]/g, "\\$&")}]${destination}`;
    }

    const labelStart = reference.children[0]?.position?.start.offset ?? start + 1;
    const labelEnd = reference.children.at(-1)?.position?.end.offset ?? labelStart;
    const nestedEdits = collectInlineEdits(reference.children).map((edit) => ({
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

  const edits = collectInlineEdits(tree.children);
  for (const definition of footnoteDefinitions) {
    const start = definition.position?.start.offset;
    if (start === undefined) continue;
    const label = markdown.slice(start).match(/^\[\^[^\]]+\]/)?.[0];
    if (label) {
      edits.push({
        start,
        end: start + label.length,
        text: `[^${scopedFootnoteIdentifier(definition.identifier)}]`,
      });
    }
  }
  for (const definition of definitionNodes) {
    const start = definition.position?.start.offset;
    const end = definition.position?.end.offset;
    if (start === undefined || end === undefined) continue;
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
  const sections = prompt.trim() ? [resolveMarkdownReferences(prompt.trim(), "prompt")] : [];
  for (const [index, { task, parentTitles }] of materials.entries()) {
    const material = [`## ${task.title}`];
    if (parentTitles.length) material.push(parentTitles.join(" › "));
    if (task.notes) {
      material.push(resolveMarkdownReferences(task.notes, `material-${index}`));
    }
    sections.push(material.join("\n\n"));
  }
  return sections.join("\n\n---\n\n");
}
