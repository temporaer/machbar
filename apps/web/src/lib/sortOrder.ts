import type {
  Dependency,
  Member,
  Project,
  Task,
  TaskStatus,
} from "@machbar/shared";
import type { Locale } from "../i18n/catalog";
import { addIsoCalendarDays, toIsoCalendarDate } from "./naturalDate";

/**
 * Optional ranking inputs shared by the pickers below: `today` for
 * deterministic tests, and `recencyRank` — a soft, per-id tiebreaker (lower
 * is more recent, `Infinity` means "not recently used") sourced from
 * `recentlyViewed.ts`. Neither ever outranks a clearly better text match.
 */
export interface RankingContext {
  today?: string;
  recencyRank?: (id: number) => number;
}

const noRecencyBoost = () => Number.POSITIVE_INFINITY;

function mostUrgentDate(task: Task): string | null {
  const candidates = [
    task.scheduledDate,
    task.dueDate,
    task.externalWait?.revisitDate ?? null,
  ].filter((value): value is string => !!value);
  if (candidates.length === 0) return null;
  return candidates.reduce((earliest, value) =>
    value < earliest ? value : earliest,
  );
}

/**
 * Coarse, testable temporal-attention buckets — overdue/today, next 7 days,
 * next 30 days, none — using whichever of scheduled/due/revisit date is
 * most urgent. A distant future date must never outrank a clearly better
 * text match, so this is only ever consulted after `textMatchRank`.
 */
function temporalRelevanceBucket(task: Task, today: string): 0 | 1 | 2 | 3 {
  const date = mostUrgentDate(task);
  if (!date) return 3;
  if (date <= today) return 0;
  if (date <= addIsoCalendarDays(today, 7)) return 1;
  if (date <= addIsoCalendarDays(today, 30)) return 2;
  return 3;
}

function fold(value: string, locale: Locale): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase(locale);
}

function compareText(a: string, b: string, locale: Locale): number {
  return a.localeCompare(b, locale, { sensitivity: "base" });
}

function compareTitleAndId(
  a: { id: number; title: string },
  b: { id: number; title: string },
  locale: Locale,
): number {
  return compareText(a.title, b.title, locale) || a.id - b.id;
}

export function sortMembersByName(
  members: readonly Member[],
  locale: Locale,
): Member[] {
  return [...members].sort(
    (a, b) => compareText(a.name, b.name, locale) || a.id - b.id,
  );
}

export function sortProjectsByTitle<T extends Pick<Project, "id" | "title">>(
  projects: readonly T[],
  locale: Locale,
): T[] {
  return [...projects].sort((a, b) => compareTitleAndId(a, b, locale));
}

const projectDestinationRank: Record<Project["status"], number> = {
  active: 0,
  backlog: 1,
  completed: 2,
  archived: 3,
};

// Destination pickers must exclude terminal (completed/archived) projects
// outright rather than merely deprioritize them — a finished project is
// never a legitimate move target.
export function sortProjectDestinations<
  T extends Pick<Project, "id" | "title" | "status">,
>(projects: readonly T[], locale: Locale): T[] {
  return projects
    .filter(
      (project) =>
        project.status !== "completed" && project.status !== "archived",
    )
    .sort(
      (a, b) =>
        projectDestinationRank[a.status] -
          projectDestinationRank[b.status] ||
        compareTitleAndId(a, b, locale),
    );
}

const taskInventoryRank: Record<TaskStatus, number> = {
  actionable: 0,
  captured: 1,
  someday: 2,
  done: 3,
  cancelled: 4,
};

function textMatchRank(task: Task, query: string, locale: Locale): number {
  const needle = fold(query.trim(), locale);
  if (!needle) return 0;
  const title = fold(task.title, locale);
  if (title === needle) return 0;
  if (title.startsWith(needle)) return 1;
  if (
    title
      .split(/[^a-z0-9]+/i)
      .some((word) => word.startsWith(needle))
  ) {
    return 2;
  }
  if (title.includes(needle)) return 3;
  if (fold(task.notes, locale).includes(needle)) return 4;
  return 5;
}

export function sortInventoryTasks(
  tasks: readonly Task[],
  query: string,
  locale: Locale,
  context: RankingContext = {},
): Task[] {
  const today = context.today ?? toIsoCalendarDate(new Date());
  const recencyRank = context.recencyRank ?? noRecencyBoost;
  return [...tasks].sort(
    (a, b) =>
      textMatchRank(a, query, locale) - textMatchRank(b, query, locale) ||
      temporalRelevanceBucket(a, today) - temporalRelevanceBucket(b, today) ||
      taskInventoryRank[a.status] - taskInventoryRank[b.status] ||
      recencyRank(a.id) - recencyRank(b.id) ||
      compareTitleAndId(a, b, locale),
  );
}

/**
 * Dependency candidates must exclude done/cancelled tasks entirely — a
 * finished task can never genuinely block anything, so it is filtered out
 * rather than merely sorted lower.
 */
export function sortDependencyCandidates(
  tasks: readonly Task[],
  currentTask: Task,
  query: string,
  locale: Locale,
  context: RankingContext = {},
): Task[] {
  const existingIds = new Set(
    currentTask.dependencies.map((dependency) => dependency.dependsOnTaskId),
  );
  const today = context.today ?? toIsoCalendarDate(new Date());
  const recencyRank = context.recencyRank ?? noRecencyBoost;
  return tasks
    .filter(
      (candidate) =>
        candidate.id !== currentTask.id &&
        !existingIds.has(candidate.id) &&
        candidate.status !== "done" &&
        candidate.status !== "cancelled",
    )
    .sort(
      (a, b) =>
        textMatchRank(a, query, locale) - textMatchRank(b, query, locale) ||
        Number(b.projectId === currentTask.projectId) -
          Number(a.projectId === currentTask.projectId) ||
        temporalRelevanceBucket(a, today) - temporalRelevanceBucket(b, today) ||
        recencyRank(a.id) - recencyRank(b.id) ||
        compareTitleAndId(a, b, locale),
    );
}

export function sortDependencies(
  dependencies: readonly Dependency[],
  locale: Locale,
): Dependency[] {
  return [...dependencies].sort(
    (a, b) =>
      Number(a.resolved) - Number(b.resolved) ||
      compareText(
        a.title ?? `#${a.dependsOnTaskId}`,
        b.title ?? `#${b.dependsOnTaskId}`,
        locale,
      ) ||
      a.dependsOnTaskId - b.dependsOnTaskId,
  );
}
