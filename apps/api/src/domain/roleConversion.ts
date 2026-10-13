/**
 * Identity-preserving task <-> story role conversion on the unified
 * `work_items` table. Conversion now updates a row's `role` in place instead
 * of copying between task/project tables, so ids, links, tags, contexts,
 * notifications, and activity history stay attached to the same row.
 */
import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { ProjectActivationResolution, TaskStatus } from "@machbar/shared";
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
import { insertTaskRow, storedTaskStatus } from "./taskRowInsert.js";
import { activateCommittedProjectChain } from "./commitmentActivation.js";
import { hasExecutionCommitment } from "./commitmentTransition.js";
import { assertAcceptanceCriteriaChecked } from "./acceptanceCriteria.js";
import {
  MutationContext,
  actor,
  assertExpectedRevision,
  nowIso,
  projectHasNextAction,
  projectHasTaskPlan,
} from "./workItemShared.js";

function hasDependencyCycle(db: Db): boolean {
  const edges = db.select({ taskId: schema.taskDependencies.taskId, dependsOnTaskId: schema.taskDependencies.dependsOnTaskId })
    .from(schema.taskDependencies).all();
  const prerequisites = new Map<number, number[]>();
  for (const edge of edges) {
    const values = prerequisites.get(edge.taskId) ?? [];
    values.push(edge.dependsOnTaskId);
    prerequisites.set(edge.taskId, values);
  }
  const visiting = new Set<number>();
  const visited = new Set<number>();
  const visit = (id: number): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const prerequisite of prerequisites.get(id) ?? []) {
      if (visit(prerequisite)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return [...prerequisites.keys()].some(visit);
}

export interface ConvertTaskToStoryInput {
  status: "active" | "backlog";
  title?: string;
  notes?: string;
  /** The original action remains executable as a child of its new project. */
  preservedStepTitle?: string;
  /** Per-edge overrides; omitted dependencies map to the preserved action. */
  dependencyMappings?: Array<{ dependencyId: number; targetTaskId: number; sourceEndpoint: "task" | "dependsOnTask" }>;
  expectedDescendantRevisions?: Array<{ taskId: number; revision: number }>;
  activationResolution?: ProjectActivationResolution;
  expectedRevision?: number;
  /** Internal compound operations may add their own reviewed child graph before activation. */
  deferActivation?: boolean;
}

type TaskToStoryInvalidReason =
  | "not_root"
  | "inside_story"
  | "is_reference"
  | "unsupported_status"
  | "stale_descendant_snapshot"
  | "unsupported_obligation_mapping"
  | "invalid_dependency_mapping";

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
  return db.transaction((tx) =>
    convertTaskToStoryInTransaction(tx as unknown as Db, taskId, input, context),
  );
}

/** The existing guarded conversion, available to compound domain operations
 * that must commit conversion and its follow-up steps atomically. */
export function convertTaskToStoryInTransaction(
  txDb: Db,
  taskId: number,
  input: ConvertTaskToStoryInput,
  context?: MutationContext,
) {
    const task = getTaskOrThrow(txDb, taskId);
    assertExpectedRevision("task", taskId, task.revision, input.expectedRevision);
    const reject = (
      reason: TaskToStoryInvalidReason,
      message: string,
      details: Record<string, unknown> = {},
    ): never => {
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
    if (task.kind === "reference") {
      reject(
        "is_reference",
        "Reference material cannot be converted to a story. Use make-action first.",
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
    const externalWait = txDb
      .select()
      .from(schema.taskExternalWaits)
      .where(eq(schema.taskExternalWaits.taskId, taskId))
      .get();
    const dependencies = txDb
      .select()
      .from(schema.taskDependencies)
      .where(or(
        eq(schema.taskDependencies.taskId, taskId),
        eq(schema.taskDependencies.dependsOnTaskId, taskId),
      ))
      .all();
    const recurrenceOccurrences = txDb.select({ id: schema.taskRecurrenceOccurrences.id })
      .from(schema.taskRecurrenceOccurrences)
      .where(eq(schema.taskRecurrenceOccurrences.taskId, taskId))
      .all();
    const hasTaskOnlyObligation = externalWait !== undefined || task.revisitAt !== null ||
      dependencies.length > 0 || task.repeatAfterDays !== null ||
      task.allowedDeviationDays !== null || task.reminders.length > 0 ||
      recurrenceOccurrences.length > 0 || task.scheduledDate !== null || task.notBeforeAt != null || task.notBeforeDate != null ||
      task.additionalNextAction || task.availabilityRule !== null;
    if (externalWait && task.repeatAfterDays !== null) {
      reject("unsupported_obligation_mapping", "A task cannot carry both an external wait and recurrence.");
    }
    const preservedStepTitle = input.preservedStepTitle?.trim() || task.title;
    const mappingByDependency = new Map(
      (input.dependencyMappings ?? []).map((mapping) => [mapping.dependencyId, mapping.targetTaskId]),
    );
    if (mappingByDependency.size !== (input.dependencyMappings ?? []).length) {
      reject("invalid_dependency_mapping", "A dependency can only be mapped once.");
    }
    for (const mapping of input.dependencyMappings ?? []) {
      const dependency = dependencies.find((candidate) => candidate.id === mapping.dependencyId);
      if (!dependency) {
        reject("invalid_dependency_mapping", "A dependency changed before conversion.", { dependencyId: mapping.dependencyId });
      }
      const sourceEndpoint = dependency!.taskId === taskId ? "task" : "dependsOnTask";
      if (sourceEndpoint !== mapping.sourceEndpoint) {
        reject("stale_descendant_snapshot", "A dependency changed direction before conversion.", { dependencyId: mapping.dependencyId });
      }
    }
    const descendants = repoGetDescendantIds(txDb, taskId);
    if (input.expectedDescendantRevisions !== undefined) {
      const revisions = new Map(input.expectedDescendantRevisions.map(({ taskId: id, revision }) => [id, revision]));
      if (revisions.size !== input.expectedDescendantRevisions.length || revisions.size !== descendants.length) {
        reject("stale_descendant_snapshot", "The task outline changed. Reload it before converting.", {
          expectedTaskIds: descendants,
          suppliedTaskIds: [...revisions.keys()],
        });
      }
      const currentRows = txDb.select({ id: schema.workItems.id, revision: schema.workItems.revision })
        .from(schema.workItems).where(inArray(schema.workItems.id, descendants)).all();
      for (const row of currentRows) {
        if (revisions.get(row.id) !== row.revision) {
          throw AppError.conflict("stale_write_conflict", "A child task changed before conversion.", {
            entityType: "task", entityId: row.id,
            expectedRevision: revisions.get(row.id), currentRevision: row.revision,
          });
        }
      }
    }
    const eligibleTargets = txDb.select({ id: schema.workItems.id, taskKind: schema.workItems.taskKind, status: schema.workItems.status })
      .from(schema.workItems)
      .where(and(inArray(schema.workItems.id, descendants), eq(schema.workItems.role, "task")))
      .all()
      .filter((candidate) => candidate.taskKind === "action" && candidate.status !== "done" && candidate.status !== "cancelled");
    const preserveAsStep = hasTaskOnlyObligation || (!input.deferActivation && task.status === "actionable" && eligibleTargets.length === 0);
    for (const mapping of input.dependencyMappings ?? []) {
      if (!eligibleTargets.some((candidate) => candidate.id === mapping.targetTaskId)) {
        reject("invalid_dependency_mapping", "Dependencies can only be mapped to an open action inside the converted project.", {
          dependencyId: mapping.dependencyId,
          targetTaskId: mapping.targetTaskId,
        });
      }
    }
    if (preserveAsStep && !preservedStepTitle) {
      throw AppError.badRequest("task_title_required", "The preserved step title must not be empty.", { taskId });
    }

    const ownerMemberId =
      task.ownerInheritanceMode === "explicit" ? task.ownerMemberId : null;

    const executionCommitment = task.status === "actionable" ||
      hasExecutionCommitment({
        kind: task.kind,
        dueDate: task.dueDate,
        scheduledDate: task.scheduledDate,
        revisitAt: task.revisitAt,
        reminders: task.reminders,
      }) || task.repeatAfterDays !== null || task.allowedDeviationDays !== null;
    const targetStatus = executionCommitment || input.status === "active" ? "backlog" : input.status;

    txDb.update(schema.workItems)
      .set({
        role: "story",
        taskKind: null,
        parentId: null,
        title,
        notes: input.notes ?? task.notes,
        status: targetStatus,
        archivedAt: null,
        needsClarification: false,
        ownerMemberId,
        scheduledDate: null,
        availabilityRule: null,
        revisitAt: externalWait ? null : task.revisitAt,
        notBeforeAt: null,
        notBeforeDate: null,
        priority: null,
        size: null,
        additionalNextAction: false,
        completedAt: null,
        cancelledAt: null,
        recurrenceRuleLegacy: null,
        repeatAfterDays: null,
        allowedDeviationDays: null,
        revision: sql`${schema.workItems.revision} + 1`,
        updatedAt: nowIso(),
      })
      .where(eq(schema.workItems.id, taskId))
      .run();

    const project = getProjectOrThrow(txDb, taskId);
    let preservedStepId: number | null = null;
    if (preserveAsStep) {
      const reminderNeedsDeadline = task.reminders.some((reminder) => reminder.kind === "deadline_relative");
      const explicitPhysicalContexts = task.contextInheritanceMode === "explicit"
        ? txDb.select({ contextId: schema.workItemPhysicalContexts.contextId })
          .from(schema.workItemPhysicalContexts)
          .where(eq(schema.workItemPhysicalContexts.workItemId, taskId))
          .all()
        : [];
      const preserved = insertTaskRow(txDb, {
        parentId: project.id,
        title: preservedStepTitle,
        notes: task.notes,
        status: "actionable",
        scope: task.scope,
        ownerMemberId: task.ownerInheritanceMode === "explicit" ? task.ownerMemberId : null,
        ownerInheritanceMode: task.ownerInheritanceMode === "explicit" ? "explicit" : task.ownerInheritanceMode,
        physicalContextInheritanceMode: task.contextInheritanceMode,
        dueDate: reminderNeedsDeadline || task.repeatAfterDays !== null ? task.dueDate : null,
        scheduledDate: task.scheduledDate,
        availabilityRule: task.availabilityRule,
        revisitAt: task.revisitAt,
        notBeforeAt: task.notBeforeAt,
        notBeforeDate: task.notBeforeDate,
        priority: task.priority,
        size: task.size,
        repeatAfterDays: task.repeatAfterDays,
        allowedDeviationDays: task.allowedDeviationDays,
        additionalNextAction: task.additionalNextAction,
        position: nextPositionForGroup(txDb, null, project.id),
      });
      preservedStepId = preserved.id;
      if (explicitPhysicalContexts.length > 0) {
        txDb.insert(schema.workItemPhysicalContexts).values(
          explicitPhysicalContexts.map(({ contextId }) => ({
            workItemId: preserved.id,
            contextId,
          })),
        ).run();
      }
      txDb.update(schema.taskReminders)
        .set({ taskId: preserved.id, updatedAt: nowIso() })
        .where(eq(schema.taskReminders.taskId, taskId))
        .run();
      if (externalWait) {
        txDb.update(schema.taskExternalWaits)
          .set({ taskId: preserved.id, updatedAt: nowIso() })
          .where(eq(schema.taskExternalWaits.taskId, taskId))
          .run();
      }
      txDb.update(schema.taskRecurrenceOccurrences)
        .set({ taskId: preserved.id })
        .where(eq(schema.taskRecurrenceOccurrences.taskId, taskId))
        .run();
      txDb.update(schema.notificationEvents)
        .set({ entityId: preserved.id })
        .where(and(
          eq(schema.notificationEvents.entityType, "task"),
          eq(schema.notificationEvents.entityId, taskId),
          eq(schema.notificationEvents.kind, "task_reminder"),
        ))
        .run();
      recordActivity(txDb, {
        actorMemberId: actor(context),
        kind: "task_created",
        entityType: "task",
        entityTitle: preserved.title,
        taskId: preserved.id,
        projectId: project.id,
        metadata: { relatedTaskIds: [taskId] },
      });
    }

    const defaultDependencyTargetId = preservedStepId;
    for (const dependency of dependencies) {
      const targetId = mappingByDependency.get(dependency.id) ?? defaultDependencyTargetId;
      if (targetId === null || targetId === undefined) {
        reject("invalid_dependency_mapping", "An action step is required to preserve this dependency.", { dependencyId: dependency.id });
      }
      const resolvedTargetId = targetId as number;
      const nextTaskId = dependency.taskId === taskId ? resolvedTargetId : dependency.taskId;
      const nextDependsOnTaskId = dependency.dependsOnTaskId === taskId ? resolvedTargetId : dependency.dependsOnTaskId;
      if (nextTaskId === nextDependsOnTaskId) {
        reject("invalid_dependency_mapping", "This mapping would make the task depend on itself.", { dependencyId: dependency.id });
      }
      txDb.update(schema.taskDependencies)
        .set({ taskId: nextTaskId, dependsOnTaskId: nextDependsOnTaskId })
        .where(eq(schema.taskDependencies.id, dependency.id))
        .run();
    }
    if (preservedStepId !== null) {
      const created = txDb.select().from(schema.workItems).where(eq(schema.workItems.id, preservedStepId)).get();
      if (!created) reject("unsupported_obligation_mapping", "The preserved step could not be loaded.");
      const hasCycle = hasDependencyCycle(txDb);
      if (hasCycle) reject("invalid_dependency_mapping", "This mapping would create a dependency cycle.");
    }

    txDb.update(schema.workItems)
      .set({
        scheduledDate: null,
        notBeforeAt: null,
        notBeforeDate: null,
        priority: null,
        size: null,
        repeatAfterDays: null,
        allowedDeviationDays: null,
        reminderAt: null,
        additionalNextAction: false,
      })
      .where(eq(schema.workItems.id, taskId))
      .run();
    if (!input.deferActivation && (executionCommitment || input.status === "active")) {
      try {
        const activationResolution = input.activationResolution
          ? {
              ...input.activationResolution,
              expectedProjects: input.activationResolution.expectedProjects.map((entry) =>
                entry.projectId === taskId && entry.revision === task.revision
                  ? { ...entry, revision: task.revision + 1 }
                  : entry,
              ),
            }
          : undefined;
        activateCommittedProjectChain(txDb, project.id, context, activationResolution);
      } catch (error) {
        if (error instanceof AppError && error.code === "project_commitment_resolution_required") {
          const details = error.details as Record<string, unknown> | undefined;
          if (details && Array.isArray(details.expectedProjects)) {
            details.expectedProjects = (details.expectedProjects as Array<{ projectId: number; revision: number }>).map((entry) =>
              entry.projectId === taskId ? { ...entry, revision: task.revision } : entry,
            );
            if (details.targetRevision === task.revision + 1) details.targetRevision = task.revision;
          }
        }
        throw error;
      }
    }
    txDb.update(schema.notificationEvents)
      .set({ entityType: "project" })
      .where(
        and(
          eq(schema.notificationEvents.entityType, "task"),
          eq(schema.notificationEvents.entityId, taskId),
          ne(schema.notificationEvents.kind, "task_reminder"),
        ),
      )
      .run();
    txDb.update(schema.contributionEvents)
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
    return project;
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
    if (project.parentId !== null) {
      throw AppError.conflict(
        "role_conversion_invalid",
        "A nested project cannot be converted to a standalone task.",
        { projectId, reason: "nested_project" },
      );
    }
    const descendants = repoGetDescendantIds(txDb, projectId);
    const nestedProject = descendants.length > 0
      ? txDb.select({ id: schema.workItems.id })
          .from(schema.workItems)
          .where(and(inArray(schema.workItems.id, descendants), eq(schema.workItems.role, "story")))
          .get()
      : undefined;
    if (nestedProject) {
      throw AppError.conflict(
        "role_conversion_invalid",
        "A project containing a nested project cannot be converted into a task.",
        { projectId, reason: "nested_projects" },
      );
    }
    const sourceRow = txDb.select().from(schema.workItems).where(eq(schema.workItems.id, projectId)).get()!;
    const externalWait = txDb.select().from(schema.taskExternalWaits)
      .where(eq(schema.taskExternalWaits.taskId, projectId)).get();
    if (project.status === "archived") {
      throw AppError.conflict(
        "role_conversion_invalid",
        "Restore an archived project before converting it into a task.",
        { projectId, reason: "archived_status_requires_restore" },
      );
    }
    if (externalWait && sourceRow.repeatAfterDays !== null) {
      throw AppError.conflict(
        "role_conversion_invalid",
        "Resolve the external wait or recurrence before converting this project.",
        { projectId, reason: "incompatible_wait_and_recurrence" },
      );
    }
    if (sourceRow.repeatAfterDays !== null && descendants.length > 0) {
      throw AppError.conflict(
        "role_conversion_invalid",
        "A recurring project cannot be converted while it has subtasks.",
        { projectId, reason: "recurrence_requires_leaf_task" },
      );
    }
    if (project.status === "completed" && sourceRow.repeatAfterDays !== null) {
      throw AppError.conflict(
        "role_conversion_invalid",
        "A completed project cannot become a completed recurrence occurrence.",
        { projectId, reason: "completed_recurrence_mapping_unsupported" },
      );
    }
    if (project.status === "completed") assertAcceptanceCriteriaChecked(txDb, projectId, "project");
    const title = input.title?.trim() ?? project.title;
    if (title === "") {
      throw AppError.badRequest(
        "task_title_required",
        "The task title must not be empty.",
      );
    }
    const mappedStatus: TaskStatus =
      project.status === "active"
        ? "actionable"
        : project.status === "completed"
          ? "done"
          : "someday";
    const executionCommitment = hasExecutionCommitment({
      kind: "action",
      dueDate: project.dueDate,
      scheduledDate: project.scheduledDate,
      revisitAt: project.revisitAt,
      reminders: txDb.select({ id: schema.taskReminders.id })
        .from(schema.taskReminders)
        .where(eq(schema.taskReminders.taskId, projectId))
        .all(),
    }) || sourceRow.repeatAfterDays !== null;
    const status = project.status === "backlog" && executionCommitment
      ? "actionable"
      : mappedStatus;
    const position = nextPositionForGroup(txDb, null, null);

    // A backlog project parks its ordinary open outline. When its root becomes
    // a Someday task, keep that effective state for unplanned descendants too;
    // concrete dates, reminders, recurrence and external waits remain active.
    if (project.status === "backlog" && status === "someday" && descendants.length > 0) {
      const descendantRows = txDb.select().from(schema.workItems)
        .where(and(inArray(schema.workItems.id, descendants), eq(schema.workItems.role, "task")))
        .all();
      const remindersByTask = new Map<number, typeof schema.taskReminders.$inferSelect[]>();
      for (const reminder of txDb.select().from(schema.taskReminders)
        .where(inArray(schema.taskReminders.taskId, descendants)).all()) {
        const rows = remindersByTask.get(reminder.taskId) ?? [];
        rows.push(reminder);
        remindersByTask.set(reminder.taskId, rows);
      }
      const externalWaitTaskIds = new Set(txDb.select({ taskId: schema.taskExternalWaits.taskId })
        .from(schema.taskExternalWaits)
        .where(inArray(schema.taskExternalWaits.taskId, descendants))
        .all()
        .map(({ taskId }) => taskId));
      for (const child of descendantRows) {
        if (child.status !== storedTaskStatus("actionable") || child.taskKind !== "action") continue;
        const keepsCommitment = hasExecutionCommitment({
          kind: "action",
          dueDate: child.dueDate,
          scheduledDate: child.scheduledDate,
          revisitAt: child.revisitAt,
          reminders: remindersByTask.get(child.id) ?? [],
        }) || child.repeatAfterDays !== null || externalWaitTaskIds.has(child.id) || child.additionalNextAction;
        if (keepsCommitment) continue;
        txDb.update(schema.workItems)
          .set({ status: storedTaskStatus("someday"), revision: sql`${schema.workItems.revision} + 1`, updatedAt: nowIso() })
          .where(eq(schema.workItems.id, child.id))
          .run();
        recordActivity(txDb, {
          actorMemberId: actor(context),
          kind: "task_status_changed",
          entityType: "task",
          entityTitle: child.title,
          taskId: child.id,
          metadata: { changedFields: ["status"], before: { status: "actionable" }, after: { status: "someday" } },
        });
      }
    }

    tx.update(schema.workItems)
      .set({
        role: "task",
        taskKind: "action",
        parentId: null,
        title,
        notes: input.notes ?? project.notes,
        status: taskStatusToStored(status),
        archivedAt: null,
        needsClarification: false,
        ownerMemberId: project.ownerMemberId,
        ownerInheritanceMode: project.ownerMemberId !== null ? "explicit" : "none",
        scheduledDate: project.scheduledDate,
        availabilityRule: null,
        revisitAt: project.revisitAt,
        position,
        completedAt: status === "done" ? sourceRow.completedAt : null,
        revision: sql`${schema.workItems.revision} + 1`,
        updatedAt: nowIso(),
      })
      .where(eq(schema.workItems.id, projectId))
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

// ---------------------------------------------------------------------------
// Reference -> action promotion
// ---------------------------------------------------------------------------

export interface MakeTaskActionInput {
  expectedRevision?: number;
}

/**
 * Promotes a `kind: "reference"` outline node to a real `kind: "action"`
 * task in place: same row/id, same parent/project/position/children/notes/
 * Paperless references, just a `taskKind`/`status` change plus a revision
 * bump. This mirrors `convertTaskToStory`/`convertStoryToTask`'s established
 * single-UPDATE-in-a-transaction pattern; unlike those, the entity type
 * ("task") never changes here, so activity/notification/contribution rows
 * never need reassigning.
 */
export function makeTaskAction(
  db: Db,
  taskId: number,
  input: MakeTaskActionInput = {},
  context?: MutationContext,
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const task = getTaskOrThrow(txDb, taskId);
    assertExpectedRevision("task", taskId, task.revision, input.expectedRevision);
    if (task.kind !== "reference") {
      throw AppError.conflict(
        "reference_promotion_invalid",
        "Only reference material can be promoted to an action.",
        { taskId, reason: "not_reference" },
      );
    }
    // Mirrors `insertTask`'s root-vs-filed default: a root standalone item
    // starts in the inbox (captured), while an item already filed under a
    // project/parent becomes a regular actionable task straight away.
    const isRoot = task.parentTaskId === null && task.projectId === null;
    const nextStatus: TaskStatus = isRoot ? "captured" : "actionable";

    const hadNextAction =
      task.projectId !== null ? projectHasNextAction(txDb, task.projectId) : true;
    const hadTaskPlan =
      task.projectId !== null ? projectHasTaskPlan(txDb, task.projectId) : true;

    tx.update(schema.workItems)
      .set({
        taskKind: "action",
        status: taskStatusToStored(nextStatus),
        needsClarification: nextStatus === "captured",
        revision: sql`${schema.workItems.revision} + 1`,
        updatedAt: nowIso(),
      })
      .where(eq(schema.workItems.id, taskId))
      .run();

    const updated = getTaskOrThrow(txDb, taskId);
    const activityEventId = recordActivity(txDb, {
      actorMemberId: actor(context),
      kind: "task_kind_changed",
      entityType: "task",
      entityTitle: updated.title,
      taskId,
      projectId: updated.projectId,
      metadata: { changedFields: ["kind"] },
    });
    if (
      updated.projectId !== null &&
      !hadNextAction &&
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
      !hadTaskPlan &&
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
    return updated;
  });
}
