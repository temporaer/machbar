import type { Nodes, Parent, Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";

function nodeText(node: Nodes): string {
  if ("value" in node && typeof node.value === "string") return node.value;
  if ("children" in node) {
    return (node as Parent).children.map((child) => nodeText(child)).join("");
  }
  return "";
}

export function fromMarkdownWithReferences(markdown: string): Root {
  const tree = fromMarkdown(markdown);
  const definitions = new Map<string, { url: string; title: string | null }>();

  const collectDefinitions = (node: Nodes) => {
    if (node.type === "definition" && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, { url: node.url, title: node.title ?? null });
    }
    if ("children" in node) {
      for (const child of (node as Parent).children) collectDefinitions(child);
    }
  };
  collectDefinitions(tree);

  const resolveReferences = (parent: Parent) => {
    for (const child of parent.children) {
      if (child.type === "linkReference" || child.type === "imageReference") {
        const definition = definitions.get(child.identifier);
        if (definition) {
          Object.assign(child, {
            type: child.type === "linkReference" ? "link" : "image",
            url: definition.url,
            title: definition.title,
            ...(child.type === "imageReference" ? { alt: nodeText(child) } : {}),
          });
        }
      }
      if ("children" in child) resolveReferences(child as Parent);
    }
  };
  resolveReferences(tree);
  return tree;
}
