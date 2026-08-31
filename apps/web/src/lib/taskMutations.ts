import type { InheritanceMode } from "@machbar/shared";
import { api } from "./api";
import type { UpdateTaskInput } from "./api";

interface RevisionedTask {
  id: number;
  revision: number;
}

export function ownerAssignmentPatch(ownerMemberId: number | null): {
  ownerMemberId: number | null;
  ownerInheritanceMode: InheritanceMode;
} {
  return {
    ownerMemberId,
    ownerInheritanceMode: ownerMemberId === null ? "none" : "explicit",
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
