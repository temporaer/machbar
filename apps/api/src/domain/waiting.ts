import type { Graph, TaskRecord } from "./graph.js";
import { isTaskInWorkingSystem } from "./workEligibility.js";

/**
 * Lists actionable tasks with a direct external wait once per task.
 * Dependency-only blockers remain visible in their project without
 * duplicating the external task they eventually lead to in Waiting.
 */
export function buildBlockedWork(
  graph: Graph,
  actorTagId?: number,
): TaskRecord[] {
  const projectStatusById = new Map(
    [...graph.projectsById.values()].map((project) => [
      project.id,
      project.status,
    ]),
  );
  return graph
    .allTasks()
    .filter(
      (task) =>
        task.status === "actionable" &&
        task.externalWait !== null &&
        isTaskInWorkingSystem(task, projectStatusById) &&
        (actorTagId === undefined ||
          task.effectiveActorTags.some((tag) => tag.id === actorTagId)),
    )
    .sort((a, b) => {
      const attentionA =
        a.scheduledDate ?? a.nextBlockerAttentionDate ?? "9999-99-99";
      const attentionB =
        b.scheduledDate ?? b.nextBlockerAttentionDate ?? "9999-99-99";
      if (attentionA !== attentionB) {
        return attentionA.localeCompare(attentionB);
      }
      const dueA = a.dueDate ?? "9999-99-99";
      const dueB = b.dueDate ?? "9999-99-99";
      if (dueA !== dueB) return dueA.localeCompare(dueB);
      return a.position - b.position || a.id - b.id;
    });
}
