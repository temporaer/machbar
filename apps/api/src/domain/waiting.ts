import type { Graph, TaskRecord } from "./graph.js";
import { isTaskInWorkingSystem } from "./workEligibility.js";

/**
 * Lists actionable blocked work once per task. Blocker details stay
 * structured on each task; callers may group by tags but never by a
 * dependency title masquerading as free-text waiting context.
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
        task.blocked &&
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
