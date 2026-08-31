import type { SearchFilters } from "@machbar/shared";
import type { Task } from "@machbar/shared";
import type { ProjectWithActions } from "./api";

function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase();
}

export function hasInventoryFilters(filters: SearchFilters): boolean {
  return Object.values(filters).some((value) =>
    Array.isArray(value) ? value.length > 0 : value !== undefined && value !== "",
  );
}

export function filterInventoryProjects(
  projects: readonly ProjectWithActions[],
  filters: SearchFilters,
): ProjectWithActions[] {
  if (filters.status !== undefined || filters.blocked !== undefined || filters.externalWait !== undefined) {
    return [];
  }

  const needle = fold(filters.text?.trim() ?? "");
  return projects.filter((project) => {
    if (filters.projectId !== undefined && project.id !== filters.projectId) return false;
    if (filters.ownerId !== undefined && project.ownerMemberId !== filters.ownerId) return false;
    if (
      filters.tagIds?.length &&
      !filters.tagIds.every((id) => project.effectiveTags.some((tag) => tag.id === id))
    ) {
      return false;
    }
    if (filters.dueFrom !== undefined && (!project.dueDate || project.dueDate < filters.dueFrom)) {
      return false;
    }
    if (filters.dueTo !== undefined && (!project.dueDate || project.dueDate > filters.dueTo)) {
      return false;
    }
    if (
      filters.scheduledFrom !== undefined &&
      (!project.scheduledDate || project.scheduledDate < filters.scheduledFrom)
    ) {
      return false;
    }
    if (
      filters.scheduledTo !== undefined &&
      (!project.scheduledDate || project.scheduledDate > filters.scheduledTo)
    ) {
      return false;
    }
    if (!needle) return true;
    return [
      project.title,
      project.notes,
      project.ownerMemberId === null ? "" : String(project.ownerMemberId),
      project.dueDate ?? "",
      project.scheduledDate ?? "",
      ...project.tags.map((tag) => tag.name),
      ...project.acceptanceCriteria.map((criterion) => criterion.text),
    ].some((value) => fold(value).includes(needle));
  });
}

export function topLevelTaskResults(tasks: readonly Task[]): Task[] {
  const resultIds = new Set(tasks.map((task) => task.id));
  const parentById = new Map<number, number | null>();
  const visit = (task: Task) => {
    parentById.set(task.id, task.parentTaskId);
    for (const child of task.children) visit(child);
  };
  for (const task of tasks) visit(task);

  return tasks.filter((task) => {
    const seen = new Set<number>([task.id]);
    let parentId = parentById.get(task.id) ?? null;
    while (parentId !== null && !seen.has(parentId)) {
      if (resultIds.has(parentId)) return false;
      seen.add(parentId);
      parentId = parentById.get(parentId) ?? null;
    }
    return true;
  });
}
