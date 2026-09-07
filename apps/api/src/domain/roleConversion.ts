/**
 * Identity-preserving task <-> story role conversion (see `workItem.ts` for
 * the read-side projection this keeps in sync with).
 */
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { ProjectStatus } from "@machbar/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { AppError } from "../errors.js";
import {
  getDescendantIds as repoGetDescendantIds,
  recordActivity,
  recordContribution,
} from "../repo/index.js";
import { lifecycleToTaskStatus, projectLifecycle } from "./workItem.js";
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

/**
 * Converts a root-level captured task into a story ("project"), preserving
 * its identity (same numeric id, enabled by the shared `work_items`
 * allocator) so activity history, tags, contexts, and notifications keyed
 * on that id survive the conversion in place rather than being recreated
 * under a new id. Replaces the former identity-destroying
 * `promoteTaskToProject` (which deleted the task and inserted a brand-new
 * project row).
 *
 * See `convertStoryToTask` for the reverse direction.
 */
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
    if (
      task.status !== "captured" ||
      task.projectId !== null ||
      task.parentTaskId !== null
    ) {
      throw AppError.conflict(
        "task_promotion_invalid",
        "Only a root-level captured inbox item can be converted to a story.",
        { taskId, reason: "not_root_capture" },
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
    const externalWait = tx
      .select({ taskId: schema.taskExternalWaits.taskId })
      .from(schema.taskExternalWaits)
      .where(eq(schema.taskExternalWaits.taskId, taskId))
      .get();
    const dependency = tx
      .select({ id: schema.taskDependencies.id })
      .from(schema.taskDependencies)
      .where(
        or(
          eq(schema.taskDependencies.taskId, taskId),
          eq(schema.taskDependencies.dependsOnTaskId, taskId),
        ),
      )
      .get();
    const recurrenceOccurrence = tx
      .select({ id: schema.taskRecurrenceOccurrences.id })
      .from(schema.taskRecurrenceOccurrences)
      .where(eq(schema.taskRecurrenceOccurrences.taskId, taskId))
      .get();
    if (
      externalWait ||
      dependency ||
      recurrenceOccurrence ||
      task.repeatAfterDays !== null ||
      task.reminderAt !== null
    ) {
      throw AppError.conflict(
        "task_promotion_invalid",
        "Resolve task-only waits, dependencies, recurrence, and reminders before promotion.",
        { taskId, reason: "task_only_relations" },
      );
    }

    const maxPosition = tx
      .select({ position: schema.projects.position })
      .from(schema.projects)
      .all()
      .reduce((max, project) => Math.max(max, project.position), -1);
    const ownerMemberId =
      task.ownerInheritanceMode === "explicit" ? task.ownerMemberId : null;
    if (input.status === "active" && ownerMemberId === null) {
      throw AppError.conflict(
        "project_driver_required",
        "An active project needs a driver.",
        { taskId, reason: "capture_driver_required" },
      );
    }
    const project = tx
      .insert(schema.projects)
      .values({
        // Reuse the task's own id (shared work_items allocator) instead of
        // allocating a new one, so the item's identity survives the role
        // conversion.
        id: taskId,
        title,
        notes: input.notes ?? task.notes,
        status: input.status,
        ownerMemberId,
        dueDate: task.dueDate,
        scheduledDate: task.scheduledDate,
        position: maxPosition + 1,
      })
      .returning()
      .get();

    const tagIds = tx
      .select({ tagId: schema.taskTags.tagId })
      .from(schema.taskTags)
      .where(eq(schema.taskTags.taskId, taskId))
      .all()
      .map((row) => row.tagId);
    for (const tagId of tagIds) {
      tx.insert(schema.projectTags).values({ projectId: project.id, tagId }).run();
    }
    if (task.physicalContextInheritanceMode === "explicit") {
      const contextIds = tx
        .select({ contextId: schema.taskPhysicalContexts.contextId })
        .from(schema.taskPhysicalContexts)
        .where(eq(schema.taskPhysicalContexts.taskId, taskId))
        .all()
        .map((row) => row.contextId);
      for (const contextId of contextIds) {
        tx.insert(schema.projectPhysicalContexts)
          .values({ projectId: project.id, contextId })
          .run();
      }
    }

    const descendantIds = repoGetDescendantIds(txDb, taskId);
    if (descendantIds.length > 0) {
      tx.update(schema.tasks)
        .set({
          projectId: project.id,
          revision: sql`${schema.tasks.revision} + 1`,
          updatedAt: nowIso(),
        })
        .where(inArray(schema.tasks.id, descendantIds))
        .run();
      tx.update(schema.tasks)
        .set({
          parentTaskId: null,
          revision: sql`${schema.tasks.revision} + 1`,
          updatedAt: nowIso(),
        })
        .where(eq(schema.tasks.parentTaskId, taskId))
        .run();
    }
    if (input.status === "active") {
      assertProjectActivationReady(txDb, project.id, ownerMemberId);
    }

    // Re-point history keyed on the shared id from "task" to "project" in
    // place, before the old `tasks` row is retired, so activity,
    // notifications, and contributions survive the conversion under the
    // same identity instead of being neutralized/recreated.
    tx.update(schema.activityEvents)
      .set({ entityType: "project", projectId: taskId, taskId: null })
      .where(
        and(
          eq(schema.activityEvents.entityType, "task"),
          eq(schema.activityEvents.taskId, taskId),
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
      metadata: {
        changedFields: ["role"],
        relatedTaskIds: descendantIds,
        affectedCount: descendantIds.length,
      },
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
    // Delete only the retired `tasks` row (cascades to task-only
    // satellites like taskTags/taskPhysicalContexts, already copied to
    // their project-side equivalents above). The shared `work_items` row
    // is intentionally left in place: `projects` now owns the same id.
    tx.delete(schema.tasks).where(eq(schema.tasks.id, taskId)).run();
    return project;
  });
}

export interface ConvertStoryToTaskInput {
  title?: string;
  notes?: string;
  expectedRevision?: number;
}

/**
 * Reverse of {@link convertTaskToStory}: converts a story back into a
 * task, preserving identity the same way. Conservative by design (per the
 * user's own guard): a story with any children or acceptance criteria
 * cannot be reduced to a single task, and is rejected outright rather than
 * best-effort flattened.
 */
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
    const hasChildTask = tx
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(eq(schema.tasks.projectId, projectId))
      .get();
    if (hasChildTask) {
      throw AppError.conflict(
        "role_conversion_invalid",
        "A story with tasks cannot be converted back to a single task.",
        { projectId, reason: "has_children" },
      );
    }
    const hasAcceptanceCriterion = tx
      .select({ id: schema.projectAcceptanceCriteria.id })
      .from(schema.projectAcceptanceCriteria)
      .where(eq(schema.projectAcceptanceCriteria.projectId, projectId))
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

    const status = lifecycleToTaskStatus(
      projectLifecycle(project.status as ProjectStatus),
    );
    const ownerInheritanceMode = project.ownerMemberId !== null ? "explicit" : "none";
    const position = nextPositionForGroup(txDb, null, null);

    const task = tx
      .insert(schema.tasks)
      .values({
        // Reuse the story's own id, preserving identity across the
        // conversion just like the forward direction.
        id: projectId,
        title,
        notes: input.notes ?? project.notes,
        status,
        needsClarification: status === "captured",
        ownerMemberId: project.ownerMemberId,
        ownerInheritanceMode,
        dueDate: project.dueDate,
        scheduledDate: project.scheduledDate,
        position,
      })
      .returning()
      .get();

    const tagIds = tx
      .select({ tagId: schema.projectTags.tagId })
      .from(schema.projectTags)
      .where(eq(schema.projectTags.projectId, projectId))
      .all()
      .map((row) => row.tagId);
    for (const tagId of tagIds) {
      tx.insert(schema.taskTags).values({ taskId: task.id, tagId }).run();
    }
    const contextIds = tx
      .select({ contextId: schema.projectPhysicalContexts.contextId })
      .from(schema.projectPhysicalContexts)
      .where(eq(schema.projectPhysicalContexts.projectId, projectId))
      .all()
      .map((row) => row.contextId);
    if (contextIds.length > 0) {
      tx.update(schema.tasks)
        .set({ physicalContextInheritanceMode: "explicit" })
        .where(eq(schema.tasks.id, task.id))
        .run();
      for (const contextId of contextIds) {
        tx.insert(schema.taskPhysicalContexts)
          .values({ taskId: task.id, contextId })
          .run();
      }
    }

    tx.update(schema.activityEvents)
      .set({ entityType: "task", taskId: projectId, projectId: null })
      .where(
        and(
          eq(schema.activityEvents.entityType, "project"),
          eq(schema.activityEvents.projectId, projectId),
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

    recordActivity(txDb, {
      actorMemberId: actor(context),
      kind: "work_item_role_converted",
      entityType: "task",
      entityTitle: task.title,
      taskId: task.id,
      metadata: { changedFields: ["role"] },
    });

    // Delete only the retired `projects` row; the shared `work_items` row
    // stays in place since `tasks` now owns the same id.
    tx.delete(schema.projects).where(eq(schema.projects.id, projectId)).run();
    return task;
  });
}
