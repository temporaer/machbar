import type { WaitingGroup } from "@machbar/shared";
import type { Graph, TaskRecord } from "./graph.js";
import { isTaskInWorkingSystem } from "./workEligibility.js";

/** Groups "waiting" tasks by their free-text `waitingFor` value. */
export function buildWaitingGroups(
  graph: Graph,
  actorTagId?: number,
): WaitingGroup[] {
  const groups = new Map<string | null, TaskRecord[]>();
  const projectStatusById = new Map(
    [...graph.projectsById.values()].map((project) => [
      project.id,
      project.status,
    ]),
  );
  for (const task of graph.allTasks()) {
    if (task.status !== "waiting") continue;
    if (!isTaskInWorkingSystem(task, projectStatusById)) continue;
    if (
      actorTagId !== undefined &&
      !task.effectiveActorTags.some((tag) => tag.id === actorTagId)
    ) {
      continue;
    }
    const key = task.waitingFor?.trim() || null;
    const list = groups.get(key) ?? [];
    list.push(task);
    groups.set(key, list);
  }

  return [...groups.entries()]
    .sort(([a], [b]) => {
      if (a === null) return 1;
      if (b === null) return -1;
      return a.localeCompare(b);
    })
    .map(([waitingFor, tasks]) => ({
      waitingFor,
      tasks: tasks.sort((a, b) => {
        const dueA = a.dueDate ?? "9999-99-99";
        const dueB = b.dueDate ?? "9999-99-99";
        if (dueA !== dueB) return dueA < dueB ? -1 : 1;
        return a.position - b.position;
      }),
    }));
}
