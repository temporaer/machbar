import { eq } from "drizzle-orm";
import type { ProjectActivationReadiness } from "@machbar/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { getNextActionTaskIdsByProject } from "../repo/nextActionRepo.js";
import {
  analyzeTaskBlockers,
  type TaskBlockerAnalysis,
} from "./blockers.js";

export function evaluateProjectActivationReadiness(input: {
  ownerMemberId: number | null;
  candidateTaskIds: readonly number[];
  projectTaskIds: readonly number[];
  blockerAnalysisByTask: ReadonlyMap<number, TaskBlockerAnalysis>;
  today: string;
}): ProjectActivationReadiness {
  const hasDriver = input.ownerMemberId !== null;
  const hasViableProgressPath = input.candidateTaskIds.length > 0;
  const hasHealthyFutureWaiting = input.projectTaskIds.some((taskId) => {
    const analysis = input.blockerAnalysisByTask.get(taskId);
    return (
      analysis?.blocked === true &&
      analysis.healthyProgressPath &&
      analysis.nextBlockerAttentionDate !== null &&
      analysis.nextBlockerAttentionDate > input.today
    );
  });
  return {
    ready:
      hasDriver && (hasViableProgressPath || hasHealthyFutureWaiting),
    hasDriver,
    hasViableProgressPath,
    hasHealthyFutureWaiting,
  };
}

export function getProjectActivationReadiness(
  db: Db,
  projectId: number,
  ownerMemberId: number | null,
  today = new Date().toISOString().slice(0, 10),
): ProjectActivationReadiness {
  const tasks = db.select().from(schema.tasks).all();
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const waits = new Map(
    db
      .select()
      .from(schema.taskExternalWaits)
      .all()
      .map((wait) => [
        wait.taskId,
        {
          waitingFor: wait.waitingFor?.trim() || null,
          revisitDate: wait.revisitDate,
        },
      ]),
  );
  const dependenciesByTask = new Map<
    number,
    Array<{ dependsOnTaskId: number; resolved: boolean }>
  >();
  for (const dependency of db.select().from(schema.taskDependencies).all()) {
    const prerequisite = tasksById.get(dependency.dependsOnTaskId);
    const list = dependenciesByTask.get(dependency.taskId) ?? [];
    list.push({
      dependsOnTaskId: dependency.dependsOnTaskId,
      resolved:
        prerequisite?.status === "done" ||
        prerequisite?.status === "cancelled",
    });
    dependenciesByTask.set(dependency.taskId, list);
  }
  const projectStatuses = new Map(
    db
      .select({ id: schema.projects.id, status: schema.projects.status })
      .from(schema.projects)
      .all()
      .map((project) => [
        project.id,
        (project.id === projectId ? "active" : project.status) as
          | "backlog"
          | "active"
          | "completed"
          | "archived",
      ]),
  );
  const blockerAnalysis = analyzeTaskBlockers(
    new Map(
      tasks.map((task) => [
        task.id,
        {
          id: task.id,
          title: task.title,
          status: task.status as
            | "captured"
            | "actionable"
            | "someday"
            | "done"
            | "cancelled",
          projectId: task.projectId,
          scheduledDate: task.scheduledDate,
          externalWait: waits.get(task.id) ?? null,
          dependencies: dependenciesByTask.get(task.id) ?? [],
        },
      ]),
    ),
    projectStatuses,
    today,
  );
  const projectTaskIds = tasks
    .filter((task) => task.projectId === projectId)
    .map((task) => task.id);
  return evaluateProjectActivationReadiness({
    ownerMemberId,
    candidateTaskIds:
      getNextActionTaskIdsByProject(db).get(projectId) ?? [],
    projectTaskIds,
    blockerAnalysisByTask: blockerAnalysis,
    today,
  });
}
