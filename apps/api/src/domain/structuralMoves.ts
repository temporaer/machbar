/**
 * Canonical task and project hierarchy moves on the unified parent edge.
 */
import type { ProjectActivationResolution } from "@machbar/shared";
import { eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { AppError } from "../errors.js";
import {
  getDescendantIds as repoGetDescendantIds,
  getAncestorIds,
  neutralizeContribution,
  recordActivity,
  recordContribution,
  wouldCreateHierarchyCycle,
} from "../repo/index.js";
import { getProjectOrThrow } from "./storyCrud.js";
import { assertParentAcceptsChildren, getTaskOrThrow } from "./taskCrud.js";
import { activateCommittedProjectChain } from "./commitmentActivation.js";
import { hasExecutionCommitment } from "./commitmentTransition.js";
import { getEffectiveOwners } from "../repo/effectiveRepo.js";
import { Graph } from "./graph.js";
import {
  MutationContext,
  actor,
  assertExpectedRevision,
  nowIso,
  projectHasNextAction,
  projectHasTaskPlan,
} from "./workItemShared.js";

// ---------------------------------------------------------------------------
// Hierarchy
// ---------------------------------------------------------------------------

export interface MoveTaskInput {
  parentTaskId?: number | null;
  projectId?: number | null;
  position?: number;
  expectedRevision: number;
}

function reindexGroup(
  tx: Db,
  parentTaskId: number | null,
  projectId: number | null,
  orderedIds: number[],
) {
  orderedIds.forEach((taskId, index) => {
    tx.update(schema.workItems)
      .set({
        position: index,
        updatedAt: nowIso(),
      })
      .where(eq(schema.workItems.id, taskId))
      .run();
  });
}

function siblingsOf(
  tx: Db,
  parentTaskId: number | null,
  projectId: number | null,
  excludeId: number,
) {
  const all = db_selectAllTasks(tx);
  return all
    .filter(
      (t) =>
        t.parentTaskId === parentTaskId &&
        t.projectId === projectId &&
        t.id !== excludeId,
    )
    .sort((a, b) => a.position - b.position);
}

function db_selectAllTasks(tx: Db) {
  return Graph.load(tx).allTasks();
}

/**
 * Canonical transactional hierarchy mutation. UI gestures calculate a
 * concrete destination; this command validates concurrency and hierarchy
 * invariants, moves the whole subtree, and normalizes both sibling groups.
 */
export function moveTask(
  db: Db,
  taskId: number,
  input: MoveTaskInput,
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

    const newParentTaskId =
      "parentTaskId" in input ? input.parentTaskId ?? null : task.parentTaskId;

    let newProjectId: number | null;
    if (newParentTaskId !== null) {
      if (newParentTaskId === taskId) {
        throw AppError.conflict(
          "task_parent_self",
          "A task cannot be its own parent.",
          { taskId },
        );
      }
      const newParent = getTaskOrThrow(txDb, newParentTaskId);
      assertParentAcceptsChildren(txDb, newParentTaskId);
      if (wouldCreateHierarchyCycle(txDb, taskId, newParentTaskId)) {
        throw AppError.conflict(
          "task_hierarchy_cycle",
          "This move would create a cycle in the task hierarchy.",
          { taskId, parentTaskId: newParentTaskId },
        );
      }
      newProjectId = newParent.projectId;
      if (newParent.scope !== task.scope) {
        throw AppError.conflict(
          "scope_mismatch",
          "A task cannot be moved across household/work scope.",
          { taskId, parentTaskId: newParentTaskId },
        );
      }
    } else {
      newProjectId = "projectId" in input ? input.projectId ?? null : task.projectId;
      if (newProjectId !== null && newProjectId !== task.projectId) {
        const newProject = getProjectOrThrow(txDb, newProjectId);
        if (wouldCreateHierarchyCycle(txDb, taskId, newProjectId)) {
          throw AppError.conflict("task_hierarchy_cycle", "This move would create a cycle in the hierarchy.", { taskId, projectId: newProjectId });
        }
        if (newProject.scope !== task.scope) {
          throw AppError.conflict(
            "scope_mismatch",
            "A task cannot be moved across household/work scope.",
            { taskId, projectId: newProjectId },
          );
        }
      }
    }
    // Filing a captured, unclassified inbox item into a project/parent is
    // the refile flow: it is not "just a move" (the item is not yet a
    // legal task anywhere), so it atomically classifies the item into the
    // normal actionable state in the same transaction as the reparent below,
    // instead of requiring a separate promotion step first.
    const refilesCapturedInboxItem =
      task.kind === "action" &&
      task.status === "captured" &&
      task.projectId === null &&
      task.parentTaskId === null &&
      (newParentTaskId !== null || newProjectId !== null);

    const sourceHadNextAction =
      task.projectId === null
        ? true
        : projectHasNextAction(txDb, task.projectId);
    const sourceHadTaskPlan =
      task.projectId === null
        ? true
        : projectHasTaskPlan(txDb, task.projectId);
    const destinationHadNextAction =
      newProjectId === null
        ? true
        : newProjectId === task.projectId
          ? sourceHadNextAction
          : projectHasNextAction(txDb, newProjectId);
    const destinationHadTaskPlan =
      newProjectId === null
        ? true
        : newProjectId === task.projectId
          ? sourceHadTaskPlan
          : projectHasTaskPlan(txDb, newProjectId);

    const movingWithinSameGroup =
      newParentTaskId === task.parentTaskId && newProjectId === task.projectId;

    const destinationSiblings = siblingsOf(
      txDb,
      newParentTaskId,
      newProjectId,
      taskId,
    );
    const rawIndex = input.position ?? destinationSiblings.length;
    const index = Math.max(0, Math.min(rawIndex, destinationSiblings.length));
    const destinationIds = destinationSiblings.map((t) => t.id);
    destinationIds.splice(index, 0, taskId);

    tx.update(schema.workItems)
      .set({
        parentId: newParentTaskId ?? newProjectId,
        revision: sql`${schema.workItems.revision} + 1`,
        updatedAt: nowIso(),
        ...(refilesCapturedInboxItem
          ? { status: "active" as const, needsClarification: false }
          : {}),
      })
      .where(eq(schema.workItems.id, taskId))
      .run();



    reindexGroup(txDb, newParentTaskId, newProjectId, destinationIds);

    if (!movingWithinSameGroup) {
      const sourceSiblings = siblingsOf(
        txDb,
        task.parentTaskId,
        task.projectId,
        taskId,
      );
      reindexGroup(
        txDb,
        task.parentTaskId,
        task.projectId,
        sourceSiblings.map((t) => t.id),
      );
    }

    const updated = getTaskOrThrow(txDb, taskId);
    if (!movingWithinSameGroup) {
      const destinationProject =
        newProjectId !== task.projectId && newProjectId !== null
          ? getProjectOrThrow(txDb, newProjectId)
          : null;
      const destinationParent =
        newParentTaskId !== null
          ? getTaskOrThrow(txDb, newParentTaskId)
          : null;
      const activityEventId = recordActivity(txDb, {
        actorMemberId: actor(context),
        kind: "task_moved",
        entityType: "task",
        entityTitle: updated.title,
        taskId,
        projectId: updated.projectId,
        metadata: {
          ...(destinationProject
            ? {
                relatedProjectIds: [destinationProject.id],
                relatedProjectTitles: [destinationProject.title],
              }
            : {}),
          ...(destinationParent
            ? {
                relatedTaskIds: [destinationParent.id],
                relatedTaskTitles: [destinationParent.title],
              }
            : {}),
        },
      });
      if (
        task.projectId !== null &&
        sourceHadNextAction &&
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
        task.projectId !== null &&
        sourceHadTaskPlan &&
        !projectHasTaskPlan(txDb, task.projectId)
      ) {
        neutralizeContribution(txDb, {
          activityEventId,
          reason: "project_due_plan_added",
          entityType: "project",
          entityId: task.projectId,
        });
      }
      if (
        newProjectId !== null &&
        !destinationHadNextAction &&
        projectHasNextAction(txDb, newProjectId)
      ) {
        recordContribution(txDb, {
          activityEventId,
          actorMemberId: actor(context),
          category: "planning",
          reason: "project_next_action_added",
          entityType: "project",
          entityId: newProjectId,
          personalEligible: true,
        });
      } else if (
        newProjectId !== null &&
        !destinationHadTaskPlan &&
        projectHasTaskPlan(txDb, newProjectId)
      ) {
        recordContribution(txDb, {
          activityEventId,
          actorMemberId: actor(context),
          category: "planning",
          reason: "project_due_plan_added",
          entityType: "project",
          entityId: newProjectId,
          personalEligible: true,
        });
      }
    }
    return updated;
  });
}

/** A reviewed hierarchy snapshot protects membership and every affected revision. */
export function assertHierarchySnapshot(
  db: Db,
  requiredIds: number[],
  expected: Array<{ id: number; revision: number }>,
) {
  const revisions = new Map(expected.map((entry) => [entry.id, entry.revision]));
  if (revisions.size !== expected.length || requiredIds.some((id) => !revisions.has(id))) {
    throw AppError.conflict("stale_write_conflict", "The hierarchy changed. Reload before continuing.");
  }
  const rows = db.select().from(schema.workItems).where(inArray(schema.workItems.id, [...revisions.keys()])).all();
  if (rows.length !== revisions.size) throw AppError.conflict("stale_write_conflict", "An affected item no longer exists.");
  for (const row of rows) assertExpectedRevision(row.role === "story" ? "project" : "task", row.id, row.revision, revisions.get(row.id));
}

export interface MoveProjectInput {
  /** Projects move to another project or become standalone; task destinations are not offered. */
  parentId: number | null;
  expectedRevision: number;
  expectedHierarchyRevisions: Array<{ id: number; revision: number }>;
  activationResolution?: ProjectActivationResolution;
}

/** Canonical project reparenting, preserving the whole subtree and obligations. */
export function moveProject(db: Db, projectId: number, input: MoveProjectInput, context?: MutationContext) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const project = getProjectOrThrow(txDb, projectId);
    assertExpectedRevision("project", projectId, project.revision, input.expectedRevision);
    const descendants = repoGetDescendantIds(txDb, projectId);
    if (input.parentId !== null && wouldCreateHierarchyCycle(txDb, projectId, input.parentId)) {
      throw AppError.conflict("project_transition_invalid", "A project cannot move into itself or its descendants.");
    }
    const destination = input.parentId === null ? null : getProjectOrThrow(txDb, input.parentId);
    if (destination && destination.scope !== project.scope) throw AppError.conflict("scope_mismatch", "A project cannot move across household/work scope.");
    const requiredIds = [projectId, ...descendants, ...getAncestorIds(txDb, projectId),
      ...(destination ? [destination.id, ...getAncestorIds(txDb, destination.id)] : [])];
    assertHierarchySnapshot(txDb, requiredIds, input.expectedHierarchyRevisions);
    if (project.parentId === input.parentId) return project;
    // Moving inherited work must not silently give it to a different owner.
    const ownersBefore = getEffectiveOwners(txDb);
    const subtreeIds = [projectId, ...descendants];
    const siblings = txDb.select().from(schema.workItems).all().filter((row) => row.parentId === input.parentId && row.id !== projectId);
    const position = Math.max(-1, ...siblings.map((row) => row.position)) + 1;
    txDb.update(schema.workItems).set({ parentId: input.parentId, position,
      revision: sql`${schema.workItems.revision} + 1`, updatedAt: nowIso() }).where(eq(schema.workItems.id, projectId)).run();
    const ownersAfter = getEffectiveOwners(txDb);
    if (subtreeIds.some((id) => ownersBefore.get(id)?.ownerId !== ownersAfter.get(id)?.ownerId)) {
      throw AppError.conflict("project_transition_invalid", "Choose a destination that preserves this project's ownership.");
    }
    const graph = Graph.load(txDb);
    const committed = project.status !== "completed" && project.status !== "archived" && (
      project.status === "active" ||
      hasExecutionCommitment({ kind: "action", dueDate: project.dueDate, scheduledDate: project.scheduledDate, revisitAt: project.revisitAt, reminders: [] }) ||
      descendants.some((id) => {
        const task = graph.tasksById.get(id);
        const childProject = graph.projectsById.get(id);
        if (task) return task.status !== "done" && task.status !== "cancelled" && (hasExecutionCommitment(task) || task.repeatAfterDays !== null);
        return childProject?.status === "active" || (childProject?.status === "backlog" && (!!childProject.dueDate || !!childProject.scheduledDate));
      })
    );
    if (committed) {
      // Evaluate the moved project's whole new chain. Its existing active
      // progress path satisfies its new ancestors without inventing a step.
      const resolution = input.activationResolution ? {
        ...input.activationResolution,
        expectedProjects: input.activationResolution.expectedProjects.map((entry) =>
          entry.projectId === projectId && entry.revision === project.revision
            ? { ...entry, revision: project.revision + 1 }
            : entry),
      } : undefined;
      try {
        activateCommittedProjectChain(txDb, projectId, context, resolution);
      } catch (error) {
        if (error instanceof AppError && error.code === "project_commitment_resolution_required") {
          const details = error.details as Record<string, unknown> | undefined;
          if (details && Array.isArray(details.expectedProjects)) {
            details.expectedProjects = (details.expectedProjects as Array<{ projectId: number; revision: number }>).map((entry) =>
              entry.projectId === projectId ? { ...entry, revision: project.revision } : entry);
            if (details.targetRevision === project.revision + 1) details.targetRevision = project.revision;
          }
        }
        throw error;
      }
    }
    recordActivity(txDb, { actorMemberId: actor(context), kind: "project_updated", entityType: "project", entityTitle: project.title, projectId,
      metadata: { changedFields: ["parentId"], relatedProjectIds: input.parentId === null ? [] : [input.parentId] } });
    return getProjectOrThrow(txDb, projectId);
  });
}
