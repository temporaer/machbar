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

function parentId(
  id: number,
  projectsById: ReadonlyMap<number, ProjectWithActions>,
  tasksById: ReadonlyMap<number, Task>,
): number | null {
  const project = projectsById.get(id);
  if (project) return project.parentId;
  const task = tasksById.get(id);
  return task ? task.parentTaskId ?? task.projectId : null;
}

function hasVisibleLaterAncestor(
  id: number,
  laterIds: ReadonlySet<number>,
  projectsById: ReadonlyMap<number, ProjectWithActions>,
  tasksById: ReadonlyMap<number, Task>,
): boolean {
  const visited = new Set<number>([id]);
  let ancestorId = parentId(id, projectsById, tasksById);
  while (ancestorId !== null && !visited.has(ancestorId)) {
    if (laterIds.has(ancestorId)) return true;
    visited.add(ancestorId);
    ancestorId = parentId(ancestorId, projectsById, tasksById);
  }
  return false;
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
        (task.projectId === null || !visibleProjectIds.has(task.projectId)),
    )
    .sort(
      (a, b) =>
        a.position - b.position ||
        a.title.localeCompare(b.title, locale) ||
        a.id - b.id,
    );

  const projectsById = new Map(allProjects.map((project) => [project.id, project]));
  const tasksById = new Map(allTasks.map((task) => [task.id, task]));
  const laterIds = new Set([
    ...laterProjects.map((project) => project.id),
    ...laterTasks.map((task) => task.id),
  ]);
  return {
    projects: laterProjects.filter(
      (project) =>
        !hasVisibleLaterAncestor(project.id, laterIds, projectsById, tasksById),
    ),
    tasks: laterTasks.filter(
      (task) =>
        !hasVisibleLaterAncestor(task.id, laterIds, projectsById, tasksById),
    ),
  };
}
