/**
 * Shared write-path primitives used by both task and story mutations: actor/context
 * extraction, revision-guard helpers (`assertExpectedRevision`/`touchTask`/
 * `touchProject`), and the small set of
 * project-state checks (`projectHasNextAction`/`projectHasTaskPlan`/
 * `assertProjectActivationReady`) that task mutations also need when a task's
 * change affects its story's contribution/activation state.
 */
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { AppError } from "../errors.js";
import { getEffectiveOwners, getNextActionTaskIdsByProject } from "../repo/index.js";
import { enqueueNotification } from "../notifications/outbox.js";
import { getProjectActivationReadiness } from "./projectReadiness.js";
import { getTaskIdsForStory } from "../repo/treeRepo.js";

export interface MutationContext {
  actorMemberId?: number | null;
}

export function actor(context?: MutationContext): number | null {
  return context?.actorMemberId ?? null;
}

export function enqueueProjectAssignment(
  db: Db,
  project: { id: number; title: string; ownerMemberId: number | null },
  activityEventId: number,
  context?: MutationContext,
): void {
  if (project.ownerMemberId === null) return;
  enqueueNotification(db, {
    kind: "project_assigned",
    recipientMemberId: project.ownerMemberId,
    actorMemberId: actor(context),
    entityType: "project",
    entityId: project.id,
    entityTitle: project.title,
    sourceKey: `project:${project.id}:assigned:event:${activityEventId}`,
  });
}

export function sameIds(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

export function sortedIds(ids: number[]): number[] {
  return [...new Set(ids)].sort((a, b) => a - b);
}

export function assertPhysicalContextsExist(db: Db, contextIds: number[]): void {
  const ids = sortedIds(contextIds);
  if (ids.length === 0) return;
  const found = db
    .select({ id: schema.physicalContexts.id })
    .from(schema.physicalContexts)
    .where(inArray(schema.physicalContexts.id, ids))
    .all()
    .map((row) => row.id);
  const missing = ids.filter((id) => !found.includes(id));
  if (missing.length > 0) {
    throw AppError.notFound(
      "physical_context_not_found",
      "A selected physical context was not found.",
      { contextIds: missing },
    );
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function touchTask(db: Db, taskId: number): void {
  db.update(schema.workItems)
    .set({
      revision: sql`${schema.workItems.revision} + 1`,
      updatedAt: nowIso(),
    })
    .where(and(eq(schema.workItems.id, taskId), eq(schema.workItems.role, "task")))
    .run();
}

export function touchProject(db: Db, projectId: number): void {
  db.update(schema.workItems)
    .set({
      revision: sql`${schema.workItems.revision} + 1`,
      updatedAt: nowIso(),
    })
    .where(and(eq(schema.workItems.id, projectId), eq(schema.workItems.role, "story")))
    .run();
}

export function assertExpectedRevision(
  entityType: "task" | "project",
  entityId: number,
  currentRevision: number,
  expectedRevision: number | undefined,
): void {
  if (expectedRevision === undefined || expectedRevision === currentRevision) {
    return;
  }
  throw AppError.conflict(
    "stale_write_conflict",
    "This item was changed by another client. Reload it before saving again.",
    { entityType, entityId, expectedRevision, currentRevision },
  );
}

export function effectiveOwnerId(db: Db, taskId: number): number | null {
  return getEffectiveOwners(db).get(taskId)?.ownerId ?? null;
}

export function projectHasNextAction(db: Db, projectId: number): boolean {
  return getNextActionTaskIdsByProject(db).has(projectId);
}

export function assertProjectActivationReady(
  db: Db,
  projectId: number,
  ownerMemberId: number | null,
): void {
  if (ownerMemberId === null) {
    throw AppError.badRequest(
      "project_driver_required",
      "A project driver is required before the project can be activated.",
      { projectId },
    );
  }
  const readiness = getProjectActivationReadiness(
    db,
    projectId,
    ownerMemberId,
  );
  if (!readiness.ready) {
    throw AppError.conflict(
      "project_activation_not_ready",
      "An active project needs an executable progress path or a healthy future waiting point.",
      { projectId, ...readiness },
    );
  }
}

export function projectHasTaskPlan(db: Db, projectId: number): boolean {
  const project = db
    .select({ dueDate: schema.workItems.dueDate })
    .from(schema.workItems)
    .where(and(eq(schema.workItems.id, projectId), eq(schema.workItems.role, "story")))
    .get();
  if (project?.dueDate === null || project === undefined) return true;

  const taskIds = getTaskIdsForStory(db, projectId);
  if (taskIds.length === 0) return false;
  return db
    .select({
      dueDate: schema.workItems.dueDate,
      scheduledDate: schema.workItems.scheduledDate,
    })
    .from(schema.workItems)
    .where(
      and(
        inArray(schema.workItems.id, taskIds),
        inArray(schema.workItems.status, ["captured", "active", "backlog"]),
      ),
    )
    .all()
    .some((task) => task.dueDate !== null || task.scheduledDate !== null);
}

export function appendNoteContent(existing: string, incoming: string): string {
  const appended = incoming.trim();
  if (appended === "") return existing;
  if (existing.trim() === "") return appended;
  if (existing.endsWith("\n\n")) return `${existing}${appended}`;
  if (existing.endsWith("\n")) return `${existing}\n${appended}`;
  return `${existing}\n\n${appended}`;
}
