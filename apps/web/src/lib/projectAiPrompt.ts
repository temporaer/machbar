import type { Definition, ImageReference, LinkReference, Parent } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { ProjectMaterialItem } from "./projectMaterials";

const markdownParser = unified().use(remarkParse);

function resolveMarkdownReferences(markdown: string): string {
  const tree = markdownParser.parse(markdown);
  const definitions = new Map<string, Definition>();
  const references: (LinkReference | ImageReference)[] = [];

  const visit = (parent: Parent) => {
    for (const child of parent.children) {
      if (child.type === "definition") {
        if (!definitions.has(child.identifier)) definitions.set(child.identifier, child);
      } else if (child.type === "linkReference" || child.type === "imageReference") {
        references.push(child);
      } else if ("children" in child) {
        visit(child);
      }
    }
  };
  visit(tree);

  const edits: { start: number; end: number; text: string }[] = [];
  for (const reference of references) {
    if (reference.type !== "linkReference" && reference.type !== "imageReference") continue;
    const definition = definitions.get(reference.identifier);
    const start = reference.position?.start.offset;
    const end = reference.position?.end.offset;
    if (!definition || start === undefined || end === undefined) continue;

    const destination = `(<${definition.url.replace(/\\/g, "\\\\").replace(/[<>]/g, "\\$&")}>${
      definition.title == null
        ? ""
        : ` "${definition.title.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
    })`;
    const text = reference.type === "imageReference"
      ? `![${(reference.alt ?? "").replace(/[\\\[\]]/g, "\\$&")}]${destination}`
      : `[${markdown.slice(
          reference.children[0]?.position?.start.offset ?? start + 1,
          reference.children.at(-1)?.position?.end.offset ?? start + 1,
        )}]${destination}`;
    edits.push({ start, end, text });
  }

  for (const definition of definitions.values()) {
    const start = definition.position?.start.offset;
    let end = definition.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    if (markdown[end] === "\r") end += 1;
    if (markdown[end] === "\n") end += 1;
    edits.push({ start, end, text: "" });
  }

  if (!edits.length) return markdown;
  const resolved = edits
    .sort((left, right) => right.start - left.start)
    .reduce(
      (result, edit) => result.slice(0, edit.start) + edit.text + result.slice(edit.end),
      markdown,
    );
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
