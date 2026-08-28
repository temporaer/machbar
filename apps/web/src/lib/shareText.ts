import type { Task } from "@machbar/shared";
import type { ProjectDetail } from "./api";
import { formatDate } from "./format";
import { sortByPosition } from "./taskHelpers";
import { getCatalog, type Locale } from "../i18n/catalog";

/** Creates a compact, readable plain-text representation for native sharing. */
export function serializeTaskForShare(
  task: Task,
  locale: Locale = "de",
): string {
  const strings = getCatalog(locale);
  const lines = [task.title];
  const due = formatDate(task.dueDate, locale);
  if (due) lines.push("", `${strings.due}: ${due}`);
  if (task.notes.trim()) lines.push("", task.notes.trim());
  return lines.join("\n");
}

/**
 * Creates a standalone project summary. Tasks retain their tree shape via
 * two-space indentation, including their lifecycle state on every line.
 */
export function serializeProjectForShare(
  project: ProjectDetail,
  locale: Locale = "de",
): string {
  const strings = getCatalog(locale);
  const lines = [project.title];
  if (project.tasks.length) {
    lines.push("");
    appendTaskTree(lines, sortByPosition(project.tasks), 0);
  }
  const due = formatDate(project.dueDate, locale);
  if (due) lines.push("", `${strings.due}: ${due}`);
  if (project.notes.trim()) lines.push("", project.notes.trim());
  return lines.join("\n");
}

function appendTaskTree(lines: string[], tasks: Task[], depth: number): void {
  for (const task of tasks) {
    const marker =
      task.status === "done"
        ? "✓"
        : task.status === "cancelled"
          ? "×"
          : "☐";
    lines.push(`${"  ".repeat(depth)}${marker} ${task.title}`);
    appendTaskTree(lines, sortByPosition(task.children), depth + 1);
  }
}
