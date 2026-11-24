import type { Db } from "../db/client.js";
import { AppError } from "../errors.js";
import { convertTaskToStory } from "../domain/roleConversion.js";
import { getTaskOrThrow } from "../domain/taskCrud.js";
import type { MutationContext } from "../domain/workItemShared.js";

export interface CommitmentConversion {
  projectId: number;
  projectRevision: number;
}

/** Convert an AI-selected standalone task to a backlog project. */
export function beginCommitmentConversion(
  db: Db,
  taskId: number,
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

  const project = convertTaskToStory(db, taskId, {
    status: "backlog",
    expectedRevision: task.revision,
  }, context);
  return { projectId: project.id, projectRevision: project.revision };
}
