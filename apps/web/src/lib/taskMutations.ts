import type { InheritanceMode } from "@machbar/shared";
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
