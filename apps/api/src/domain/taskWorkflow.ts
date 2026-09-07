/**
 * Task lifecycle transitions: complete/cancel/reopen/clarify, and the
 * review-acknowledgement timestamp.
 */
import { eq, sql } from "drizzle-orm";
import type { TaskStatus } from "@machbar/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { AppError } from "../errors.js";
import {
  neutralizeContribution,
  recordActivity,
  recordContribution,
} from "../repo/index.js";
import { getTaskOrThrow, listDescendants, updateTask } from "./taskCrud.js";
import {
  MutationContext,
  actor,
  assertExpectedRevision,
  effectiveOwnerId,
  nowIso,
  projectHasNextAction,
  projectHasTaskPlan,
} from "./workItemShared.js";

export function acknowledgeTaskReview(
  db: Db,
  id: number,
  expectedRevision?: number,
  context?: MutationContext,
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const task = getTaskOrThrow(txDb, id);
    assertExpectedRevision("task", id, task.revision, expectedRevision);
    const updated = tx
      .update(schema.tasks)
      .set({
        reviewedAt: nowIso(),
        revision: sql`${schema.tasks.revision} + 1`,
      })
      .where(eq(schema.tasks.id, id))
      .returning()
      .get();
    recordActivity(txDb, {
      actorMemberId: actor(context),
      kind: "task_updated",
      entityType: "task",
      entityTitle: updated.title,
      taskId: id,
      projectId: updated.projectId,
      metadata: { changedFields: ["reviewedAt"] },
    });
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Complete / cancel / reopen with explicit descendants policy
// ---------------------------------------------------------------------------

export type DescendantsPolicy =
  | "leave_open"
  | "complete_children"
  | "cancel_children";
export type CompleteDescendantsPolicy = DescendantsPolicy;
export type CancelDescendantsPolicy = DescendantsPolicy;

function openDescendants(db: Db, id: number) {
  return listDescendants(db, id).filter(
    (t) => t.status !== "done" && t.status !== "cancelled",
  );
}

export function completeTask(
  db: Db,
  id: number,
  descendantsPolicy?: CompleteDescendantsPolicy,
  context?: MutationContext,
  completedOn?: string,
  expectedRevision?: number,
) {
  const current = getTaskOrThrow(db, id);
  if (current.repeatAfterDays !== null) {
    return updateTask(
      db,
      id,
      { status: "done", completedOn, expectedRevision },
      context,
    );
  }
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const task = getTaskOrThrow(txDb, id);
    assertExpectedRevision("task", id, task.revision, expectedRevision);
    const openChildren = openDescendants(txDb, id);
    const descendantsOnly =
      task.status === "done" &&
      descendantsPolicy !== undefined &&
      descendantsPolicy !== "leave_open" &&
      openChildren.length > 0;
    if (
      task.status === "done" &&
      !descendantsOnly
    ) {
      return task;
    }
    if (openChildren.length > 0 && descendantsPolicy === undefined) {
      throw new AppError(
        409,
        "descendants_policy_required",
        "A descendants policy is required because this task has open children.",
        {
          taskId: id,
          transition: "complete",
          openChildrenCount: openChildren.length,
          options: ["leave_open", "complete_children", "cancel_children"],
        },
      );
    }
    const recurringOpenChildren = openChildren.filter(
      (child) => child.repeatAfterDays !== null,
    );
    if (
      descendantsPolicy === "complete_children" &&
      recurringOpenChildren.length > 0
    ) {
      throw AppError.conflict(
        "recurring_descendant_completion_required",
        "Recurring subtasks must be completed individually.",
        {
          taskId: id,
          recurringTaskIds: recurringOpenChildren.map((child) => child.id),
        },
      );
    }
    const now = nowIso();
    if (!descendantsOnly) {
      tx.update(schema.tasks)
        .set({
          status: "done",
          needsClarification: false,
          completedAt: now,
          revision: sql`${schema.tasks.revision} + 1`,
          updatedAt: now,
        })
        .where(eq(schema.tasks.id, id))
        .run();
      tx.delete(schema.taskExternalWaits)
        .where(eq(schema.taskExternalWaits.taskId, id))
        .run();
    }

    if (
      descendantsPolicy === "complete_children" ||
      descendantsPolicy === "cancel_children"
    ) {
      const descendantStatus =
        descendantsPolicy === "complete_children" ? "done" : "cancelled";
      for (const child of openChildren) {
        tx.update(schema.tasks)
          .set({
            status: descendantStatus,
            needsClarification: false,
            completedAt: descendantStatus === "done" ? now : null,
            cancelledAt: descendantStatus === "cancelled" ? now : null,
            revision: sql`${schema.tasks.revision} + 1`,
            updatedAt: now,
          })
          .where(eq(schema.tasks.id, child.id))
          .run();
        tx.delete(schema.taskExternalWaits)
          .where(eq(schema.taskExternalWaits.taskId, child.id))
          .run();
      }
    }
    const updated = tx.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get()!;
    const activityEventId = recordActivity(txDb, {
      actorMemberId: actor(context),
      kind: descendantsOnly
        ? "task_descendants_status_changed"
        : "task_status_changed",
      entityType: "task",
      entityTitle: updated.title,
      taskId: id,
      projectId: updated.projectId,
      metadata: descendantsOnly
        ? {
            nextStatus:
              descendantsPolicy === "complete_children" ? "done" : "cancelled",
            affectedCount: openChildren.length,
          }
        : {
            previousStatus: task.status as TaskStatus,
            nextStatus: "done",
            ...(descendantsPolicy !== undefined &&
            descendantsPolicy !== "leave_open"
              ? { affectedCount: openChildren.length + 1 }
              : {}),
          },
    });
    if (!descendantsOnly) {
      const ownerId = effectiveOwnerId(txDb, id);
      recordContribution(txDb, {
        activityEventId,
        actorMemberId: actor(context),
        category: "completion",
        reason: "task_completed",
        entityType: "task",
        entityId: id,
        personalEligible: ownerId === null || ownerId === actor(context),
      });
    }
    return updated;
  });
}

export function cancelTask(
  db: Db,
  id: number,
  descendantsPolicy?: CancelDescendantsPolicy,
  context?: MutationContext,
  expectedRevision?: number,
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const task = getTaskOrThrow(txDb, id);
    assertExpectedRevision("task", id, task.revision, expectedRevision);
    const projectHadNextAction =
      task.projectId === null ? true : projectHasNextAction(txDb, task.projectId);
    const projectHadTaskPlan =
      task.projectId === null ? true : projectHasTaskPlan(txDb, task.projectId);
    const openChildren = openDescendants(txDb, id);
    const descendantsOnly =
      task.status === "cancelled" &&
      descendantsPolicy !== undefined &&
      descendantsPolicy !== "leave_open" &&
      openChildren.length > 0;
    if (
      task.status === "cancelled" &&
      !descendantsOnly
    ) {
      return task;
    }
    if (openChildren.length > 0 && descendantsPolicy === undefined) {
      throw new AppError(
        409,
        "descendants_policy_required",
        "A descendants policy is required because this task has open children.",
        {
          taskId: id,
          transition: "cancel",
          openChildrenCount: openChildren.length,
          options: ["leave_open", "complete_children", "cancel_children"],
        },
      );
    }
    const recurringOpenChildren = openChildren.filter(
      (child) => child.repeatAfterDays !== null,
    );
    if (
      descendantsPolicy === "complete_children" &&
      recurringOpenChildren.length > 0
    ) {
      throw AppError.conflict(
        "recurring_descendant_completion_required",
        "Recurring subtasks must be completed individually.",
        {
          taskId: id,
          recurringTaskIds: recurringOpenChildren.map((child) => child.id),
        },
      );
    }
    const now = nowIso();
    if (!descendantsOnly) {
      tx.update(schema.tasks)
        .set({
          status: "cancelled",
          needsClarification: false,
          cancelledAt: now,
          revision: sql`${schema.tasks.revision} + 1`,
          updatedAt: now,
        })
        .where(eq(schema.tasks.id, id))
        .run();
      tx.delete(schema.taskExternalWaits)
        .where(eq(schema.taskExternalWaits.taskId, id))
        .run();
    }

    if (
      descendantsPolicy === "complete_children" ||
      descendantsPolicy === "cancel_children"
    ) {
      const descendantStatus =
        descendantsPolicy === "complete_children" ? "done" : "cancelled";
      for (const child of openChildren) {
        tx.update(schema.tasks)
          .set({
            status: descendantStatus,
            needsClarification: false,
            completedAt: descendantStatus === "done" ? now : null,
            cancelledAt: descendantStatus === "cancelled" ? now : null,
            revision: sql`${schema.tasks.revision} + 1`,
            updatedAt: now,
          })
          .where(eq(schema.tasks.id, child.id))
          .run();
        tx.delete(schema.taskExternalWaits)
          .where(eq(schema.taskExternalWaits.taskId, child.id))
          .run();
      }
    }
    const updated = tx.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get()!;
    const activityEventId = recordActivity(txDb, {
      actorMemberId: actor(context),
      kind: descendantsOnly
        ? "task_descendants_status_changed"
        : "task_status_changed",
      entityType: "task",
      entityTitle: updated.title,
      taskId: id,
      projectId: updated.projectId,
      metadata: descendantsOnly
        ? {
            nextStatus:
              descendantsPolicy === "complete_children" ? "done" : "cancelled",
            affectedCount: openChildren.length,
          }
        : {
            previousStatus: task.status as TaskStatus,
            nextStatus: "cancelled",
            ...(descendantsPolicy !== undefined &&
            descendantsPolicy !== "leave_open"
              ? { affectedCount: openChildren.length + 1 }
              : {}),
          },
    });
    if (!descendantsOnly && task.status === "done") {
      neutralizeContribution(txDb, {
        activityEventId,
        reason: "task_completed",
        entityType: "task",
        entityId: id,
      });
    }
    if (task.projectId !== null) {
      if (
        projectHadNextAction &&
        !projectHasNextAction(txDb, task.projectId)
      ) {
        neutralizeContribution(txDb, {
          activityEventId,
          reason: "project_next_action_added",
          entityType: "project",
          entityId: task.projectId,
        });
      }
      if (
        projectHadTaskPlan &&
        !projectHasTaskPlan(txDb, task.projectId)
      ) {
        neutralizeContribution(txDb, {
          activityEventId,
          reason: "project_due_plan_added",
          entityType: "project",
          entityId: task.projectId,
        });
      }
    }
    return updated;
  });
}

export function reopenTask(
  db: Db,
  id: number,
  context?: MutationContext,
  expectedRevision?: number,
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const task = getTaskOrThrow(txDb, id);
    assertExpectedRevision("task", id, task.revision, expectedRevision);
    if (task.status === "actionable") return task;
    const now = nowIso();
    tx.update(schema.tasks)
      .set({
        status: "actionable",
        needsClarification: false,
        completedAt: null,
        cancelledAt: null,
        revision: sql`${schema.tasks.revision} + 1`,
        updatedAt: now,
      })
      .where(eq(schema.tasks.id, id))
      .run();
    const updated = tx.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get()!;
    const activityEventId = recordActivity(txDb, {
      actorMemberId: actor(context),
      kind: "task_status_changed",
      entityType: "task",
      entityTitle: updated.title,
      taskId: id,
      projectId: updated.projectId,
      metadata: {
        previousStatus: task.status as TaskStatus,
        nextStatus: "actionable",
      },
    });
    neutralizeContribution(txDb, {
      activityEventId,
      reason: "task_completed",
      entityType: "task",
      entityId: id,
    });
    return updated;
  });
}

export function clarifyTask(
  db: Db,
  id: number,
  expectedRevision?: number,
  context?: MutationContext,
) {
  return updateTask(
    db,
    id,
    { status: "actionable", expectedRevision },
    context,
  );
}
