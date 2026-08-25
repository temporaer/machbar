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
 *
 * Blocked tasks (unresolved dependencies) are normally excluded from every
 * bucket above — they aren't actionable, so surfacing them in "Heute"
 * would just be noise. The one exception is `revisit`: a blocked task
 * whose own `scheduledDate` (never inherited from a project or parent) is
 * today or earlier reappears there as a reminder that it's worth checking
 * on, even though it can't be worked on directly yet.
 */
export function buildAgenda(graph: Graph, dueSoonDays = 3): Agenda {
  const today = todayIso();
  const soonLimit = addDaysIso(today, dueSoonDays);
  const seen = new Set<number>();

  const take = (predicate: (t: TaskRecord) => boolean): TaskRecord[] => {
    const results = graph
      .allTasks()
      .filter((t) => isOpen(t) && !t.blocked && !seen.has(t.id) && predicate(t))
      .sort(sortByDueThenPriority);
    for (const t of results) seen.add(t.id);
    return results;
  };

  const planned = take(
    (t) => !!t.scheduledDate && t.scheduledDate <= today,
  );
  const overdue = take((t) => !!t.dueDate && t.dueDate < today);
  const dueToday = take((t) => t.dueDate === today);
  const dueSoon = take(
    (t) => !!t.dueDate && t.dueDate > today && t.dueDate <= soonLimit,
  );
  const shared = take(
    (t) => t.status === "actionable" && t.effectiveOwnerId === null,
  );

  const revisit = graph
    .allTasks()
    .filter(
      (t) =>
        isOpen(t) &&
        t.blocked &&
        !!t.scheduledDate &&
        t.scheduledDate <= today,
    )
    .sort(sortByDueThenPriority);

  return { planned, overdue, dueToday, dueSoon, shared, revisit };
}
