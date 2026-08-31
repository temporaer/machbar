import type {
  Dependency,
  Member,
  Project,
  Task,
  TaskStatus,
} from "@machbar/shared";
import type { Locale } from "../i18n/catalog";

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

export function sortProjectDestinations<
  T extends Pick<Project, "id" | "title" | "status">,
>(projects: readonly T[], locale: Locale): T[] {
  return [...projects].sort(
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
): Task[] {
  return [...tasks].sort(
    (a, b) =>
      textMatchRank(a, query, locale) - textMatchRank(b, query, locale) ||
      taskInventoryRank[a.status] - taskInventoryRank[b.status] ||
      compareTitleAndId(a, b, locale),
  );
}

function terminalTaskRank(task: Task): number {
  return task.status === "done" || task.status === "cancelled" ? 1 : 0;
}

export function sortDependencyCandidates(
  tasks: readonly Task[],
  currentTask: Task,
  query: string,
  locale: Locale,
): Task[] {
  const existingIds = new Set(
    currentTask.dependencies.map((dependency) => dependency.dependsOnTaskId),
  );
  return tasks
    .filter(
      (candidate) =>
        candidate.id !== currentTask.id && !existingIds.has(candidate.id),
    )
    .sort(
      (a, b) =>
        textMatchRank(a, query, locale) - textMatchRank(b, query, locale) ||
        Number(b.projectId === currentTask.projectId) -
          Number(a.projectId === currentTask.projectId) ||
        terminalTaskRank(a) - terminalTaskRank(b) ||
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
