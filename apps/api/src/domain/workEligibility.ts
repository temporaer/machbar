import type { ProjectStatus } from "@machbar/shared";

export function effectiveProjectStatuses(
  items: ReadonlyArray<{ id: number; parentId: number | null; role: string }>,
  projectStatuses: ReadonlyMap<number, ProjectStatus>,
): Map<number, ProjectStatus> {
  const parents = new Map(items.map((item) => [item.id, item.parentId]));
  const result = new Map(projectStatuses);
  for (const [id, status] of projectStatuses) {
    if (status !== "active") continue;
    const seen = new Set([id]);
    let parentId = parents.get(id) ?? null;
    while (parentId !== null && !seen.has(parentId)) {
      seen.add(parentId);
      if (projectStatuses.get(parentId) === "backlog") {
        result.set(id, "backlog");
        break;
      }
      parentId = parents.get(parentId) ?? null;
    }
  }
  return result;
}

export function isTaskInWorkingSystem(
  task: { projectId: number | null },
  projectStatusById: ReadonlyMap<number, ProjectStatus>,
): boolean {
  return (
    task.projectId === null ||
    projectStatusById.get(task.projectId) === "active"
  );
}
