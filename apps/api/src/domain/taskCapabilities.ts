/**
 * Task-only capabilities: external waits (waiting-for/revisit + follow-up),
 * dependencies, and per-task tag/excluded-tag overrides.
 */
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { AppError } from "../errors.js";
import {
  neutralizeContribution,
  recordActivity,
  recordContribution,
  wouldCreateDependencyCycle,
} from "../repo/index.js";
import { getTaskOrThrow } from "./taskCrud.js";
import {
  MutationContext,
  actor,
  appendNoteContent,
  assertExpectedRevision,
  nowIso,
  projectHasNextAction,
  touchTask,
} from "./workItemShared.js";

// ---------------------------------------------------------------------------
// External waits
// ---------------------------------------------------------------------------

export interface UpsertExternalWaitInput {
  waitingFor?: string | null;
  revisitDate?: string | null;
  expectedRevision?: number;
}

export type ExternalWaitFollowUpInput =
  | {
      action: "resolve";
      content: string;
      expectedRevision?: number;
    }
  | {
      action: "continue";
      content: string;
      waitingFor?: string | null;
      revisitDate?: string | null;
      expectedRevision?: number;
    };

function followUpAttribution(db: Db, context?: MutationContext): string {
  const actorMemberId = actor(context);
  if (actorMemberId === null) return "Unknown actor";
  return (
    db
      .select({ name: schema.members.name })
      .from(schema.members)
      .where(eq(schema.members.id, actorMemberId))
      .get()?.name ?? "Unknown actor"
  );
}

export function followUpExternalWait(
  db: Db,
  taskId: number,
  input: ExternalWaitFollowUpInput,
  context?: MutationContext,
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const task = getTaskOrThrow(txDb, taskId);
    assertExpectedRevision(
      "task",
      taskId,
      task.revision,
      input.expectedRevision,
    );
    if (task.status !== "actionable") {
      throw AppError.conflict(
        "external_wait_status_invalid",
        "Only actionable tasks can receive an external-wait follow-up.",
        { taskId, currentStatus: task.status },
      );
    }
    if (task.repeatAfterDays !== null) {
      throw AppError.conflict(
        "external_wait_recurring_forbidden",
        "Recurring tasks cannot use an external wait.",
        { taskId },
      );
    }
    const existing = tx
      .select()
      .from(schema.taskExternalWaits)
      .where(eq(schema.taskExternalWaits.taskId, taskId))
      .get();
    if (!existing) {
      throw AppError.conflict(
        "external_wait_status_invalid",
        "This task has no external wait to follow up.",
        { taskId, reason: "external_wait_missing" },
      );
    }
    const content = input.content.trim();
    if (content === "") {
      throw AppError.badRequest(
        "request_body_invalid",
        "Follow-up text must not be empty.",
        { taskId, field: "content" },
      );
    }

    const waitingFor =
      input.action === "continue"
        ? input.waitingFor === undefined
          ? existing.waitingFor?.trim() ?? ""
          : input.waitingFor?.trim() ?? ""
        : null;
    if (input.action === "continue" && !waitingFor) {
      throw AppError.badRequest(
        "external_wait_reason_required",
        "An external wait requires a reason.",
        { taskId },
      );
    }
    const revisitDate =
      input.action === "resolve"
        ? null
        : input.revisitDate === undefined
          ? existing.revisitDate
          : input.revisitDate;
    const projectHadNextAction =
      task.projectId === null
        ? true
        : projectHasNextAction(txDb, task.projectId);
    const now = nowIso();
    const notes = appendNoteContent(
      task.notes,
      `[${now} · ${followUpAttribution(txDb, context)}]\n${content}`,
    );

    if (input.action === "resolve") {
      tx.delete(schema.taskExternalWaits)
        .where(eq(schema.taskExternalWaits.taskId, taskId))
        .run();
    } else {
      tx.update(schema.taskExternalWaits)
        .set({ waitingFor, revisitDate, updatedAt: now })
        .where(eq(schema.taskExternalWaits.taskId, taskId))
        .run();
    }
    const updated = tx
      .update(schema.workItems)
      .set({
        notes,
        revision: sql`${schema.workItems.revision} + 1`,
        updatedAt: now,
      })
      .where(eq(schema.workItems.id, taskId))
      .returning()
      .get();
    const waitChanged =
      input.action === "resolve" || waitingFor !== existing.waitingFor;
    const revisitChanged = revisitDate !== existing.revisitDate;
    const activityEventId = recordActivity(txDb, {
      actorMemberId: actor(context),
      kind:
        input.action === "resolve"
          ? "task_external_wait_resolved"
          : "task_external_wait_updated",
      entityType: "task",
      entityTitle: task.title,
      taskId,
      projectId: task.projectId,
      metadata: {
        changedFields: [
          "notesAppended",
          ...(waitChanged ? ["externalWait"] : []),
          ...(revisitChanged ? ["revisitDate"] : []),
        ],
      },
    });
    if (input.action === "resolve") {
      neutralizeContribution(txDb, {
        activityEventId,
        reason: "waiting_followup_added",
        entityType: "task",
        entityId: taskId,
      });
      if (
        task.projectId !== null &&
        !projectHadNextAction &&
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
      }
    } else if (existing.revisitDate === null && revisitDate !== null) {
      recordContribution(txDb, {
        activityEventId,
        actorMemberId: actor(context),
        category: "planning",
        reason: "waiting_followup_added",
        entityType: "task",
        entityId: taskId,
        personalEligible: true,
      });
    } else if (existing.revisitDate !== null && revisitDate === null) {
      neutralizeContribution(txDb, {
        activityEventId,
        reason: "waiting_followup_added",
        entityType: "task",
        entityId: taskId,
      });
    }
    return updated;
  });
}

export function upsertExternalWait(
  db: Db,
  taskId: number,
  input: UpsertExternalWaitInput,
  context?: MutationContext,
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const task = getTaskOrThrow(txDb, taskId);
    assertExpectedRevision(
      "task",
      taskId,
      task.revision,
      input.expectedRevision,
    );
    if (task.status !== "actionable") {
      throw AppError.conflict(
        "external_wait_status_invalid",
        "Only actionable tasks can wait for an external event.",
        { taskId, currentStatus: task.status },
      );
    }
    if (task.repeatAfterDays !== null) {
      throw AppError.conflict(
        "external_wait_recurring_forbidden",
        "Recurring tasks cannot use an external wait.",
        { taskId },
      );
    }
    const projectHadNextAction =
      task.projectId === null
        ? true
        : projectHasNextAction(txDb, task.projectId);

    const existing = tx
      .select()
      .from(schema.taskExternalWaits)
      .where(eq(schema.taskExternalWaits.taskId, taskId))
      .get();
    const waitingFor =
      input.waitingFor === undefined
        ? existing?.waitingFor?.trim() ?? ""
        : input.waitingFor?.trim() ?? "";
    if (!waitingFor) {
      throw AppError.badRequest(
        "external_wait_reason_required",
        "An external wait requires a reason.",
        { taskId },
      );
    }
    const revisitDate =
      input.revisitDate === undefined
        ? existing?.revisitDate ?? null
        : input.revisitDate;
    const waitChanged = !existing || existing.waitingFor !== waitingFor;
    const revisitChanged = !existing || existing.revisitDate !== revisitDate;
    if (!waitChanged && !revisitChanged) return existing;

    const now = nowIso();
    if (existing) {
      tx.update(schema.taskExternalWaits)
        .set({ waitingFor, revisitDate, updatedAt: now })
        .where(eq(schema.taskExternalWaits.taskId, taskId))
        .run();
    } else {
      tx.insert(schema.taskExternalWaits)
        .values({
          taskId,
          waitingFor,
          revisitDate,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }
    touchTask(txDb, taskId);
    const activityEventId = recordActivity(txDb, {
      actorMemberId: actor(context),
      kind: existing ? "task_external_wait_updated" : "task_external_wait_started",
      entityType: "task",
      entityTitle: task.title,
      taskId,
      projectId: task.projectId,
      metadata: {
        changedFields: [
          ...(waitChanged ? ["externalWait"] : []),
          ...(revisitChanged ? ["revisitDate"] : []),
        ],
      },
    });
    if ((existing?.revisitDate ?? null) === null && revisitDate !== null) {
      recordContribution(txDb, {
        activityEventId,
        actorMemberId: actor(context),
        category: "planning",
        reason: "waiting_followup_added",
        entityType: "task",
        entityId: taskId,
        personalEligible: true,
      });
    } else if (existing?.revisitDate != null && revisitDate === null) {
      neutralizeContribution(txDb, {
        activityEventId,
        reason: "waiting_followup_added",
        entityType: "task",
        entityId: taskId,
      });
    }
    if (
      task.projectId !== null &&
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
    return tx
      .select()
      .from(schema.taskExternalWaits)
      .where(eq(schema.taskExternalWaits.taskId, taskId))
      .get()!;
  });
}

export function resolveExternalWait(
  db: Db,
  taskId: number,
  expectedRevision?: number,
  context?: MutationContext,
): void {
  db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const task = getTaskOrThrow(txDb, taskId);
    assertExpectedRevision(
      "task",
      taskId,
      task.revision,
      expectedRevision,
    );
    const existing = tx
      .select()
      .from(schema.taskExternalWaits)
      .where(eq(schema.taskExternalWaits.taskId, taskId))
      .get();
    if (!existing) return;
    const projectHadNextAction =
      task.projectId === null
        ? true
        : projectHasNextAction(txDb, task.projectId);

    tx.delete(schema.taskExternalWaits)
      .where(eq(schema.taskExternalWaits.taskId, taskId))
      .run();
    touchTask(txDb, taskId);
    const activityEventId = recordActivity(txDb, {
      actorMemberId: actor(context),
      kind: "task_external_wait_resolved",
      entityType: "task",
      entityTitle: task.title,
      taskId,
      projectId: task.projectId,
      metadata: {
        changedFields: [
          "externalWait",
          ...(existing.revisitDate !== null ? ["revisitDate"] : []),
        ],
      },
    });
    neutralizeContribution(txDb, {
      activityEventId,
      reason: "waiting_followup_added",
      entityType: "task",
      entityId: taskId,
    });
    if (
      task.projectId !== null &&
      !projectHadNextAction &&
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
    }
  });
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export function addDependency(
  db: Db,
  taskId: number,
  dependsOnTaskId: number,
  context?: MutationContext,
) {
  if (taskId === dependsOnTaskId) {
    throw AppError.conflict(
      "task_dependency_self",
      "A task cannot depend on itself.",
      { taskId },
    );
  }
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const task = getTaskOrThrow(txDb, taskId);
    const dependency = getTaskOrThrow(txDb, dependsOnTaskId);
    const hadNextAction =
      task.projectId === null
        ? true
        : projectHasNextAction(txDb, task.projectId);

    const existing = tx
      .select()
      .from(schema.taskDependencies)
      .where(
        and(
          eq(schema.taskDependencies.taskId, taskId),
          eq(schema.taskDependencies.dependsOnTaskId, dependsOnTaskId),
        ),
      )
      .get();
    if (existing) return existing;

    if (wouldCreateDependencyCycle(txDb, taskId, dependsOnTaskId)) {
      throw AppError.conflict(
        "task_dependency_cycle",
        "This dependency would create a cycle.",
        { taskId, dependsOnTaskId },
      );
    }

    const created = tx
      .insert(schema.taskDependencies)
      .values({ taskId, dependsOnTaskId })
      .returning()
      .get();
    touchTask(txDb, taskId);
    const activityEventId = recordActivity(txDb, {
      actorMemberId: actor(context),
      kind: "task_dependencies_changed",
      entityType: "task",
      entityTitle: task.title,
      taskId,
      projectId: task.projectId,
      metadata: {
        relatedTaskIds: [dependency.id],
        relatedTaskTitles: [dependency.title],
      },
    });
    if (
      task.projectId !== null &&
      hadNextAction &&
      !projectHasNextAction(txDb, task.projectId)
    ) {
      neutralizeContribution(txDb, {
        activityEventId,
        reason: "project_next_action_added",
        entityType: "project",
        entityId: task.projectId,
      });
    }
    return created;
  });
}

export function removeDependency(
  db: Db,
  taskId: number,
  dependsOnTaskId: number,
  context?: MutationContext,
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const task = getTaskOrThrow(txDb, taskId);
    const dependency = getTaskOrThrow(txDb, dependsOnTaskId);
    const hadNextAction =
      task.projectId === null
        ? true
        : projectHasNextAction(txDb, task.projectId);
    const deleted = tx.delete(schema.taskDependencies)
      .where(
        and(
          eq(schema.taskDependencies.taskId, taskId),
          eq(schema.taskDependencies.dependsOnTaskId, dependsOnTaskId),
        ),
      )
      .run();
    if (deleted.changes > 0) {
      touchTask(txDb, taskId);
      const activityEventId = recordActivity(txDb, {
        actorMemberId: actor(context),
        kind: "task_dependencies_changed",
        entityType: "task",
        entityTitle: task.title,
        taskId,
        projectId: task.projectId,
        metadata: {
          relatedTaskIds: [dependency.id],
          relatedTaskTitles: [dependency.title],
        },
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
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Tags on tasks
// ---------------------------------------------------------------------------

export function addTaskTag(
  db: Db,
  taskId: number,
  tagId: number,
  context?: MutationContext,
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const task = getTaskOrThrow(txDb, taskId);
    const existing = tx.select().from(schema.workItemTags)
      .where(and(eq(schema.workItemTags.workItemId, taskId), eq(schema.workItemTags.tagId, tagId)))
      .get();
    if (existing) return;
    tx.insert(schema.workItemTags).values({ workItemId: taskId, tagId }).run();
    touchTask(txDb, taskId);
    recordActivity(txDb, {
      actorMemberId: actor(context),
      kind: "task_tags_changed",
      entityType: "task",
      entityTitle: task.title,
      taskId,
      projectId: task.projectId,
      metadata: {},
    });
  });
}

export function removeTaskTag(
  db: Db,
  taskId: number,
  tagId: number,
  context?: MutationContext,
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const task = getTaskOrThrow(txDb, taskId);
    const deleted = tx.delete(schema.workItemTags)
      .where(and(eq(schema.workItemTags.workItemId, taskId), eq(schema.workItemTags.tagId, tagId)))
      .run();
    if (deleted.changes > 0) {
      touchTask(txDb, taskId);
      recordActivity(txDb, {
        actorMemberId: actor(context),
        kind: "task_tags_changed",
        entityType: "task",
        entityTitle: task.title,
        taskId,
        projectId: task.projectId,
        metadata: {},
      });
    }
  });
}

export function addExcludedTag(
  db: Db,
  taskId: number,
  tagId: number,
  context?: MutationContext,
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const task = getTaskOrThrow(txDb, taskId);
    const existing = tx.select().from(schema.taskExcludedTags)
      .where(
        and(
          eq(schema.taskExcludedTags.taskId, taskId),
          eq(schema.taskExcludedTags.tagId, tagId),
        ),
      )
      .get();
    if (existing) return;
    tx.insert(schema.taskExcludedTags).values({ taskId, tagId }).run();
    touchTask(txDb, taskId);
    recordActivity(txDb, {
      actorMemberId: actor(context),
      kind: "task_tags_changed",
      entityType: "task",
      entityTitle: task.title,
      taskId,
      projectId: task.projectId,
      metadata: {},
    });
  });
}

export function removeExcludedTag(
  db: Db,
  taskId: number,
  tagId: number,
  context?: MutationContext,
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const task = getTaskOrThrow(txDb, taskId);
    const deleted = tx.delete(schema.taskExcludedTags)
      .where(
        and(
          eq(schema.taskExcludedTags.taskId, taskId),
          eq(schema.taskExcludedTags.tagId, tagId),
        ),
      )
      .run();
    if (deleted.changes > 0) {
      touchTask(txDb, taskId);
      recordActivity(txDb, {
        actorMemberId: actor(context),
        kind: "task_tags_changed",
        entityType: "task",
        entityTitle: task.title,
        taskId,
        projectId: task.projectId,
        metadata: {},
      });
    }
  });
}
