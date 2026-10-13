/**
 * Story lifecycle transitions (`backlog -> active -> done`, with `archived`
 * a terminal retirement reachable from any non-archived point) and the
 * review-acknowledgement timestamp.
 */
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { ProjectStatus } from "@machbar/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { AppError } from "../errors.js";
import {
  neutralizeContribution,
  recordActivity,
  recordContribution,
} from "../repo/index.js";
import { getProjectOrThrow } from "./storyCrud.js";
import {
  activateProjectFromWorkflow,
} from "./commitmentActivation.js";
import { hasExecutionCommitment } from "./commitmentTransition.js";
import type { ProjectActivationResolution } from "@machbar/shared";
import {
  MutationContext,
  actor,
  assertExpectedRevision,
  nowIso,
} from "./workItemShared.js";
import { Graph } from "./graph.js";
import { moveTask } from "./structuralMoves.js";
import { cancelTask } from "./taskWorkflow.js";
import { checkCriteriaForCompletion } from "./acceptanceCriteria.js";
import { getTaskIdsForStory } from "../repo/treeRepo.js";

// ---------------------------------------------------------------------------
// Explicit workflow transitions
// ---------------------------------------------------------------------------
//
// A story moves through `backlog -> active -> completed`. `archived` is a
// terminal retirement state reachable from any non-archived status, but it
// is not itself another parking state: the only way out is an explicit
// `return_to_backlog`, after which normal activation rules apply again.
// There is no direct `archived -> active` transition. Every transition is
// its own small, transactional function; `availableProjectWorkflowActions`
// is the single source of truth both for validating a requested transition
// and for advertising which actions are currently legal in API responses.

export type ProjectWorkflowAction =
  | "activate"
  | "return_to_backlog"
  | "complete"
  | "reopen"
  | "archive";

const workflowActionsByStatus: Record<ProjectStatus, ProjectWorkflowAction[]> = {
  backlog: ["activate", "archive"],
  active: ["return_to_backlog", "complete", "archive"],
  completed: ["reopen", "archive"],
  archived: ["return_to_backlog"],
};

export function availableProjectWorkflowActions(
  status: ProjectStatus,
): ProjectWorkflowAction[] {
  return workflowActionsByStatus[status];
}

function assertWorkflowAction(
  project: { id: number; status: string },
  action: ProjectWorkflowAction,
) {
  const status = project.status as ProjectStatus;
  if (!availableProjectWorkflowActions(status).includes(action)) {
    throw AppError.conflict(
      "project_transition_invalid",
      "The requested project status transition is not allowed.",
      {
        projectId: project.id,
        currentStatus: status,
        action,
        allowedActions: availableProjectWorkflowActions(status),
      },
    );
  }
}

export interface ActivateProjectInput {
  ownerMemberId?: number | null;
  expectedRevision?: number;
  activationResolution?: ProjectActivationResolution;
}

/**
 * `backlog` -> `active`. A story can only ever become active once it has a
 * driver: either already set on the project, or supplied here in the same
 * call (which also lets activation double as "assign the driver and start
 * work" in one step). An archived story cannot activate directly; it must
 * first `return_to_backlog`.
 */
export function activateProject(
  db: Db,
  id: number,
  input: ActivateProjectInput = {},
  context?: MutationContext,
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const project = getProjectOrThrow(txDb, id);
    assertExpectedRevision("project", id, project.revision, input.expectedRevision);
    assertWorkflowAction(project, "activate");
    const resolutionDriver = input.activationResolution?.drivers.find((decision) => decision.projectId === id)?.ownerMemberId;
    const ownerMemberId = input.ownerMemberId !== undefined
      ? input.ownerMemberId
      : resolutionDriver ?? project.ownerMemberId;
    activateProjectFromWorkflow(txDb, id, ownerMemberId, context, input.activationResolution);
    const updated = getProjectOrThrow(txDb, id);
    return updated;
  });
}

/**
 * `active`/`archived` -> `backlog`. The only way for a story to reach a
 * state where its driver may be cleared again.
 */
export function returnProjectToBacklog(
  db: Db,
  id: number,
  context?: MutationContext,
  expectedRevision?: number,
  revisitAt?: string | null,
  withdrawCommitments = false,
  expectedTaskRevisions?: Array<{ taskId: number; revision: number }>,
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const project = getProjectOrThrow(txDb, id);
    assertExpectedRevision("project", id, project.revision, expectedRevision);
    assertWorkflowAction(project, "return_to_backlog");
    const taskIds = getTaskIdsForStory(txDb, id);
    const tasks = taskIds.length === 0 ? [] : tx.select({
      id: schema.workItems.id,
      revision: schema.workItems.revision,
      dueDate: schema.workItems.dueDate,
      scheduledDate: schema.workItems.scheduledDate,
      revisitAt: schema.workItems.revisitAt,
      repeatAfterDays: schema.workItems.repeatAfterDays,
      status: schema.workItems.status,
      taskKind: schema.workItems.taskKind,
    }).from(schema.workItems).where(inArray(schema.workItems.id, taskIds)).all();
    const reminders = taskIds.length === 0 ? [] : tx.select({ taskId: schema.taskReminders.taskId, id: schema.taskReminders.id })
      .from(schema.taskReminders).where(inArray(schema.taskReminders.taskId, taskIds)).all();
    const remindersByTask = new Map<number, typeof reminders>();
    for (const reminder of reminders) {
      const taskReminders = remindersByTask.get(reminder.taskId) ?? [];
      taskReminders.push(reminder);
      remindersByTask.set(reminder.taskId, taskReminders);
    }
    // Terminal task fields are historical evidence, not live commitments.
    // Revisit notifications are intentional deferrals; the shared helper
    // excludes reminders attached to a revisit point from execution work.
    const committedTasks = tasks.filter((task) =>
      task.status !== "done" && task.status !== "cancelled" && hasExecutionCommitment({
        kind: task.taskKind === "action" ? "action" : "reference",
        dueDate: task.dueDate,
        scheduledDate: task.scheduledDate,
        revisitAt: task.revisitAt,
        reminders: remindersByTask.get(task.id) ?? [],
      }),
    );
    const projectHasCommitment = project.dueDate !== null;
    if ((committedTasks.length > 0 || projectHasCommitment) && !withdrawCommitments) {
      throw AppError.conflict(
        "project_commitments_prevent_parking",
        "This project still has planned work, deadlines, recurrence, or reminders. Confirm withdrawing those commitments before moving it to backlog.",
        { projectId: id, projectRevision: project.revision, committedTaskIds: committedTasks.map((task) => task.id), projectDeadline: project.dueDate },
      );
    }
    if (withdrawCommitments && committedTasks.length > 0) {
      const expected = new Map((expectedTaskRevisions ?? []).map((entry) => [entry.taskId, entry.revision]));
      const mismatched = tasks.filter((task) => expected.get(task.id) !== task.revision);
      const expectedIds = expectedTaskRevisions?.map((entry) => entry.taskId) ?? [];
      if (mismatched.length > 0 || new Set(expectedIds).size !== expectedIds.length || expectedIds.length !== tasks.length) {
        throw AppError.conflict("stale_write_conflict", "A planned task changed before its commitments could be withdrawn.", {
          entityType: "task", staleItems: mismatched.map((task) => ({ taskId: task.id, expectedRevision: expected.get(task.id), currentRevision: task.revision })),
        });
      }
      const now = nowIso();
      for (const task of committedTasks) {
        tx.update(schema.workItems).set({
          dueDate: null,
          scheduledDate: null,
          repeatAfterDays: null,
          allowedDeviationDays: null,
          revision: sql`${schema.workItems.revision} + 1`,
          updatedAt: now,
        }).where(eq(schema.workItems.id, task.id)).run();
        tx.delete(schema.taskReminders).where(eq(schema.taskReminders.taskId, task.id)).run();
        recordActivity(txDb, {
          actorMemberId: actor(context), kind: "task_updated", entityType: "task",
          entityTitle: tx.select({ title: schema.workItems.title }).from(schema.workItems).where(eq(schema.workItems.id, task.id)).get()!.title,
          taskId: task.id, projectId: id, metadata: { changedFields: ["dueDate", "scheduledDate", "repeatAfterDays", "reminders"] },
        });
      }
    }
    tx.update(schema.workItems)
      .set({
        status: "backlog",
        ...(withdrawCommitments ? { dueDate: null } : {}),
        archivedAt: null,
        revisitAt: project.status === "archived" ? null : revisitAt ?? null,
        revision: sql`${schema.workItems.revision} + 1`,
        updatedAt: nowIso(),
      })
      .where(eq(schema.workItems.id, id))
      .run();
    const updated = getProjectOrThrow(txDb, id);
    recordActivity(txDb, {
      actorMemberId: actor(context),
      kind: "project_status_changed",
      entityType: "project",
      entityTitle: updated.title,
      projectId: id,
      metadata: {
        previousStatus: project.status as ProjectStatus,
        nextStatus: "backlog",
      },
    });
    return updated;
  });
}

/**
 * `active` -> `completed`. Always a deliberate, manual decision: nothing
 * auto-completes a story just because every task is done/cancelled — that
 * situation only ever surfaces as the `completion_review` stuck reason,
 * prompting a human to call this action (or {@link reopenProject}/
 * {@link archiveProject} instead).
 */
export function completeProject(
  db: Db,
  id: number,
  context?: MutationContext,
  expectedRevision?: number,
  input: {
    criteriaToCheck?: readonly number[];
    expectedTaskRevisions?: readonly { taskId: number; revision: number }[];
    descendantResolutions?: readonly { taskId: number; action: "cancel" | "move_to_inbox"; expectedRevision: number }[];
  } = {},
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const project = getProjectOrThrow(txDb, id);
    assertExpectedRevision("project", id, project.revision, expectedRevision);
    assertWorkflowAction(project, "complete");
    const graph = Graph.load(txDb);
    const projectTasks = graph.allTasks().filter((task) => task.projectId === id);
    const openActions = graph.actionsForProject(id).filter((task) => task.status !== "done" && task.status !== "cancelled");
    const openIds = new Set(openActions.map((task) => task.id));
    const branches = openActions.filter((task) => !graph.taskAncestorsFor(task.id)
      .some((ancestor) => ancestor.role === "task" && openIds.has(ancestor.id)));
    const resolutions = input.descendantResolutions ?? [];
    if (branches.length > 0) {
      const branchIds = new Set(branches.map((task) => task.id));
      const byId = new Map(resolutions.map((resolution) => [resolution.taskId, resolution]));
      if (byId.size !== resolutions.length || byId.size !== branchIds.size || [...branchIds].some((taskId) => !byId.has(taskId))) {
        throw AppError.conflict("project_completion_resolution_required", "Choose what to do with every open task branch before completing this project.", {
          projectId: id, openTaskBranches: branches.map((task) => ({ taskId: task.id, title: task.title, revision: task.revision })),
        });
      }
      const expected = new Map((input.expectedTaskRevisions ?? []).map((entry) => [entry.taskId, entry.revision]));
      const expectedIds = input.expectedTaskRevisions?.map((entry) => entry.taskId) ?? [];
      const duplicateExpectedIds = new Set(expectedIds).size !== expectedIds.length;
      const stale = projectTasks.filter((task) => expected.get(task.id) !== task.revision);
      if (stale.length > 0 || duplicateExpectedIds || expectedIds.length !== projectTasks.length) {
        throw AppError.conflict("stale_write_conflict", "Project tasks changed before completion could be applied.", {
          entityType: "task", staleItems: stale.map((task) => ({ taskId: task.id, expectedRevision: expected.get(task.id), currentRevision: task.revision })),
        });
      }
      for (const branch of branches) {
        const resolution = byId.get(branch.id)!;
        if (resolution.expectedRevision !== branch.revision) {
          throw AppError.conflict("stale_write_conflict", "An open task changed before project completion.", {
            entityType: "task", entityId: branch.id, expectedRevision: resolution.expectedRevision, currentRevision: branch.revision,
          });
        }
      }
      for (const branch of branches) {
        const resolution = byId.get(branch.id)!;
        if (resolution.action === "cancel") {
          cancelTask(txDb, branch.id, "cancel_children", context, branch.revision);
        } else {
          moveTask(txDb, branch.id, { parentTaskId: null, projectId: null, expectedRevision: branch.revision }, context);
        }
      }
    } else if (resolutions.length > 0) {
      throw AppError.badRequest("project_completion_resolution_invalid", "There are no open task branches to resolve.", { projectId: id });
    }
    checkCriteriaForCompletion(txDb, id, input.criteriaToCheck ?? [], context);
    tx.update(schema.workItems)
      .set({
        status: "done",
        archivedAt: null,
        revisitAt: null,
        completedAt: nowIso(),
        revision: sql`${schema.workItems.revision} + 1`,
        updatedAt: nowIso(),
      })
      .where(eq(schema.workItems.id, id))
      .run();
    const updated = getProjectOrThrow(txDb, id);
    const activityEventId = recordActivity(txDb, {
      actorMemberId: actor(context),
      kind: "project_status_changed",
      entityType: "project",
      entityTitle: updated.title,
      projectId: id,
      metadata: { previousStatus: "active", nextStatus: "completed" },
    });
    recordContribution(txDb, {
      activityEventId,
      actorMemberId: actor(context),
      category: "completion",
      reason: "project_completed",
      entityType: "project",
      entityId: id,
      personalEligible:
        project.ownerMemberId === null ||
        project.ownerMemberId === actor(context),
    });
    return updated;
  });
}

/** `completed` -> `active` again, optionally replacing a missing driver atomically. */
export function reopenProject(
  db: Db,
  id: number,
  context?: MutationContext,
  expectedRevision?: number,
  ownerMemberId?: number | null,
  activationResolution?: ProjectActivationResolution,
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const project = getProjectOrThrow(txDb, id);
    assertExpectedRevision("project", id, project.revision, expectedRevision);
    assertWorkflowAction(project, "reopen");
    const resolutionDriver = activationResolution?.drivers.find((decision) => decision.projectId === id)?.ownerMemberId;
    const nextOwnerMemberId = ownerMemberId !== undefined
      ? ownerMemberId
      : resolutionDriver ?? project.ownerMemberId;
    const activityEventId = activateProjectFromWorkflow(txDb, id, nextOwnerMemberId, context, activationResolution);
    const updated = getProjectOrThrow(txDb, id);
    neutralizeContribution(txDb, {
      activityEventId,
      reason: "project_completed",
      entityType: "project",
      entityId: id,
    });
    return updated;
  });
}

/**
 * `backlog`/`active`/`completed` -> `archived`. Shelves/retires a story
 * without touching its driver.
 */
export function archiveProject(
  db: Db,
  id: number,
  context?: MutationContext,
  expectedRevision?: number,
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const project = getProjectOrThrow(txDb, id);
    assertExpectedRevision("project", id, project.revision, expectedRevision);
    assertWorkflowAction(project, "archive");
    tx.update(schema.workItems)
      .set({
        archivedAt: nowIso(),
        revisitAt: null,
        revision: sql`${schema.workItems.revision} + 1`,
        updatedAt: nowIso(),
      })
      .where(eq(schema.workItems.id, id))
      .run();
    const updated = getProjectOrThrow(txDb, id);
    const activityEventId = recordActivity(txDb, {
      actorMemberId: actor(context),
      kind: "project_status_changed",
      entityType: "project",
      entityTitle: updated.title,
      projectId: id,
      metadata: {
        previousStatus: project.status as ProjectStatus,
        nextStatus: "archived",
      },
    });
    if (project.status === "completed") {
      neutralizeContribution(txDb, {
        activityEventId,
        reason: "project_completed",
        entityType: "project",
        entityId: id,
      });
    }
    return updated;
  });
}

export function acknowledgeProjectReview(
  db: Db,
  id: number,
  expectedRevision?: number,
  context?: MutationContext,
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const project = getProjectOrThrow(txDb, id);
    assertExpectedRevision("project", id, project.revision, expectedRevision);
    const updated = tx
      .update(schema.workItems)
      .set({
        reviewedAt: nowIso(),
        revision: sql`${schema.workItems.revision} + 1`,
      })
      .where(eq(schema.workItems.id, id))
      .returning()
      .get();
    const returned = getProjectOrThrow(txDb, id);
    recordActivity(txDb, {
      actorMemberId: actor(context),
      kind: "project_updated",
      entityType: "project",
      entityTitle: returned.title,
      projectId: id,
      metadata: { changedFields: ["reviewedAt"] },
    });
    return returned;
  });
}
