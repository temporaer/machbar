import type { Task } from "@machbar/shared";
import type { Locale } from "../i18n/catalog";
import type { ProjectWithActions } from "./api";
import {
  filterAndSortProjects,
  type ProjectVisibilityScope,
} from "./projectListFilter";

export interface LaterInventoryOptions {
  query: string;
  scope: ProjectVisibilityScope;
  currentMemberId: number | null;
  locale?: Locale;
}

export interface LaterInventoryRoots {
  projects: ProjectWithActions[];
  tasks: Task[];
}

function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function taskMatchesQuery(task: Task, query: string): boolean {
  if (!query) return true;
  const values = [
    task.title,
    task.notes,
    task.externalWait?.waitingFor ?? "",
    ...task.acceptanceCriteria.map((criterion) => criterion.text),
  ];
  return values.some((value) => fold(value).includes(query));
}

function taskMatchesScope(
  task: Task,
  scope: ProjectVisibilityScope,
  currentMemberId: number | null,
): boolean {
  if (scope === "work") return task.scope === "work";
  if (task.scope === "work") return false;
  if (scope === "all") return true;
  if (currentMemberId === null) return task.effectiveOwnerId === null;
  return task.effectiveOwnerId === null || task.effectiveOwnerId === currentMemberId;
}

function hasVisibleLaterProjectAncestor(
  projectId: number,
  laterProjectIds: ReadonlySet<number>,
  projectsById: ReadonlyMap<number, ProjectWithActions>,
): boolean {
  const visited = new Set<number>([projectId]);
  let ancestorId = projectsById.get(projectId)?.parentId ?? null;
  while (ancestorId !== null && !visited.has(ancestorId)) {
    const ancestor = projectsById.get(ancestorId);
    if (!ancestor) return false;
    if (laterProjectIds.has(ancestorId)) return true;
    visited.add(ancestorId);
    ancestorId = ancestor.parentId;
  }
  return false;
}

function hasVisibleLaterTaskAncestor(
  task: Task,
  laterTaskIds: ReadonlySet<number>,
  tasksById: ReadonlyMap<number, Task>,
  scope: ProjectVisibilityScope,
  currentMemberId: number | null,
  foldedQuery: string,
): boolean {
  const visited = new Set<number>([task.id]);
  let ancestorId = task.parentTaskId;
  while (ancestorId !== null && !visited.has(ancestorId)) {
    const ancestor = tasksById.get(ancestorId);
    if (
      !ancestor ||
      !taskMatchesScope(ancestor, scope, currentMemberId) ||
      !taskMatchesQuery(ancestor, foldedQuery)
    ) {
      return false;
    }
    if (laterTaskIds.has(ancestorId)) return true;
    visited.add(ancestorId);
    ancestorId = ancestor.parentTaskId;
  }
  return false;
}

function filterTaskTree(
  task: Task,
  scope: ProjectVisibilityScope,
  currentMemberId: number | null,
  foldedQuery: string,
): Task {
  return {
    ...task,
    children: task.children
      .filter(
        (child) =>
          taskMatchesScope(child, scope, currentMemberId) &&
          taskMatchesQuery(child, foldedQuery),
      )
      .map((child) =>
        filterTaskTree(child, scope, currentMemberId, foldedQuery),
      ),
  };
}

export function selectLaterInventoryRoots(
  allProjects: readonly ProjectWithActions[],
  allTasks: readonly Task[],
  {
    query,
    scope,
    currentMemberId,
    locale = "de",
  }: LaterInventoryOptions,
): LaterInventoryRoots {
  const foldedQuery = fold(query.trim());
  const visibleProjects = filterAndSortProjects([...allProjects], {
    query,
    scope,
    currentMemberId,
    locale,
  });
  const laterProjects = visibleProjects.filter(
    (project) =>
      project.status === "backlog" ||
      (project.status === "active" && project.effectivelyDeferred === true),
  );
  const visibleProjectIds = new Set(visibleProjects.map((project) => project.id));
  const laterTasks = allTasks
    .filter(
      (task) =>
        task.kind === "action" &&
        task.status !== "done" &&
        task.status !== "cancelled" &&
        (task.status === "someday" || task.effectivelyDeferred === true) &&
        taskMatchesScope(task, scope, currentMemberId) &&
        taskMatchesQuery(task, foldedQuery) &&
        (foldedQuery !== "" ||
          task.projectId === null ||
          !visibleProjectIds.has(task.projectId)),
    )
    .sort(
      (a, b) =>
        a.position - b.position ||
        a.title.localeCompare(b.title, locale) ||
        a.id - b.id,
    );

  const projectsById = new Map(allProjects.map((project) => [project.id, project]));
  const tasksById = new Map(allTasks.map((task) => [task.id, task]));
  const laterProjectIds = new Set(laterProjects.map((project) => project.id));
  const laterTaskIds = new Set(laterTasks.map((task) => task.id));
  return {
    projects: laterProjects.filter(
      (project) =>
        !hasVisibleLaterProjectAncestor(
          project.id,
          laterProjectIds,
          projectsById,
        ),
    ),
    tasks: laterTasks.filter(
      (task) =>
        !hasVisibleLaterTaskAncestor(
          task,
          laterTaskIds,
          tasksById,
          scope,
          currentMemberId,
          foldedQuery,
        ),
    ).map((task) =>
      filterTaskTree(task, scope, currentMemberId, foldedQuery),
    ),
  };
}
