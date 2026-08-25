import type { Agenda } from "@machbar/shared";
import type { Graph } from "./graph.js";
import type { TaskRecord } from "./graph.js";

function isOpen(t: TaskRecord): boolean {
  return t.status !== "done" && t.status !== "cancelled";
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDaysIso(dateIso: string, days: number): string {
  const d = new Date(`${dateIso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function sortByDueThenPriority(a: TaskRecord, b: TaskRecord): number {
  const dueA = a.dueDate ?? "9999-99-99";
  const dueB = b.dueDate ?? "9999-99-99";
  if (dueA !== dueB) return dueA < dueB ? -1 : 1;
  const prA = a.priority ?? 0;
  const prB = b.priority ?? 0;
  if (prA !== prB) return prB - prA;
  return a.position - b.position;
}

/**
 * Builds the "Heute" (today) agenda. Categories are mutually exclusive:
 * a task is placed in the first matching bucket in the order
 * planned > overdue > dueToday > dueSoon > shared, so nothing is
 * duplicated across sections.
 */
export function buildAgenda(graph: Graph, dueSoonDays = 3): Agenda {
  const today = todayIso();
  const soonLimit = addDaysIso(today, dueSoonDays);
  const seen = new Set<number>();

  const take = (predicate: (t: TaskRecord) => boolean): TaskRecord[] => {
    const results = graph
      .allTasks()
      .filter((t) => isOpen(t) && !seen.has(t.id) && predicate(t))
      .sort(sortByDueThenPriority);
    for (const t of results) seen.add(t.id);
    return results;
  };

  const planned = take((t) => t.markedToday);
  const overdue = take((t) => !!t.dueDate && t.dueDate < today);
  const dueToday = take((t) => t.dueDate === today);
  const dueSoon = take(
    (t) => !!t.dueDate && t.dueDate > today && t.dueDate <= soonLimit,
  );
  const shared = take(
    (t) => t.status === "actionable" && t.effectiveOwnerId === null,
  );

  return { planned, overdue, dueToday, dueSoon, shared };
}
