import type { Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

export interface ChecklistProgress {
  completed: number;
  total: number;
}

const parser = unified().use(remarkParse).use(remarkGfm);
const checklistMarker = /^[ \t]*(?:>[ \t]*)*(?:[-+*]|\d{1,9}[.)])[ \t]+\[[ xX]\](?:[ \t]|$)/m;

/** Counts real GFM task-list items, ignoring checkbox-like text in code blocks. */
export function markdownChecklistProgress(value: string): ChecklistProgress | null {
  if (!checklistMarker.test(value)) return null;

  let completed = 0;
  let total = 0;
  const visit = (node: { type: string; checked?: boolean | null; children?: unknown[] }) => {
    if (node.type === "listItem" && node.checked !== undefined) {
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
