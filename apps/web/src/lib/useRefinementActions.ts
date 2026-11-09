import { useCallback } from "react";
import type { InheritanceMode, TaskSize } from "@machbar/shared";
import type { RefinementTaskRow } from "./api";
import { nextSizeInCycle } from "./refinementHelpers";
import { ownerAssignmentPatch } from "./taskMutations";
import { useTaskActions } from "./useTaskActions";

export type RefinementListItem = RefinementTaskRow;

export function useRefinementActions() {
  const { update, pendingIds, isPending, errors, clearError } = useTaskActions();
  const setSize = useCallback((task: RefinementListItem, size: TaskSize | null) =>
    update(task, { size }), [update]);
  const cycleSize = useCallback((task: RefinementListItem) => setSize(task, nextSizeInCycle(task.size)), [setSize]);
  const clearSize = useCallback((task: RefinementListItem) => setSize(task, null), [setSize]);
  const assignOwner = useCallback((
    task: RefinementListItem, ownerMemberId: number | null,
    ownerInheritanceMode: InheritanceMode = ownerMemberId === null ? "none" : "explicit",
    companionPatch: { title?: string } = {},
  ) => update(task, { ...ownerAssignmentPatch(ownerMemberId, ownerInheritanceMode), ...companionPatch }, true), [update]);
  return { pendingIds, isPending, errors, clearError, setSize, cycleSize, clearSize, assignOwner };
}
