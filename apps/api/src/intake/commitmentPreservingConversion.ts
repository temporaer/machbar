import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { AppError } from "../errors.js";
import { activateProject } from "../domain/storyWorkflow.js";
import { updateProject } from "../domain/storyCrud.js";
import { convertTaskToStory } from "../domain/roleConversion.js";
import { getTaskOrThrow } from "../domain/taskCrud.js";
import type { MutationContext } from "../domain/workItemShared.js";

export interface CommitmentConversion {
  sourceStatus: "captured" | "actionable" | "someday";
  projectId: number;
  projectRevision: number;
  driverMemberId: number | null;
}

/**
 * Convert an AI-selected standalone task through a temporary backlog state.
 * Actionable sources are activated only by finishCommitmentConversion after
 * accepted children have been applied and readiness can be evaluated.
 */
export function beginCommitmentConversion(
  db: Db,
  taskId: number,
  projectDriverMemberId: number | undefined,
  viewerMemberId: number | null,
  context: MutationContext,
): CommitmentConversion {
  const task = getTaskOrThrow(db, taskId);
  if (
    task.status === "actionable" &&
    (task.revisitAt != null || task.notBeforeAt != null || task.notBeforeDate != null)
  ) {
    throw AppError.conflict(
      "role_conversion_invalid",
      "Resolve the task's revisit or availability before converting it with AI.",
      { taskId, reason: "non_representable_timing" },
    );
  }
  if (task.parentTaskId !== null || task.projectId !== null) {
    throw AppError.conflict(
      "role_conversion_invalid",
      "Only standalone tasks can be converted into projects with AI.",
      { taskId, reason: "nested_task" },
    );
  }

  const sourceStatus = task.status as CommitmentConversion["sourceStatus"];
  const existingDriver = task.ownerInheritanceMode === "explicit" ? task.ownerMemberId : null;
  let driverMemberId = existingDriver;
  if (sourceStatus === "actionable") {
    if (existingDriver !== null && projectDriverMemberId !== undefined && projectDriverMemberId !== existingDriver) {
      throw AppError.conflict("project_driver_required", "The existing project driver must be preserved.", { taskId });
    }
    driverMemberId = existingDriver ?? projectDriverMemberId ?? null;
    if (driverMemberId === null) {
      throw AppError.conflict(
        "project_driver_required",
        "Choose who is accountable for this project's outcome before applying the conversion.",
        { taskId },
      );
    }
  }

  const member = db.select({ id: schema.members.id }).from(schema.members)
    .where(eq(schema.members.id, driverMemberId ?? -1)).get();
  if (driverMemberId !== null && !member) {
    throw AppError.badRequest("member_not_found", "The selected project driver was not found.", { memberId: driverMemberId });
  }
  if (sourceStatus === "actionable" && task.scope === "work" && driverMemberId !== viewerMemberId) {
    throw AppError.forbidden("project_driver_required", "Only the authorized work owner can drive this project.", { taskId });
  }

  const project = convertTaskToStory(db, taskId, {
    status: "backlog",
    expectedRevision: task.revision,
    preserveScheduledDate: true,
  }, context);
  let projectRevision = project.revision;
  if (driverMemberId !== null && project.ownerMemberId !== driverMemberId) {
    const updated = updateProject(db, project.id, {
      ownerMemberId: driverMemberId,
      expectedRevision: projectRevision,
    }, context);
    projectRevision = updated.revision;
  }
  return { sourceStatus, projectId: project.id, projectRevision, driverMemberId };
}

export function finishCommitmentConversion(
  db: Db,
  conversion: CommitmentConversion,
  context: MutationContext,
) {
  if (conversion.sourceStatus !== "actionable") {
    return;
  }
  activateProject(db, conversion.projectId, {
    ownerMemberId: conversion.driverMemberId,
    expectedRevision: conversion.projectRevision,
  }, context);
}
