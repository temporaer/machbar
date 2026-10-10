import type { Db } from "../db/client.js";
import { AppError } from "../errors.js";
import { Graph } from "../domain/graph.js";

export type RefinementTargetType = "task" | "project";

export function buildRefinementSnapshot(db: Db, targetType: RefinementTargetType, targetId: number, viewerMemberId: number | null) {
  const graph = Graph.load(db, undefined, viewerMemberId ?? undefined);
  if (targetType === "task") {
    const task = graph.tasksById.get(targetId);
    if (!task) throw AppError.notFound("task_not_found", "The requested task was not found or is no longer accessible.");
    const describe = (item: typeof task): unknown => ({
      id: item.id, revision: item.revision, title: item.title, notes: item.notes, status: item.status,
      scope: item.scope,
      kind: item.kind, externalWait: item.externalWait, dependencies: item.dependencies,
      dueDate: item.dueDate, scheduledDate: item.scheduledDate, ownerMemberId: item.ownerMemberId,
      revisitAt: item.revisitAt, notBeforeAt: item.notBeforeAt, notBeforeDate: item.notBeforeDate,
      priority: item.priority, size: item.size,
      ownerInheritanceMode: item.ownerInheritanceMode, inheritedOwnerId: item.inheritedOwnerId,
      parentTaskId: item.parentTaskId, projectId: item.projectId, repeatAfterDays: item.repeatAfterDays,
      position: item.position,
      reminders: item.reminders,
      children: item.children.map((child) => describe(child)),
    });
    return { target: describe(task), scope: task.scope, revision: task.revision, snapshot: JSON.stringify(describe(task)) };
  }
  const project = graph.projectsById.get(targetId);
  if (!project) throw AppError.notFound("project_not_found", "The requested project was not found or is no longer accessible.");
  const tasks = graph.tasksByProject.get(targetId) ?? [];
  const describe = (item: (typeof tasks)[number]): unknown => ({
    id: item.id, revision: item.revision, title: item.title, notes: item.notes, status: item.status,
    scope: item.scope,
    kind: item.kind, externalWait: item.externalWait, dependencies: item.dependencies,
    dueDate: item.dueDate, scheduledDate: item.scheduledDate, ownerMemberId: item.ownerMemberId,
    revisitAt: item.revisitAt, ownerInheritanceMode: item.ownerInheritanceMode, inheritedOwnerId: item.inheritedOwnerId,
    parentTaskId: item.parentTaskId, projectId: item.projectId, repeatAfterDays: item.repeatAfterDays,
    position: item.position,
    reminders: item.reminders,
    children: item.children.map((child) => describe(child)),
  });
  const describeProject = (item: typeof project): unknown => {
    const projectTasks = graph.tasksByProject.get(item.id) ?? [];
    const next = graph.nextActionFor(item.id);
    return {
      id: item.id, revision: item.revision, title: item.title, notes: item.notes,
      status: item.status, scope: item.scope, ownerMemberId: item.ownerMemberId, dueDate: item.dueDate,
      revisitAt: item.revisitAt, outcome: item.acceptanceCriteria,
      currentNextAction: next ? { id: next.id, title: next.title, status: next.status } : null,
      tasks: projectTasks.filter((candidate) => candidate.parentTaskId === null).map((candidate) => describe(candidate)),
      projects: item.childStories.map((child) => describeProject(child)),
    };
  };
  const target = describeProject(project);
  return { target, scope: project.scope, revision: project.revision, snapshot: JSON.stringify(target) };
}
