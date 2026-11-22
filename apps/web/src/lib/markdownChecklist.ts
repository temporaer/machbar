import type { Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

export interface ChecklistProgress {
  completed: number;
  total: number;
}

const parser = unified().use(remarkParse).use(remarkGfm);

/** Counts real GFM task-list items, ignoring checkbox-like text in code blocks. */
export function markdownChecklistProgress(value: string): ChecklistProgress | null {
  // A note without '[' cannot contain a task-list marker. Keep this prefilter
  // deliberately broad; the GFM parser remains authoritative for the count.
  if (!value.includes("[")) return null;

  let completed = 0;
  let total = 0;
  const visit = (node: { type: string; checked?: boolean | null; children?: unknown[] }) => {
    if (node.type === "listItem" && typeof node.checked === "boolean") {
      total += 1;
      if (node.checked) completed += 1;
    }
    for (const child of node.children ?? []) {
      if (child && typeof child === "object" && "type" in child) {
        visit(child as { type: string; checked?: boolean | null; children?: unknown[] });
      }
    }
  };
  visit(parser.parse(value) as Root as unknown as { type: string; children?: unknown[] });
  return total > 0 ? { completed, total } : null;
}
