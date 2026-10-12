import { and, eq } from "drizzle-orm";
import type { ProjectActivationResolution, TaskStatus } from "@machbar/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { AppError } from "../errors.js";
import { activateCommittedProjectChain } from "./commitmentActivation.js";
import { hasExecutionCommitment } from "./commitmentTransition.js";
import { getTaskOrThrow, createChildTaskInTransaction, createTaskInTransaction } from "./taskCrud.js";
import { convertTaskToStoryInTransaction } from "./roleConversion.js";
import type { MutationContext } from "./workItemShared.js";

export interface StepBatchItem {
  title: string;
  dueDate?: string | null;
  scheduledDate?: string | null;
}

export interface StepBatchInput {
  steps: StepBatchItem[];
  createdByMemberId?: number | null;
  /** Revision of the task parent or project destination selected by the user. */
  expectedRevision: number;
  /** Complete containing-project chain, including a project destination itself. */
  expectedProjectRevisions: Array<{ projectId: number; revision: number }>;
  /** Only supported for an open, standalone task through the existing conversion guard. */
  convertParentToProject?: boolean;
  activationResolution?: ProjectActivationResolution;
}

export interface StepBatchResult {
  tasks: ReturnType<typeof getTaskOrThrow>[];
  convertedProjectId: number | null;
}

function projectChainRevisions(db: Db, projectId: number | null) {
  const projects: Array<{ id: number; revision: number; parentId: number | null }> = [];
  const seen = new Set<number>();
  let current = projectId;
  while (current !== null) {
    if (seen.has(current)) {
      throw AppError.conflict("project_transition_invalid", "The project hierarchy contains a cycle.", { projectId: current });
    }
    seen.add(current);
    const row = db.select({
      id: schema.workItems.id,
      revision: schema.workItems.revision,
      parentId: schema.workItems.parentId,
    }).from(schema.workItems)
      .where(and(eq(schema.workItems.id, current), eq(schema.workItems.role, "story")))
      .get();
    if (!row) throw AppError.notFound("project_not_found", "The project was not found.", { projectId: current });
    projects.push(row);
    current = row.parentId;
  }
  return projects;
}

function assertProjectChainRevisions(
  db: Db,
  projectId: number | null,
  expected: StepBatchInput["expectedProjectRevisions"],
) {
  const current = projectChainRevisions(db, projectId);
  const expectedById = new Map(expected.map((entry) => [entry.projectId, entry.revision]));
  const matches = expectedById.size === expected.length && expectedById.size === current.length &&
    current.every((project) => expectedById.get(project.id) === project.revision);
  if (!matches) {
    const changed = current.find((project) => expectedById.get(project.id) !== project.revision) ?? current[0];
    throw AppError.conflict(
      "stale_write_conflict",
      "The destination project structure changed. Review the preserved step draft and try again.",
      changed
        ? { entityType: "project", entityId: changed.id, expectedRevision: expectedById.get(changed.id) ?? null, currentRevision: changed.revision }
        : { entityType: "project", reason: "project_chain_changed" },
    );
  }
}

function commitmentSubject(task: ReturnType<typeof getTaskOrThrow>) {
  return {
    type: "task" as const,
    id: task.id,
    status: task.status as TaskStatus,
    targetStatus: task.status as TaskStatus,
    executionCommitment: true,
    newExecutionCommitment: true,
    revisitAt: task.revisitAt,
    recurring: task.repeatAfterDays !== null,
    explicitlyReopened: false,
  };
}

function assertBatch(input: StepBatchInput): void {
  if (input.steps.length === 0 || input.steps.length > 30) {
    throw AppError.badRequest("task_step_batch_invalid", "Add between one and thirty steps.", { count: input.steps.length });
  }
  for (const [index, step] of input.steps.entries()) {
    if (step.title.trim() === "") {
      throw AppError.badRequest("task_title_required", "A step title must not be empty.", { index });
    }
  }
}

function createSteps(
  txDb: Db,
  input: StepBatchInput,
  context: MutationContext | undefined,
  destination: { type: "task"; id: number } | { type: "project"; id: number },
): StepBatchResult {
  assertBatch(input);
  let projectId: number | null;
  let convertedProjectId: number | null = null;
  let destinationTaskId: number | null = null;

  if (destination.type === "task") {
    const parent = getTaskOrThrow(txDb, destination.id);
    if (input.expectedRevision !== parent.revision) {
      throw AppError.conflict("stale_write_conflict", "The parent task changed. Review the preserved step draft and try again.", {
        entityType: "task", entityId: parent.id, expectedRevision: input.expectedRevision, currentRevision: parent.revision,
      });
    }
    destinationTaskId = parent.id;
    if (input.convertParentToProject) {
      const converted = convertTaskToStoryInTransaction(txDb, parent.id, {
        status: "backlog",
        expectedRevision: input.expectedRevision,
      }, context);
      convertedProjectId = converted.id;
      projectId = converted.id;
      assertProjectChainRevisions(txDb, null, input.expectedProjectRevisions);
    } else {
      projectId = parent.projectId;
      assertProjectChainRevisions(txDb, projectId, input.expectedProjectRevisions);
    }
  } else {
    const project = txDb.select({ id: schema.workItems.id, revision: schema.workItems.revision })
      .from(schema.workItems)
      .where(and(eq(schema.workItems.id, destination.id), eq(schema.workItems.role, "story")))
      .get();
    if (!project) throw AppError.notFound("project_not_found", "The project was not found.", { projectId: destination.id });
    if (input.expectedRevision !== project.revision) {
      throw AppError.conflict("stale_write_conflict", "The project changed. Review the preserved step draft and try again.", {
        entityType: "project", entityId: project.id, expectedRevision: input.expectedRevision, currentRevision: project.revision,
      });
    }
    projectId = project.id;
    assertProjectChainRevisions(txDb, project.id, input.expectedProjectRevisions);
  }

  const tasks = input.steps.map((step) => {
    const taskInput = {
      title: step.title.trim(),
      status: "actionable" as const,
      createdByMemberId: input.createdByMemberId,
      dueDate: step.dueDate ?? null,
      scheduledDate: step.scheduledDate ?? null,
    };
    return destinationTaskId !== null && convertedProjectId === null
      ? createChildTaskInTransaction(txDb, destinationTaskId, taskInput, context, { activateCommitment: false })
      : createTaskInTransaction(txDb, {
          ...taskInput,
          projectId,
        }, context, { activateCommitment: false });
  });

  const committedTask = tasks.find((task) => hasExecutionCommitment({
    kind: task.kind,
    dueDate: task.dueDate,
    scheduledDate: task.scheduledDate,
    revisitAt: task.revisitAt,
    reminders: task.reminders,
  }));
  if (committedTask?.projectId !== null && committedTask?.projectId !== undefined) {
    activateCommittedProjectChain(
      txDb,
      committedTask.projectId,
      context,
      input.activationResolution,
      commitmentSubject(committedTask),
    );
  }
  return { tasks, convertedProjectId };
}

/** Create task/project outline steps and all commitment-driven transitions atomically. */
export function createTaskStepBatchForTask(
  db: Db,
  parentTaskId: number,
  input: StepBatchInput,
  context?: MutationContext,
): StepBatchResult {
  return db.transaction((tx) => createSteps(tx as unknown as Db, input, context, { type: "task", id: parentTaskId }));
}

/** Create project-root steps atomically for the post-conversion handoff. */
export function createTaskStepBatchForProject(
  db: Db,
  projectId: number,
  input: StepBatchInput,
  context?: MutationContext,
): StepBatchResult {
  if (input.convertParentToProject) {
    throw AppError.badRequest("task_step_batch_invalid", "A project destination cannot be converted again.");
  }
  return db.transaction((tx) => createSteps(tx as unknown as Db, input, context, { type: "project", id: projectId }));
}
