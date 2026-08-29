import type { ProjectStatus } from "@machbar/shared";

export function isTaskInWorkingSystem(
  task: { projectId: number | null },
  projectStatusById: ReadonlyMap<number, ProjectStatus>,
): boolean {
  return (
    task.projectId === null ||
    projectStatusById.get(task.projectId) === "active"
  );
}
