/**
 * Identity-preserving task <-> story role conversion on the unified
 * `work_items` table. Conversion now updates a row's `role` in place instead
 * of copying between task/project tables, so ids, links, tags, contexts,
 * notifications, and activity history stay attached to the same row.
 */
import { and, eq, or, sql } from "drizzle-orm";
import type { TaskStatus } from "@machbar/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { AppError } from "../errors.js";
import {
  getDescendantIds as repoGetDescendantIds,
  recordActivity,
  recordContribution,
} from "../repo/index.js";
import { getProjectOrThrow } from "./storyCrud.js";
import { getTaskOrThrow, nextPositionForGroup } from "./taskCrud.js";
import {
  MutationContext,
  actor,
  assertExpectedRevision,
  assertProjectActivationReady,
  enqueueProjectAssignment,
  nowIso,
} from "./workItemShared.js";

export interface ConvertTaskToStoryInput {
  status: "active" | "backlog";
  title?: string;
  notes?: string;
  expectedRevision?: number;
}

type TaskToStoryInvalidReason =
  | "not_root"
  | "inside_story"
  | "unsupported_status"
  | "task_only_relations";

function taskStatusToStored(
  status: TaskStatus,
): "captured" | "active" | "backlog" | "done" | "cancelled" {
  switch (status) {
    case "actionable":
      return "active";
    case "someday":
      return "backlog";
    case "captured":
    case "done":
    case "cancelled":
      return status;
  }
}

export function convertTaskToStory(
  db: Db,
  taskId: number,
  input: ConvertTaskToStoryInput,
  context?: MutationContext,
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const task = getTaskOrThrow(txDb, taskId);
    assertExpectedRevision("task", taskId, task.revision, input.expectedRevision);
    const reject = (
      reason: TaskToStoryInvalidReason,
      message: string,
      details: Record<string, unknown> = {},
    ) => {
      throw AppError.conflict(
        "role_conversion_invalid",
        message,
        { taskId, reason, ...details },
      );
    };
    if (task.parentTaskId !== null) {
      reject(
        "not_root",
        "Only a root-level standalone task can be converted to a story.",
      );
    }
    if (task.projectId !== null) {
      reject(
        "inside_story",
        "A task inside a story cannot be converted independently.",
        { projectId: task.projectId },
      );
    }
    if (!["captured", "actionable", "someday"].includes(task.status)) {
      reject(
        "unsupported_status",
        "Only open captured, actionable, or someday tasks can be converted to a story.",
        { status: task.status },
      );
    }
    const title = input.title?.trim() ?? task.title;
    if (title === "") {
      throw AppError.badRequest(
        "project_title_required",
        "The project title must not be empty.",
        { taskId },
      );
    }
    const hasTaskOnlyRelation =
      tx
        .select({ taskId: schema.taskExternalWaits.taskId })
        .from(schema.taskExternalWaits)
        .where(eq(schema.taskExternalWaits.taskId, taskId))
        .get() !== undefined ||
      tx
        .select({ id: schema.taskDependencies.id })
        .from(schema.taskDependencies)
        .where(
          or(
            eq(schema.taskDependencies.taskId, taskId),
            eq(schema.taskDependencies.dependsOnTaskId, taskId),
          ),
        )
        .get() !== undefined ||
      tx
        .select({ id: schema.taskRecurrenceOccurrences.id })
        .from(schema.taskRecurrenceOccurrences)
        .where(eq(schema.taskRecurrenceOccurrences.taskId, taskId))
        .get() !== undefined ||
      task.repeatAfterDays !== null ||
      task.allowedDeviationDays !== null ||
      task.reminderAt !== null;
    if (hasTaskOnlyRelation) {
      reject(
        "task_only_relations",
        "Resolve task-only waits, dependencies, recurrence, and reminders before converting this task to a story.",
      );
    }

    const ownerMemberId =
      task.ownerInheritanceMode === "explicit" ? task.ownerMemberId : null;

    tx.update(schema.workItems)
      .set({
        role: "story",
        parentId: null,
        title,
        notes: input.notes ?? task.notes,
        status: input.status,
        archivedAt: null,
        needsClarification: false,
        ownerMemberId,
        priority: null,
        size: null,
        completedAt: null,
        cancelledAt: null,
        recurrenceRuleLegacy: null,
        repeatAfterDays: null,
        allowedDeviationDays: null,
        reminderAt: null,
        revision: sql`${schema.workItems.revision} + 1`,
        updatedAt: nowIso(),
      })
      .where(eq(schema.workItems.id, taskId))
      .run();

    const project = getProjectOrThrow(txDb, taskId);
    if (input.status === "active") {
      assertProjectActivationReady(txDb, project.id, ownerMemberId);
    }
    tx.update(schema.activityEvents)
      .set({ entityType: "project" })
      .where(
        and(
          eq(schema.activityEvents.entityType, "task"),
          eq(schema.activityEvents.entityId, taskId),
        ),
      )
      .run();
    tx.update(schema.notificationEvents)
      .set({ entityType: "project" })
      .where(
        and(
          eq(schema.notificationEvents.entityType, "task"),
          eq(schema.notificationEvents.entityId, taskId),
        ),
      )
      .run();
    tx.update(schema.contributionEvents)
      .set({ entityType: "project" })
      .where(
        and(
          eq(schema.contributionEvents.entityType, "task"),
          eq(schema.contributionEvents.entityId, taskId),
        ),
      )
      .run();

    const activityEventId = recordActivity(txDb, {
      actorMemberId: actor(context),
      kind: "work_item_role_converted",
      entityType: "project",
      entityTitle: project.title,
      projectId: project.id,
      metadata: { changedFields: ["role"] },
    });
    recordContribution(txDb, {
      activityEventId,
      actorMemberId: actor(context),
      category: "planning",
      reason: "project_outcome_added",
      entityType: "project",
      entityId: project.id,
      personalEligible: true,
    });
    enqueueProjectAssignment(txDb, project, activityEventId, context);
    return project;
  });
}

export interface ConvertStoryToTaskInput {
  title?: string;
  notes?: string;
  expectedRevision?: number;
}

export function convertStoryToTask(
  db: Db,
  projectId: number,
  input: ConvertStoryToTaskInput,
  context?: MutationContext,
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const project = getProjectOrThrow(txDb, projectId);
    assertExpectedRevision(
      "project",
      projectId,
      project.revision,
      input.expectedRevision,
    );
    const hasChild = repoGetDescendantIds(txDb, projectId).length > 0;
    if (hasChild) {
      throw AppError.conflict(
        "role_conversion_invalid",
        "A story with tasks cannot be converted back to a single task.",
        { projectId, reason: "has_children" },
      );
    }
    const hasAcceptanceCriterion = tx
      .select({ id: schema.workItemAcceptanceCriteria.id })
      .from(schema.workItemAcceptanceCriteria)
      .where(eq(schema.workItemAcceptanceCriteria.workItemId, projectId))
      .get();
    if (hasAcceptanceCriterion) {
      throw AppError.conflict(
        "role_conversion_invalid",
        "A story with acceptance criteria cannot be converted back to a single task.",
        { projectId, reason: "has_acceptance_criteria" },
      );
    }
    const title = input.title?.trim() ?? project.title;
    if (title === "") {
      throw AppError.badRequest(
        "task_title_required",
        "The task title must not be empty.",
      );
    }
    const status: TaskStatus =
      project.status === "active"
        ? "actionable"
        : project.status === "completed"
          ? "done"
          : "someday";
    const position = nextPositionForGroup(txDb, null, null);

    tx.update(schema.workItems)
      .set({
        role: "task",
        parentId: null,
        title,
        notes: input.notes ?? project.notes,
        status: taskStatusToStored(status),
        archivedAt: null,
        needsClarification: false,
        ownerMemberId: project.ownerMemberId,
        ownerInheritanceMode: project.ownerMemberId !== null ? "explicit" : "none",
        position,
        completedAt: status === "done" ? project.updatedAt : null,
        revision: sql`${schema.workItems.revision} + 1`,
        updatedAt: nowIso(),
      })
      .where(eq(schema.workItems.id, projectId))
      .run();

    tx.update(schema.activityEvents)
      .set({ entityType: "task" })
      .where(
        and(
          eq(schema.activityEvents.entityType, "project"),
          eq(schema.activityEvents.entityId, projectId),
        ),
      )
      .run();
    tx.update(schema.notificationEvents)
      .set({ entityType: "task" })
      .where(
        and(
          eq(schema.notificationEvents.entityType, "project"),
          eq(schema.notificationEvents.entityId, projectId),
        ),
      )
      .run();
    tx.update(schema.contributionEvents)
      .set({ entityType: "task" })
      .where(
        and(
          eq(schema.contributionEvents.entityType, "project"),
          eq(schema.contributionEvents.entityId, projectId),
        ),
      )
      .run();

    const task = getTaskOrThrow(txDb, projectId);
    recordActivity(txDb, {
      actorMemberId: actor(context),
      kind: "work_item_role_converted",
      entityType: "task",
      entityTitle: task.title,
      taskId: task.id,
      metadata: { changedFields: ["role"] },
    });
    return task;
  });
}
