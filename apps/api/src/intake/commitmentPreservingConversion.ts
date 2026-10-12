import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { AppError } from "../errors.js";
import { activateCommittedProjectChain } from "../domain/commitmentActivation.js";
import { updateProject } from "../domain/storyCrud.js";
import { convertTaskToStory } from "../domain/roleConversion.js";
import { getTaskOrThrow } from "../domain/taskCrud.js";
import { hasExecutionCommitment } from "../domain/commitmentTransition.js";
import type { MutationContext } from "../domain/workItemShared.js";

export interface CommitmentConversion {
  sourceStatus: "captured" | "actionable" | "someday";
  requiresActivation: boolean;
  projectId: number;
  projectRevision: number;
  driverMemberId: number | null;
}

/**
 * Convert an AI-selected standalone task through a temporary backlog state.
 * Activation follows the obligations in the accepted resulting graph, not
 * only the source lifecycle status. The caller supplies whether accepted new
 * work adds an execution commitment; source commitments are checked here.
 */
export function beginCommitmentConversion(
  db: Db,
  taskId: number,
  projectDriverMemberId: number | undefined,
  additionalExecutionCommitment: boolean,
  viewerMemberId: number | null,
  context: MutationContext,
): CommitmentConversion {
  const task = getTaskOrThrow(db, taskId);
  if (task.parentTaskId !== null || task.projectId !== null) {
    throw AppError.conflict(
      "role_conversion_invalid",
      "Only standalone tasks can be converted into projects with AI.",
      { taskId, reason: "nested_task" },
    );
  }

  const sourceStatus = task.status as CommitmentConversion["sourceStatus"];
  const requiresActivation = sourceStatus === "actionable" || additionalExecutionCommitment || hasExecutionCommitment({
    kind: task.kind,
    dueDate: task.dueDate,
    scheduledDate: task.scheduledDate,
    revisitAt: task.revisitAt,
    reminders: task.reminders,
  });
  const existingDriver = task.ownerInheritanceMode === "explicit" ? task.ownerMemberId : null;
  let driverMemberId = existingDriver;
  if (requiresActivation) {
    if (existingDriver !== null && projectDriverMemberId !== undefined && projectDriverMemberId !== existingDriver) {
      throw AppError.conflict("project_driver_required", "The existing project driver must be preserved.", { taskId });
    }
    driverMemberId = existingDriver ?? projectDriverMemberId ?? null;
  }

  const member = db.select({ id: schema.members.id }).from(schema.members)
    .where(eq(schema.members.id, driverMemberId ?? -1)).get();
  if (driverMemberId !== null && !member) {
    throw AppError.badRequest("member_not_found", "The selected project driver was not found.", { memberId: driverMemberId });
  }
  if (requiresActivation && driverMemberId !== null && task.scope === "work" && driverMemberId !== viewerMemberId) {
    throw AppError.forbidden("project_driver_required", "Only the authorized work owner can drive this project.", { taskId });
  }

  const project = convertTaskToStory(db, taskId, {
    status: "backlog",
    expectedRevision: task.revision,
    deferActivation: true,
  }, context);
  let projectRevision = project.revision;
  if (driverMemberId !== null && project.ownerMemberId !== driverMemberId) {
    const updated = updateProject(db, project.id, {
      ownerMemberId: driverMemberId,
      expectedRevision: projectRevision,
    }, context);
    projectRevision = updated.revision;
  }
  return { sourceStatus, requiresActivation, projectId: project.id, projectRevision, driverMemberId };
}

export function finishCommitmentConversion(
  db: Db,
  conversion: CommitmentConversion,
  context: MutationContext,
) {
  if (!conversion.requiresActivation) {
    return;
  }
  const project = db.select({ status: schema.workItems.status })
    .from(schema.workItems).where(eq(schema.workItems.id, conversion.projectId)).get();
  if (project?.status !== "backlog") return;
  // Use the canonical commitment transition so missing-driver/progress-path
  // decisions include the server's current requirements and roll back the
  // entire conversion when they are unresolved.
  activateCommittedProjectChain(db, conversion.projectId, context);
}
