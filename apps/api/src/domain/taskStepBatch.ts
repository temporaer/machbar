import { and, eq } from "drizzle-orm";
import type { TaskStatus } from "@machbar/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { AppError } from "../errors.js";
import {
  getTaskOrThrow,
  createChildTaskInTransaction,
  createTaskInTransaction,
  type ChildTaskBatchState,
  type TaskCreationFacts,
} from "./taskCrud.js";
import { convertTaskToStoryInTransaction } from "./roleConversion.js";
import { projectHasNextAction, projectHasTaskPlan } from "./workItemShared.js";
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
  /** Only supported for an open, standalone task through the existing conversion guard. */
  convertParentToProject?: boolean;
}

export interface StepBatchResult {
  tasks: TaskCreationFacts[];
  convertedProjectId: number | null;
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
  let childStatus: TaskStatus = "actionable";
  let childBatchState: ChildTaskBatchState | undefined;

  if (destination.type === "task") {
    const parent = getTaskOrThrow(txDb, destination.id);
    if (input.expectedRevision !== parent.revision) {
      throw AppError.conflict("stale_write_conflict", "The parent task changed. Review the preserved step draft and try again.", {
        entityType: "task", entityId: parent.id, expectedRevision: input.expectedRevision, currentRevision: parent.revision,
      });
    }
    destinationTaskId = parent.id;
    childStatus = parent.status === "someday" ? "someday" : "actionable";
    if (input.convertParentToProject) {
      const converted = convertTaskToStoryInTransaction(txDb, parent.id, {
        status: "backlog",
        expectedRevision: input.expectedRevision,
      }, context);
      convertedProjectId = converted.id;
      projectId = converted.id;
    } else {
      projectId = parent.projectId;
      const existingChildren = txDb.select({
        role: schema.workItems.role,
        taskKind: schema.workItems.taskKind,
        status: schema.workItems.status,
        position: schema.workItems.position,
      }).from(schema.workItems)
        .where(eq(schema.workItems.parentId, parent.id))
        .all();
      childBatchState = {
        parent,
        nextPosition: existingChildren.reduce((max, child) => Math.max(max, child.position), -1) + 1,
        hasActionChild: existingChildren.some((child) =>
          child.role === "task" && child.taskKind === "action"
        ),
        hasOpenActionChild: existingChildren.some((child) =>
          child.role === "task" &&
          child.taskKind === "action" &&
          child.status !== "done" &&
          child.status !== "cancelled"
        ),
        hasNextAction: projectId === null ? true : projectHasNextAction(txDb, projectId),
        hasTaskPlan: projectId === null ? true : projectHasTaskPlan(txDb, projectId),
      };
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
  }

  const tasks = input.steps.map((step) => {
    const taskInput = {
      title: step.title.trim(),
      status: childStatus,
      createdByMemberId: input.createdByMemberId,
      dueDate: step.dueDate ?? null,
      scheduledDate: step.scheduledDate ?? null,
    };
    return destinationTaskId !== null && convertedProjectId === null
      ? createChildTaskInTransaction(txDb, destinationTaskId, taskInput, context, {
          batchState: childBatchState!,
        })
      : createTaskInTransaction(txDb, {
          ...taskInput,
          projectId,
        }, context);
  });

  return { tasks, convertedProjectId };
}

/** Create task/project outline steps atomically. */
export function createTaskStepBatchForTask(
  db: Db,
  parentTaskId: number,
  input: StepBatchInput,
  context?: MutationContext,
): StepBatchResult {
  return db.transaction((tx) => createSteps(tx as unknown as Db, input, context, { type: "task", id: parentTaskId }));
}

/** Create project-root steps atomically for explicit project task entry. */
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
