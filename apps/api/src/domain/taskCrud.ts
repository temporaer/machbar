/**
 * Task read helpers and task CRUD: create (including child/successor/
 * sequence variants), update, and delete. Task lifecycle transitions
 * (complete/cancel/reopen/clarify) live in `taskWorkflow.ts`.
 */
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type {
  InheritanceMode,
  TaskSize,
  TaskStatus,
} from "@machbar/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { AppError } from "../errors.js";
import {
  getDescendantIds as repoGetDescendantIds,
  neutralizeContribution,
  neutralizeEntityContributions,
  recordActivity,
  recordContribution,
} from "../repo/index.js";
import { addCalendarDays, isIsoCalendarDate } from "./calendarDate.js";
import { Graph } from "./graph.js";
import { getProjectOrThrow } from "./storyCrud.js";
import {
  MutationContext,
  actor,
  appendNoteContent,
  assertExpectedRevision,
  assertPhysicalContextsExist,
  effectiveOwnerId,
  nowIso,
  projectHasNextAction,
  projectHasTaskPlan,
  sameIds,
  sortedIds,
  touchTask,
} from "./workItemShared.js";

// ---------------------------------------------------------------------------
// Task read helpers
// ---------------------------------------------------------------------------

export function getTaskOrThrow(db: Db, id: number) {
  const task = Graph.load(db).tasksById.get(id);
  if (!task) {
    throw AppError.notFound(
      "task_not_found",
      "The requested task was not found.",
      { taskId: id },
    );
  }
  return task;
}

/** All descendants (any depth, any status) of a task, flattened. */
export function listDescendants(db: Db, rootId: number) {
  const ids = repoGetDescendantIds(db, rootId);
  return ids.map((id) => getTaskOrThrow(db, id));
}

// ---------------------------------------------------------------------------
// Task create / update
// ---------------------------------------------------------------------------

export interface CreateTaskInput {
  projectId?: number | null;
  parentTaskId?: number | null;
  title: string;
  notes?: string;
  status?: TaskStatus;
  needsClarification?: boolean;
  ownerMemberId?: number | null;
  ownerInheritanceMode?: InheritanceMode;
  contextInheritanceMode?: InheritanceMode;
  createdByMemberId?: number | null;
  dueDate?: string | null;
  scheduledDate?: string | null;
  priority?: number | null;
  size?: TaskSize | null;
  repeatAfterDays?: number | null;
  allowedDeviationDays?: number | null;
  reminderAt?: string | null;
  tagIds?: number[];
  contextIds?: number[];
}

function assertRecurrenceNumbers(
  repeatAfterDays: number | null,
  allowedDeviationDays: number | null,
): void {
  if (
    (repeatAfterDays === null) !== (allowedDeviationDays === null) ||
    (repeatAfterDays !== null &&
      (!Number.isInteger(repeatAfterDays) || repeatAfterDays < 1)) ||
    (allowedDeviationDays !== null &&
      (!Number.isInteger(allowedDeviationDays) || allowedDeviationDays < 0))
  ) {
    throw AppError.badRequest(
      "recurrence_configuration_invalid",
      "Recurrence requires a positive repeat interval and a non-negative allowed deviation.",
      { repeatAfterDays, allowedDeviationDays },
    );
  }
}

function recurrenceDates(
  repeatAfterDays: number | null,
  allowedDeviationDays: number | null,
  scheduledDate: string | null,
  suppliedDueDate?: string | null,
): { enabled: boolean; dueDate: string | null } {
  assertRecurrenceNumbers(repeatAfterDays, allowedDeviationDays);
  if (repeatAfterDays === null || allowedDeviationDays === null) {
    return { enabled: false, dueDate: suppliedDueDate ?? null };
  }
  if (scheduledDate === null) {
    throw AppError.badRequest(
      "recurring_task_scheduled_required",
      "A recurring task requires a scheduled date.",
    );
  }
  const dueDate = addCalendarDays(scheduledDate, allowedDeviationDays);
  if (suppliedDueDate !== undefined && suppliedDueDate !== dueDate) {
    throw AppError.badRequest(
      "recurrence_configuration_invalid",
      "A recurring task deadline is derived from its schedule and allowed deviation.",
      { scheduledDate, allowedDeviationDays, expectedDueDate: dueDate },
    );
  }
  return { enabled: true, dueDate };
}

function assertRecurringLeaf(db: Db, taskId: number): void {
  if (repoGetDescendantIds(db, taskId).length > 0) {
    throw AppError.conflict(
      "recurring_task_leaf_required",
      "Only tasks without subtasks can recur.",
      { taskId },
    );
  }
}

export function assertParentAcceptsChildren(db: Db, parentTaskId: number): void {
  const parent = getTaskOrThrow(db, parentTaskId);
  if (parent.repeatAfterDays !== null) {
    throw AppError.conflict(
      "recurring_parent_forbidden",
      "A recurring task cannot contain subtasks.",
      { parentTaskId },
    );
  }
}

function normalizeTaskStatus(
  status: TaskStatus | undefined,
  needsClarification: boolean | undefined,
  fallback: TaskStatus,
): TaskStatus {
  if (status !== undefined && status !== "actionable") return status;
  if (needsClarification === true) return "captured";
  if (status !== undefined || needsClarification === false) return "actionable";
  return fallback;
}

function taskStatusToStored(status: TaskStatus): "captured" | "active" | "backlog" | "done" | "cancelled" {
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

function assertCapturedTaskShape(
  status: TaskStatus,
  input: {
    repeatAfterDays: number | null;
    reminderAt: string | null;
  },
): void {
  if (
    status === "captured" &&
    (input.repeatAfterDays !== null || input.reminderAt !== null)
  ) {
    throw AppError.conflict(
      "task_promotion_invalid",
      "A captured inbox item cannot recur or have a reminder.",
      { reason: "captured_shape_invalid" },
    );
  }
}

export function nextPositionForGroup(
  db: Db,
  parentTaskId: number | null,
  projectId: number | null,
): number {
  // SQLite's `= NULL` never matches, so sibling grouping is filtered in JS
  // rather than expressed as a drizzle `eq()` predicate.
  const parentId = parentTaskId ?? projectId;
  const rows = db
    .select({ position: schema.workItems.position })
    .from(schema.workItems)
    .where(and(eq(schema.workItems.role, "task"), parentId === null ? sql`${schema.workItems.parentId} IS NULL` : eq(schema.workItems.parentId, parentId)))
    .all();
  const filtered = rows;
  return filtered.reduce((max, r) => Math.max(max, r.position), -1) + 1;
}

function insertTask(
  db: Db,
  input: CreateTaskInput,
  positionOverride?: number,
) {
  if (!input.title || input.title.trim() === "") {
    throw AppError.badRequest(
      "task_title_required",
      "The task title must not be empty.",
    );
  }
  let projectId = input.projectId ?? null;
  const parentTaskId = input.parentTaskId ?? null;

  if (parentTaskId !== null) {
    const parent = getTaskOrThrow(db, parentTaskId);
    assertParentAcceptsChildren(db, parentTaskId);
    projectId = parent.projectId;
  } else if (projectId !== null) {
    getProjectOrThrow(db, projectId);
  }

  const position =
    positionOverride ?? nextPositionForGroup(db, parentTaskId, projectId);
  const status = normalizeTaskStatus(
    input.status,
    input.needsClarification,
    projectId === null && parentTaskId === null ? "captured" : "actionable",
  );
  const repeatAfterDays = input.repeatAfterDays ?? null;
  const allowedDeviationDays = input.allowedDeviationDays ?? null;
  const scheduledDate = input.scheduledDate ?? null;
  const recurrence = recurrenceDates(
    repeatAfterDays,
    allowedDeviationDays,
    scheduledDate,
    input.dueDate,
  );
  assertCapturedTaskShape(status, {
    repeatAfterDays,
    reminderAt: input.reminderAt ?? null,
  });
  if (recurrence.enabled && status === "done") {
    throw AppError.badRequest(
      "recurrence_completion_date_required",
      "A recurring task must be completed through a completion transition.",
    );
  }

  const task = db
    .insert(schema.workItems)
    .values({
      role: "task",
      parentId: parentTaskId ?? projectId,
      title: input.title.trim(),
      notes: input.notes ?? "",
      status: taskStatusToStored(status),
      needsClarification: status === "captured",
      ownerMemberId: input.ownerMemberId ?? null,
      ownerInheritanceMode: input.ownerInheritanceMode ?? "inherit",
      physicalContextInheritanceMode: input.contextInheritanceMode ?? "inherit",
      createdByMemberId: input.createdByMemberId ?? null,
      dueDate: recurrence.enabled ? recurrence.dueDate : input.dueDate ?? null,
      scheduledDate,
      priority: input.priority ?? null,
      size: input.size ?? null,
      repeatAfterDays,
      allowedDeviationDays,
      reminderAt: input.reminderAt ?? null,
      position,
    })
    .returning()
    .get();

  if (input.tagIds && input.tagIds.length > 0) {
    for (const tagId of input.tagIds) {
      db.insert(schema.workItemTags).values({ workItemId: task.id, tagId }).run();
    }
  }
  const contextIds = sortedIds(input.contextIds ?? []);
  assertPhysicalContextsExist(db, contextIds);
  for (const contextId of contextIds) {
    db.insert(schema.workItemPhysicalContexts)
      .values({ workItemId: task.id, contextId })
      .run();
  }
  return getTaskOrThrow(db, task.id);
}

export function createTask(
  db: Db,
  input: CreateTaskInput,
  context?: MutationContext,
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const projectId = input.projectId ?? null;
    const hadNextAction =
      projectId !== null ? projectHasNextAction(txDb, projectId) : true;
    const hadTaskPlan =
      projectId !== null ? projectHasTaskPlan(txDb, projectId) : true;
    const task = insertTask(txDb, input);
    const activityEventId = recordActivity(txDb, {
      actorMemberId: actor(context),
      kind: "task_created",
      entityType: "task",
      entityTitle: task.title,
      taskId: task.id,
      projectId: task.projectId,
      metadata: {},
    });
    if (
      task.projectId !== null &&
      !hadNextAction &&
      projectHasNextAction(txDb, task.projectId)
    ) {
      recordContribution(txDb, {
        activityEventId,
        actorMemberId: actor(context),
        category: "planning",
        reason: "project_next_action_added",
        entityType: "project",
        entityId: task.projectId,
        personalEligible: true,
      });
    } else if (
      task.projectId !== null &&
      !hadTaskPlan &&
      projectHasTaskPlan(txDb, task.projectId)
    ) {
      recordContribution(txDb, {
        activityEventId,
        actorMemberId: actor(context),
        category: "planning",
        reason: "project_due_plan_added",
        entityType: "project",
        entityId: task.projectId,
        personalEligible: true,
      });
    }
    return task;
  });
}

export function createChildTask(
  db: Db,
  parentTaskId: number,
  input: Omit<CreateTaskInput, "parentTaskId" | "projectId">,
  context?: MutationContext,
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const parent = getTaskOrThrow(txDb, parentTaskId);
    if (parent.status === "captured") {
      throw AppError.conflict(
        "task_promotion_invalid",
        "Promote the captured item to a project before adding steps.",
        { taskId: parentTaskId, reason: "captured_child_forbidden" },
      );
    }
    assertParentAcceptsChildren(txDb, parentTaskId);
    const hadNextAction =
      parent.projectId === null
        ? true
        : projectHasNextAction(txDb, parent.projectId);
    const hadTaskPlan =
      parent.projectId === null
        ? true
        : projectHasTaskPlan(txDb, parent.projectId);
    const hadOpenChild = txDb
      .select({ status: schema.workItems.status })
      .from(schema.workItems)
      .where(and(eq(schema.workItems.role, "task"), eq(schema.workItems.parentId, parentTaskId)))
      .all()
      .some((child) => child.status !== "done" && child.status !== "cancelled");
    const task = insertTask(txDb, { ...input, parentTaskId });
    const activityEventId = recordActivity(txDb, {
      actorMemberId: actor(context),
      kind: "task_created",
      entityType: "task",
      entityTitle: task.title,
      taskId: task.id,
      projectId: task.projectId,
      metadata: {},
    });
    if (
      parent.size === "XL" &&
      !hadOpenChild &&
      task.status !== "done" &&
      task.status !== "cancelled"
    ) {
      recordContribution(txDb, {
        activityEventId,
        actorMemberId: actor(context),
        category: "planning",
        reason: "task_broken_down",
        entityType: "task",
        entityId: parentTaskId,
        personalEligible: true,
      });
    } else if (
      task.projectId !== null &&
      !hadNextAction &&
      projectHasNextAction(txDb, task.projectId)
    ) {
      recordContribution(txDb, {
        activityEventId,
        actorMemberId: actor(context),
        category: "planning",
        reason: "project_next_action_added",
        entityType: "project",
        entityId: task.projectId,
        personalEligible: true,
      });
    } else if (
      task.projectId !== null &&
      !hadTaskPlan &&
      projectHasTaskPlan(txDb, task.projectId)
    ) {
      recordContribution(txDb, {
        activityEventId,
        actorMemberId: actor(context),
        category: "planning",
        reason: "project_due_plan_added",
        entityType: "project",
        entityId: task.projectId,
        personalEligible: true,
      });
    }
    return task;
  });
}

/** Creates one sibling immediately downstream of an existing task. */
export function createTaskSuccessor(
  db: Db,
  taskId: number,
  input: Omit<CreateTaskInput, "parentTaskId" | "projectId">,
  context?: MutationContext,
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const predecessor = getTaskOrThrow(txDb, taskId);
    const hadNextAction =
      predecessor.projectId === null
        ? true
        : projectHasNextAction(txDb, predecessor.projectId);
    const hadTaskPlan =
      predecessor.projectId === null
        ? true
        : projectHasTaskPlan(txDb, predecessor.projectId);
    const successorPosition = predecessor.position + 1;
    const laterSiblings = tx
      .select()
      .from(schema.workItems)
      .all()
      .filter(
        (task) =>
          task.role === "task" &&
          task.parentId === (predecessor.parentTaskId ?? predecessor.projectId) &&
          task.position >= successorPosition,
      );
    for (const sibling of laterSiblings) {
      tx
        .update(schema.workItems)
        .set({
          position: sibling.position + 1,
          revision: sql`${schema.workItems.revision} + 1`,
          updatedAt: nowIso(),
        })
        .where(eq(schema.workItems.id, sibling.id))
        .run();
    }
    const successor = insertTask(txDb, {
      ...input,
      status: input.status ?? "actionable",
      projectId: predecessor.projectId,
      parentTaskId: predecessor.parentTaskId,
    }, successorPosition);
    tx
      .insert(schema.taskDependencies)
      .values({ taskId: successor.id, dependsOnTaskId: predecessor.id })
      .run();
    const activityEventId = recordActivity(txDb, {
      actorMemberId: actor(context),
      kind: "task_created",
      entityType: "task",
      entityTitle: successor.title,
      taskId: successor.id,
      projectId: successor.projectId,
      metadata: {
        relatedTaskIds: [predecessor.id],
        relatedTaskTitles: [predecessor.title],
      },
    });
    if (
      successor.projectId !== null &&
      !hadNextAction &&
      projectHasNextAction(txDb, successor.projectId)
    ) {
      recordContribution(txDb, {
        activityEventId,
        actorMemberId: actor(context),
        category: "planning",
        reason: "project_next_action_added",
        entityType: "project",
        entityId: successor.projectId,
        personalEligible: true,
      });
    } else if (
      successor.projectId !== null &&
      !hadTaskPlan &&
      projectHasTaskPlan(txDb, successor.projectId)
    ) {
      recordContribution(txDb, {
        activityEventId,
        actorMemberId: actor(context),
        category: "planning",
        reason: "project_due_plan_added",
        entityType: "project",
        entityId: successor.projectId,
        personalEligible: true,
      });
    }
    return successor;
  });
}

export interface UpdateTaskInput {
  title?: string;
  notes?: string;
  status?: TaskStatus;
  needsClarification?: boolean;
  ownerMemberId?: number | null;
  ownerInheritanceMode?: InheritanceMode;
  contextInheritanceMode?: InheritanceMode;
  dueDate?: string | null;
  scheduledDate?: string | null;
  priority?: number | null;
  size?: TaskSize | null;
  repeatAfterDays?: number | null;
  allowedDeviationDays?: number | null;
  completedOn?: string;
  reminderAt?: string | null;
  additionalNextAction?: boolean;
  tagIds?: number[];
  excludedTagIds?: number[];
  contextIds?: number[];
  expectedRevision?: number;
}

export function updateTask(
  db: Db,
  id: number,
  input: UpdateTaskInput,
  context?: MutationContext,
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const currentTask = getTaskOrThrow(txDb, id);
    const currentExternalWait = tx
      .select()
      .from(schema.taskExternalWaits)
      .where(eq(schema.taskExternalWaits.taskId, id))
      .get();
    assertExpectedRevision("task", id, currentTask.revision, input.expectedRevision);
    const effectiveOwnerBefore = effectiveOwnerId(txDb, id);
    const projectHadNextAction =
      currentTask.projectId !== null
        ? projectHasNextAction(txDb, currentTask.projectId)
        : true;
    const projectHadTaskPlan =
      currentTask.projectId !== null
        ? projectHasTaskPlan(txDb, currentTask.projectId)
        : true;
    if (input.title !== undefined && input.title.trim() === "") {
      throw AppError.badRequest(
        "task_title_required",
        "The task title must not be empty.",
        { taskId: id },
      );
    }
    const patch: Partial<typeof schema.workItems.$inferInsert> = {};
    const changedFields: string[] = [];
    const title = input.title?.trim();
    if (title !== undefined && title !== currentTask.title) {
      patch.title = title;
      changedFields.push("title");
    }
    if (input.notes !== undefined && input.notes !== currentTask.notes) {
      patch.notes = input.notes;
      changedFields.push("notes");
    }
    const nextStatus =
      input.status !== undefined
        ? normalizeTaskStatus(
            input.status,
            input.needsClarification,
            "actionable",
          )
        : input.needsClarification === true
          ? "captured"
          : input.needsClarification === false && currentTask.status === "captured"
            ? "actionable"
            : undefined;
    const nextRepeatAfterDays =
      input.repeatAfterDays !== undefined
        ? input.repeatAfterDays
        : currentTask.repeatAfterDays;
    const nextAllowedDeviationDays =
      input.allowedDeviationDays !== undefined
        ? input.allowedDeviationDays
        : currentTask.allowedDeviationDays;
    const nextScheduledDate =
      input.scheduledDate !== undefined
        ? input.scheduledDate
        : currentTask.scheduledDate;
    if ((nextStatus ?? currentTask.status) === "captured") {
      assertCapturedTaskShape("captured", {
        repeatAfterDays: nextRepeatAfterDays,
        reminderAt:
          input.reminderAt !== undefined
            ? input.reminderAt
            : currentTask.reminderAt,
      });
      const hasDependency = tx
        .select({ id: schema.taskDependencies.id })
        .from(schema.taskDependencies)
        .where(
        or(
          eq(schema.taskDependencies.taskId, id),
          eq(schema.taskDependencies.dependsOnTaskId, id),
        ),
        )
        .get();
      if (currentExternalWait || hasDependency) {
        throw AppError.conflict(
        "task_promotion_invalid",
        "A captured inbox item cannot have waits, dependencies, or reminders.",
        { taskId: id, reason: "captured_task_only_relations" },
        );
      }
    }
    const recurrence = recurrenceDates(
      nextRepeatAfterDays,
      nextAllowedDeviationDays,
      nextScheduledDate,
      input.dueDate,
    );
    if (currentExternalWait && nextRepeatAfterDays !== null) {
      throw AppError.conflict(
        "external_wait_recurring_forbidden",
        "Resolve the external wait before enabling recurrence.",
        { taskId: id },
      );
    }
    const recurringCompletion =
      nextStatus === "done" && recurrence.enabled;
    if (recurrence.enabled && currentTask.repeatAfterDays === null) {
      assertRecurringLeaf(txDb, id);
    }
    if (recurringCompletion) {
      assertRecurringLeaf(txDb, id);
      if (!input.completedOn || !isIsoCalendarDate(input.completedOn)) {
        throw AppError.badRequest(
          "recurrence_completion_date_required",
          "Recurring completion requires the browser-local completion date.",
          { taskId: id },
        );
      }
      if (input.expectedRevision === undefined) {
        throw AppError.badRequest(
          "recurrence_completion_revision_required",
          "Recurring completion requires the task revision.",
          { taskId: id },
        );
      }
    }
    const statusChanged =
      nextStatus !== undefined && nextStatus !== currentTask.status;
    const removingExternalWait =
      statusChanged &&
      nextStatus !== "actionable" &&
      currentExternalWait !== undefined;
    if (statusChanged && !recurringCompletion) {
      patch.status = taskStatusToStored(nextStatus);
      patch.needsClarification = nextStatus === "captured";
      patch.completedAt = nextStatus === "done" ? nowIso() : null;
      patch.cancelledAt = nextStatus === "cancelled" ? nowIso() : null;
      if (removingExternalWait) {
        changedFields.push("externalWait");
      }
    }
    if (
      input.ownerMemberId !== undefined &&
      input.ownerMemberId !== currentTask.ownerMemberId
    ) {
      changedFields.push("ownerMemberId");
      patch.ownerMemberId = input.ownerMemberId;
    }
    if (
      input.ownerInheritanceMode !== undefined &&
      input.ownerInheritanceMode !== currentTask.ownerInheritanceMode
    ) {
      changedFields.push("ownerInheritanceMode");
      patch.ownerInheritanceMode = input.ownerInheritanceMode;
    }
    if (
      input.contextInheritanceMode !== undefined &&
      input.contextInheritanceMode !== currentTask.contextInheritanceMode
    ) {
      changedFields.push("contextInheritanceMode");
      patch.physicalContextInheritanceMode = input.contextInheritanceMode;
    }
    if (recurrence.enabled) {
      if (recurrence.dueDate !== currentTask.dueDate) {
        patch.dueDate = recurrence.dueDate;
        changedFields.push("dueDate");
      }
    } else if (
      input.dueDate !== undefined &&
      input.dueDate !== currentTask.dueDate
    ) {
      patch.dueDate = input.dueDate;
      changedFields.push("dueDate");
    }
    if (
      input.scheduledDate !== undefined &&
      input.scheduledDate !== currentTask.scheduledDate
    ) {
      patch.scheduledDate = input.scheduledDate;
      changedFields.push("scheduledDate");
    }
    for (const field of [
      "priority",
      "size",
      "reminderAt",
      "additionalNextAction",
    ] as const) {
      if (input[field] !== undefined && input[field] !== currentTask[field]) {
        patch[field] = input[field] as never;
        changedFields.push(field);
      }
    }
    if (
      input.repeatAfterDays !== undefined &&
      input.repeatAfterDays !== currentTask.repeatAfterDays
    ) {
      patch.repeatAfterDays = input.repeatAfterDays;
      changedFields.push("repeatAfterDays");
    }
    if (
      input.allowedDeviationDays !== undefined &&
      input.allowedDeviationDays !== currentTask.allowedDeviationDays
    ) {
      patch.allowedDeviationDays = input.allowedDeviationDays;
      changedFields.push("allowedDeviationDays");
    }
    let occurrence:
      | typeof schema.taskRecurrenceOccurrences.$inferSelect
      | null = null;
    if (recurringCompletion) {
      const completedOn = input.completedOn!;
      const scheduledDate = nextScheduledDate!;
      const deadlineDate = recurrence.dueDate!;
      const result = completedOn <= deadlineDate ? "hit" : "miss";
      occurrence = tx
        .insert(schema.taskRecurrenceOccurrences)
        .values({
          taskId: id,
          scheduledDate,
          deadlineDate,
          completedOn,
          completedAt: nowIso(),
          result,
        })
        .returning()
        .get();
      const followingScheduledDate = addCalendarDays(
        completedOn,
        nextRepeatAfterDays!,
      );
      patch.status = "active";
      patch.needsClarification = false;
      patch.completedAt = null;
      patch.cancelledAt = null;
      patch.scheduledDate = followingScheduledDate;
      patch.dueDate = addCalendarDays(
        followingScheduledDate,
        nextAllowedDeviationDays!,
      );
    }

    const existingTagIds = sortedIds(
      tx.select({ tagId: schema.workItemTags.tagId })
        .from(schema.workItemTags)
        .where(eq(schema.workItemTags.workItemId, id))
        .all()
        .map((row) => row.tagId),
    );
    const nextTagIds =
      input.tagIds === undefined ? existingTagIds : sortedIds(input.tagIds);
    const tagsChanged = !sameIds(existingTagIds, nextTagIds);
    const existingExcludedTagIds = sortedIds(
      tx.select({ tagId: schema.taskExcludedTags.tagId })
        .from(schema.taskExcludedTags)
        .where(eq(schema.taskExcludedTags.taskId, id))
        .all()
        .map((row) => row.tagId),
    );
    const nextExcludedTagIds =
      input.excludedTagIds === undefined
        ? existingExcludedTagIds
        : sortedIds(input.excludedTagIds);
    const excludedTagsChanged = !sameIds(
      existingExcludedTagIds,
      nextExcludedTagIds,
    );
    const existingContextIds = sortedIds(
      tx
        .select({ contextId: schema.workItemPhysicalContexts.contextId })
        .from(schema.workItemPhysicalContexts)
        .where(eq(schema.workItemPhysicalContexts.workItemId, id))
        .all()
        .map((row) => row.contextId),
    );
    const nextContextIds =
      input.contextIds === undefined
        ? existingContextIds
        : sortedIds(input.contextIds);
    assertPhysicalContextsExist(txDb, nextContextIds);
    const contextsChanged = !sameIds(existingContextIds, nextContextIds);

    if (Object.keys(patch).length > 0) {
      patch.updatedAt = nowIso();
      tx.update(schema.workItems).set(patch).where(eq(schema.workItems.id, id)).run();
    }
    if (removingExternalWait) {
      tx.delete(schema.taskExternalWaits)
        .where(eq(schema.taskExternalWaits.taskId, id))
        .run();
    }

    if (tagsChanged) {
      tx.delete(schema.workItemTags).where(eq(schema.workItemTags.workItemId, id)).run();
      for (const tagId of nextTagIds) {
        tx.insert(schema.workItemTags).values({ workItemId: id, tagId }).run();
      }
    }
    if (excludedTagsChanged) {
      tx.delete(schema.taskExcludedTags)
        .where(eq(schema.taskExcludedTags.taskId, id))
        .run();
      for (const tagId of nextExcludedTagIds) {
        tx.insert(schema.taskExcludedTags).values({ taskId: id, tagId }).run();
      }
    }
    if (contextsChanged) {
      tx.delete(schema.workItemPhysicalContexts)
        .where(eq(schema.workItemPhysicalContexts.workItemId, id))
        .run();
      for (const contextId of nextContextIds) {
        tx.insert(schema.workItemPhysicalContexts)
          .values({ workItemId: id, contextId })
          .run();
      }
    }
    if (
      Object.keys(patch).length > 0 ||
      tagsChanged ||
      excludedTagsChanged ||
      contextsChanged
    ) {
      touchTask(txDb, id);
    }
    const updated = getTaskOrThrow(txDb, id);
    const coalescedChangedFields = [
      ...changedFields,
      ...(tagsChanged ? ["tags"] : []),
      ...(excludedTagsChanged ? ["excludedTags"] : []),
      ...(contextsChanged ? ["contexts"] : []),
    ];
    if (recurringCompletion && occurrence) {
      const updatedScheduledDate = updated.scheduledDate!;
      const updatedDueDate = updated.dueDate!;
      const activityEventId = recordActivity(txDb, {
        actorMemberId: actor(context),
        kind: "task_status_changed",
        entityType: "task",
        entityTitle: updated.title,
        taskId: id,
        projectId: updated.projectId,
        metadata: {
          previousStatus: currentTask.status as TaskStatus,
          nextStatus: "actionable",
          recurrenceOccurrenceId: occurrence.id,
          recurrenceResult: occurrence.result,
          occurrenceScheduledDate: occurrence.scheduledDate,
          occurrenceDeadlineDate: occurrence.deadlineDate,
          occurrenceCompletedOn: occurrence.completedOn,
          nextScheduledDate: updatedScheduledDate,
          nextDeadlineDate: updatedDueDate,
          ...(coalescedChangedFields.length > 0
            ? { changedFields: coalescedChangedFields }
            : {}),
        },
      });
      recordContribution(txDb, {
        activityEventId,
        actorMemberId: actor(context),
        category: "completion",
        reason: "task_completed",
        entityType: "task_occurrence",
        entityId: occurrence.id,
        personalEligible:
          effectiveOwnerBefore === null ||
          effectiveOwnerBefore === actor(context),
      });
      if (occurrence.result === "miss") {
        recordContribution(txDb, {
          activityEventId,
          actorMemberId: effectiveOwnerBefore,
          category: "completion",
          reason: "recurrence_missed",
          entityType: "task_occurrence",
          entityId: occurrence.id,
          personalEligible: effectiveOwnerBefore !== null,
        });
      }
    } else if (statusChanged) {
      const activityEventId = recordActivity(txDb, {
        actorMemberId: actor(context),
        kind: "task_status_changed",
        entityType: "task",
        entityTitle: updated.title,
        taskId: id,
        projectId: updated.projectId,
        metadata: {
          previousStatus: currentTask.status as TaskStatus,
          nextStatus: updated.status as TaskStatus,
          ...(coalescedChangedFields.length > 0
            ? { changedFields: coalescedChangedFields }
            : {}),
        },
      });
      if (updated.status === "done") {
        recordContribution(txDb, {
          activityEventId,
          actorMemberId: actor(context),
          category: "completion",
          reason: "task_completed",
          entityType: "task",
          entityId: id,
          personalEligible:
            effectiveOwnerBefore === null ||
            effectiveOwnerBefore === actor(context),
        });
      } else if (currentTask.status === "done") {
        neutralizeContribution(txDb, {
          activityEventId,
          reason: "task_completed",
          entityType: "task",
          entityId: id,
        });
      } else if (
        currentTask.status === "captured" &&
        updated.status === "actionable"
      ) {
        recordContribution(txDb, {
          activityEventId,
          actorMemberId: actor(context),
          category: "planning",
          reason: "task_clarified",
          entityType: "task",
          entityId: id,
          personalEligible: true,
        });
      } else if (
        currentTask.status === "actionable" &&
        updated.status === "captured"
      ) {
        neutralizeContribution(txDb, {
          activityEventId,
          reason: "task_clarified",
          entityType: "task",
          entityId: id,
        });
      }
      if (updated.projectId !== null && updated.status !== "done") {
        if (
          projectHadNextAction &&
          !projectHasNextAction(txDb, updated.projectId)
        ) {
          neutralizeContribution(txDb, {
            activityEventId,
            reason: "project_next_action_added",
            entityType: "project",
            entityId: updated.projectId,
          });
        }
        if (
          projectHadTaskPlan &&
          !projectHasTaskPlan(txDb, updated.projectId)
        ) {
          neutralizeContribution(txDb, {
            activityEventId,
            reason: "project_due_plan_added",
            entityType: "project",
            entityId: updated.projectId,
          });
        }
      }
    } else if (changedFields.length > 0) {
      const activityEventId = recordActivity(txDb, {
        actorMemberId: actor(context),
        kind: "task_updated",
        entityType: "task",
        entityTitle: updated.title,
        taskId: id,
        projectId: updated.projectId,
        metadata: { changedFields: coalescedChangedFields },
      });
      const effectiveOwnerAfter = effectiveOwnerId(txDb, id);
      if (
        effectiveOwnerBefore === null &&
        effectiveOwnerAfter !== null &&
        updated.status === "actionable"
      ) {
        recordContribution(txDb, {
          activityEventId,
          actorMemberId: actor(context),
          category: "planning",
          reason: "task_assigned",
          entityType: "task",
          entityId: id,
          personalEligible: true,
        });
      } else if (
        currentTask.size === null &&
        updated.size !== null &&
        updated.status !== "done" &&
        updated.status !== "cancelled"
      ) {
        recordContribution(txDb, {
          activityEventId,
          actorMemberId: actor(context),
          category: "planning",
          reason: "task_estimated",
          entityType: "task",
          entityId: id,
          personalEligible: true,
        });
      } else if (
        currentTask.dueDate === null &&
        currentTask.scheduledDate === null &&
        (updated.dueDate !== null || updated.scheduledDate !== null) &&
        updated.status !== "done" &&
        updated.status !== "cancelled"
      ) {
        recordContribution(txDb, {
          activityEventId,
          actorMemberId: actor(context),
          category: "planning",
          reason: "task_planned",
          entityType: "task",
          entityId: id,
          personalEligible: true,
        });
      } else if (
        updated.projectId !== null &&
        !projectHadNextAction &&
        projectHasNextAction(txDb, updated.projectId)
      ) {
        recordContribution(txDb, {
          activityEventId,
          actorMemberId: actor(context),
          category: "planning",
          reason: "project_next_action_added",
          entityType: "project",
          entityId: updated.projectId,
          personalEligible: true,
        });
      } else if (
        updated.projectId !== null &&
        !projectHadTaskPlan &&
        projectHasTaskPlan(txDb, updated.projectId)
      ) {
        recordContribution(txDb, {
          activityEventId,
          actorMemberId: actor(context),
          category: "planning",
          reason: "project_due_plan_added",
          entityType: "project",
          entityId: updated.projectId,
          personalEligible: true,
        });
      }

      if (effectiveOwnerBefore !== null && effectiveOwnerAfter === null) {
        neutralizeContribution(txDb, {
          activityEventId,
          reason: "task_assigned",
          entityType: "task",
          entityId: id,
        });
      }
      if (currentTask.size !== null && updated.size === null) {
        neutralizeContribution(txDb, {
          activityEventId,
          reason: "task_estimated",
          entityType: "task",
          entityId: id,
        });
      }
      if (
        (currentTask.dueDate !== null ||
          currentTask.scheduledDate !== null) &&
        updated.dueDate === null &&
        updated.scheduledDate === null
      ) {
        neutralizeContribution(txDb, {
          activityEventId,
          reason: "task_planned",
          entityType: "task",
          entityId: id,
        });
      }
      if (updated.projectId !== null) {
        if (
          projectHadNextAction &&
          !projectHasNextAction(txDb, updated.projectId)
        ) {
          neutralizeContribution(txDb, {
            activityEventId,
            reason: "project_next_action_added",
            entityType: "project",
            entityId: updated.projectId,
          });
        }
        if (
          projectHadTaskPlan &&
          !projectHasTaskPlan(txDb, updated.projectId)
        ) {
          neutralizeContribution(txDb, {
            activityEventId,
            reason: "project_due_plan_added",
            entityType: "project",
            entityId: updated.projectId,
          });
        }
      }
    } else if (tagsChanged || excludedTagsChanged || contextsChanged) {
      recordActivity(txDb, {
        actorMemberId: actor(context),
        kind: contextsChanged ? "task_contexts_changed" : "task_tags_changed",
        entityType: "task",
        entityTitle: updated.title,
        taskId: id,
        projectId: updated.projectId,
        metadata: {},
      });
    }
    return updated;
  });
}

export function appendTaskNotes(
  db: Db,
  id: number,
  content: string,
  context?: MutationContext,
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const task = getTaskOrThrow(txDb, id);
    const notes = appendNoteContent(task.notes, content);
    if (notes === task.notes) return task;
    const updated = tx
      .update(schema.workItems)
      .set({
        notes,
        revision: sql`${schema.workItems.revision} + 1`,
        updatedAt: nowIso(),
      })
      .where(eq(schema.workItems.id, id))
      .returning()
      .get();
    const returned = getTaskOrThrow(txDb, id);
    recordActivity(txDb, {
      actorMemberId: actor(context),
      kind: "task_updated",
      entityType: "task",
      entityTitle: returned.title,
      taskId: id,
      projectId: returned.projectId,
      metadata: { changedFields: ["notesAppended"] },
    });
    return returned;
  });
}

export function deleteTask(db: Db, id: number, context?: MutationContext) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const task = getTaskOrThrow(txDb, id);
    const descendantIds = repoGetDescendantIds(txDb, id);
    const affectedCount = descendantIds.length + 1;
    const projectHadNextAction =
      task.projectId === null ? true : projectHasNextAction(txDb, task.projectId);
    const projectHadTaskPlan =
      task.projectId === null ? true : projectHasTaskPlan(txDb, task.projectId);
    const parent =
      task.parentTaskId === null
        ? null
        : getTaskOrThrow(txDb, task.parentTaskId);
    const recurrenceOccurrenceIds = txDb
      .select({ id: schema.taskRecurrenceOccurrences.id })
      .from(schema.taskRecurrenceOccurrences)
      .where(
        inArray(
          schema.taskRecurrenceOccurrences.taskId,
          [id, ...descendantIds],
        ),
      )
      .all()
      .map((row) => row.id);
    // Deleting the task cascades to descendants via parentTaskId, but that
    // internal cascade does not clean up each descendant's own shared
    // work_items row, so retire the whole subtree's ids explicitly here
    // (deleting each work_items row also cascades to its tasks row).
    tx.delete(schema.workItems)
      .where(inArray(schema.workItems.id, [id, ...descendantIds]))
      .run();
    const activityEventId = recordActivity(txDb, {
      actorMemberId: actor(context),
      kind: "task_deleted",
      entityType: "task",
      entityTitle: task.title,
      projectId: task.projectId,
      metadata: affectedCount > 1 ? { affectedCount } : {},
    });
    for (const taskId of [id, ...descendantIds]) {
      neutralizeEntityContributions(txDb, {
        activityEventId,
        entityType: "task",
        entityId: taskId,
      });
    }
    for (const occurrenceId of recurrenceOccurrenceIds) {
      neutralizeEntityContributions(txDb, {
        activityEventId,
        entityType: "task_occurrence",
        entityId: occurrenceId,
      });
    }
    if (
      parent?.size === "XL" &&
      !txDb
        .select({ id: schema.workItems.id })
        .from(schema.workItems)
        .where(and(eq(schema.workItems.role, "task"), eq(schema.workItems.parentId, parent.id)))
        .get()
    ) {
      neutralizeContribution(txDb, {
        activityEventId,
        reason: "task_broken_down",
        entityType: "task",
        entityId: parent.id,
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
  });
}
