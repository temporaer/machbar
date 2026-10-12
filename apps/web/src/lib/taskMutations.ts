import type { InheritanceMode, Task } from "@machbar/shared";
import { api } from "./api";
import type { UpdateTaskInput } from "./api";

interface RevisionedTask {
  id: number;
  revision: number;
}

export function setOwnerInheritance(
  ownerInheritanceMode: InheritanceMode,
): {
  ownerMemberId: null;
  ownerInheritanceMode: InheritanceMode;
} {
  return {
    ownerMemberId: null,
    ownerInheritanceMode,
  };
}

export function ownerAssignmentPatch(
  ownerMemberId: number | null,
  ownerInheritanceMode: InheritanceMode = ownerMemberId === null ? "none" : "explicit",
): {
  ownerMemberId: number | null;
  ownerInheritanceMode: InheritanceMode;
} {
  return {
    ownerMemberId,
    ownerInheritanceMode,
  };
}

export function updateTask(
  task: RevisionedTask,
  patch: UpdateTaskInput,
) {
  return api.updateTask(task.id, {
    ...patch,
    expectedRevision: task.revision,
  });
}

/** Refresh only the optimistic revision after a stale-write response. Callers
 * keep their local edit draft and can offer an explicit retry in the same UI. */
export async function refreshTaskAfterConflict(
  error: unknown,
  taskId: number,
): Promise<Task | null> {
  if (!(error instanceof Error) || (error as Error & { code?: unknown }).code !== "stale_write_conflict") {
    return null;
  }
  try {
    return await api.getTask(taskId);
  } catch {
    return null;
  }
}
