import type { Task } from "@machbar/shared";

export interface ProjectMaterialItem {
  task: Task;
  parentTitles: string[];
}

export function projectMaterialItems(tasks: readonly Task[]): ProjectMaterialItem[] {
  const materials: ProjectMaterialItem[] = [];
  const visit = (task: Task, parentTitles: string[]) => {
    if (task.kind === "reference") materials.push({ task, parentTitles });
    const childParentTitles = [...parentTitles, task.title];
    task.children.forEach((child) => visit(child, childParentTitles));
  };
  tasks.forEach((task) => visit(task, []));
  return materials;
}
