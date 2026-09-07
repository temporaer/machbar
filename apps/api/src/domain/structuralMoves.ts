/**
 * Task hierarchy structural moves: reparenting, reordering, and cascading a
 * subtree's story assignment.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { AppError } from "../errors.js";
import {
  getDescendantIds as repoGetDescendantIds,
  neutralizeContribution,
  recordActivity,
  recordContribution,
  wouldCreateHierarchyCycle,
} from "../repo/index.js";
import { getProjectOrThrow } from "./storyCrud.js";
import { assertParentAcceptsChildren, getTaskOrThrow } from "./taskCrud.js";
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
    tx.update(schema.tasks)
      .set({
        position: index,
        updatedAt: nowIso(),
      })
      .where(eq(schema.tasks.id, taskId))
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
  return tx.select().from(schema.tasks).all();
}

function cascadeProjectId(tx: Db, rootId: number, newProjectId: number | null) {
  // A single recursive-CTE lookup (repo layer) resolves the whole subtree;
  // the update itself is then one ordinary batched Drizzle statement
  // instead of a per-node BFS loop with one query per level.
  const descendantIds = repoGetDescendantIds(tx, rootId);
  if (descendantIds.length === 0) return;
  tx.update(schema.tasks)
    .set({
      projectId: newProjectId,
      revision: sql`${schema.tasks.revision} + 1`,
      updatedAt: nowIso(),
    })
    .where(inArray(schema.tasks.id, descendantIds))
    .run();
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
    } else {
      newProjectId = "projectId" in input ? input.projectId ?? null : task.projectId;
    }
    if (
      task.status === "captured" &&
      task.projectId === null &&
      task.parentTaskId === null &&
      (newParentTaskId !== null || newProjectId !== null)
    ) {
      throw AppError.conflict(
        "task_promotion_invalid",
        "Promote the captured inbox item instead of filing it as a task.",
        { taskId, reason: "captured_root_move_forbidden" },
      );
    }

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

    tx.update(schema.tasks)
      .set({
        parentTaskId: newParentTaskId,
        projectId: newProjectId,
        revision: sql`${schema.tasks.revision} + 1`,
        updatedAt: nowIso(),
      })
      .where(eq(schema.tasks.id, taskId))
      .run();

    if (newProjectId !== task.projectId) {
      cascadeProjectId(txDb, taskId, newProjectId);
    }

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

    const updated = tx.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get()!;
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
