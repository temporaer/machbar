/**
 * Story lifecycle transitions (`backlog -> active -> done`, with `archived`
 * a terminal retirement reachable from any non-archived point) and the
 * review-acknowledgement timestamp.
 */
import { and, eq, or, sql } from "drizzle-orm";
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
  MutationContext,
  actor,
  assertExpectedRevision,
  assertProjectActivationReady,
  enqueueProjectAssignment,
  nowIso,
} from "./workItemShared.js";

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
    const ownerMemberId =
      input.ownerMemberId !== undefined ? input.ownerMemberId : project.ownerMemberId;
    assertProjectActivationReady(txDb, id, ownerMemberId);
    tx.update(schema.workItems)
      .set({
        status: "active",
        archivedAt: null,
        ownerMemberId,
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
        nextStatus: "active",
        ...(ownerMemberId !== project.ownerMemberId
          ? { changedFields: ["ownerMemberId"] }
          : {}),
      },
    });
    if (project.ownerMemberId === null && ownerMemberId !== null) {
      recordContribution(txDb, {
        activityEventId,
        actorMemberId: actor(context),
        category: "planning",
        reason: "project_driver_assigned",
        entityType: "project",
        entityId: id,
        personalEligible: true,
      });
    }
    if (
      project.ownerMemberId !== updated.ownerMemberId &&
      updated.ownerMemberId !== null
    ) {
      enqueueProjectAssignment(txDb, updated, activityEventId, context);
    }
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
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const project = getProjectOrThrow(txDb, id);
    assertExpectedRevision("project", id, project.revision, expectedRevision);
    assertWorkflowAction(project, "return_to_backlog");
    tx.update(schema.workItems)
      .set({
        status: "backlog",
        archivedAt: null,
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
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const project = getProjectOrThrow(txDb, id);
    assertExpectedRevision("project", id, project.revision, expectedRevision);
    assertWorkflowAction(project, "complete");
    const criteria = tx
      .select({
        id: schema.workItemAcceptanceCriteria.id,
        checked: schema.workItemAcceptanceCriteria.checked,
      })
      .from(schema.workItemAcceptanceCriteria)
      .where(eq(schema.workItemAcceptanceCriteria.workItemId, id))
      .all();
    const incompleteCriterionIds = criteria
      .filter((criterion) => !criterion.checked)
      .map((criterion) => criterion.id);
    if (incompleteCriterionIds.length > 0) {
      throw AppError.conflict(
        "project_completion_criteria_incomplete",
        "Every acceptance criterion must be checked before completing the project.",
        {
          projectId: id,
          criteriaCount: criteria.length,
          incompleteCriterionIds,
        },
      );
    }
    tx.update(schema.workItems)
      .set({
        status: "done",
        archivedAt: null,
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
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const project = getProjectOrThrow(txDb, id);
    assertExpectedRevision("project", id, project.revision, expectedRevision);
    assertWorkflowAction(project, "reopen");
    const nextOwnerMemberId =
      ownerMemberId !== undefined ? ownerMemberId : project.ownerMemberId;
    assertProjectActivationReady(txDb, id, nextOwnerMemberId);
    tx.update(schema.workItems)
      .set({
        status: "active",
        archivedAt: null,
        completedAt: null,
        ownerMemberId: nextOwnerMemberId,
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
      metadata: { previousStatus: "completed", nextStatus: "active" },
    });
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
