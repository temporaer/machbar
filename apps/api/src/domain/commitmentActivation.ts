import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { AppError } from "../errors.js";
import { recordActivity, recordContribution } from "../repo/index.js";
import { getProjectActivationReadiness } from "./projectReadiness.js";
import { insertTaskRow } from "./taskRowInsert.js";
import { type MutationContext, actor, nowIso } from "./workItemShared.js";

/** Activate only the selected project; caller owns the surrounding transaction. */
export function activateProjectFromWorkflow(
  db: Db,
  projectId: number,
  ownerMemberId: number | null,
  context?: MutationContext,
  nextActionTitle?: string,
): number {
  const project = db.select().from(schema.workItems)
    .where(and(eq(schema.workItems.id, projectId), eq(schema.workItems.role, "story"))).get();
  if (!project) throw AppError.notFound("project_not_found", "The project was not found.", { projectId });
  if (ownerMemberId === null) {
    throw AppError.badRequest("project_driver_required", "A project driver is required before the project can be activated.", { projectId });
  }
  const member = db.select({ id: schema.members.id }).from(schema.members)
    .where(eq(schema.members.id, ownerMemberId)).get();
  if (!member) throw AppError.notFound("member_not_found", "The selected project driver was not found.", { memberId: ownerMemberId });
  const readiness = getProjectActivationReadiness(db, projectId, ownerMemberId);
  const title = nextActionTitle?.trim() ?? "";
  const hasPath = readiness.hasViableProgressPath || readiness.hasHealthyFutureWaiting || readiness.hasHealthyFutureRevisit;
  if (!hasPath && !title) {
    throw AppError.conflict("project_activation_not_ready", "An active project needs an executable progress path or a healthy future waiting point.", {
      projectId,
      hasViableProgressPath: readiness.hasViableProgressPath,
      hasHealthyFutureWaiting: readiness.hasHealthyFutureWaiting,
      hasHealthyFutureRevisit: readiness.hasHealthyFutureRevisit,
      requiredDecisions: ["progressPath"],
    });
  }
  if (title) {
    const task = insertTaskRow(db, { parentId: projectId, title, status: "actionable", scope: project.scope });
    recordActivity(db, {
      actorMemberId: actor(context), kind: "task_created", entityType: "task",
      entityTitle: task.title, taskId: task.id, projectId, metadata: {},
    });
  }
  db.update(schema.workItems).set({
    status: "active", archivedAt: null, completedAt: null, ownerMemberId,
    revision: sql`${schema.workItems.revision} + 1`, updatedAt: nowIso(),
  }).where(eq(schema.workItems.id, projectId)).run();
  const activityEventId = recordActivity(db, {
    actorMemberId: actor(context), kind: "project_status_changed", entityType: "project",
    entityTitle: project.title, projectId,
    metadata: {
      previousStatus: project.archivedAt !== null ? "archived" : project.status === "done" ? "completed" : project.status === "active" ? "active" : "backlog",
      nextStatus: "active",
      ...(ownerMemberId !== project.ownerMemberId ? { changedFields: ["ownerMemberId"] } : {}),
    },
  });
  if (project.ownerMemberId === null) {
    recordContribution(db, {
      activityEventId, actorMemberId: actor(context), category: "planning",
      reason: "project_driver_assigned", entityType: "project", entityId: projectId, personalEligible: true,
    });
  }
  return activityEventId;
}
