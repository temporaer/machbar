import { useCallback } from "react";
import type { TaskSize } from "@machbar/shared";
import { api } from "./api";
import type { RefinementTaskRow } from "./api";
import {
  ownerAssignmentPatch,
  updateTask,
} from "./taskMutations";
import { RETENTION_MS, useRetainedMutations } from "./useRetainedMutations";

export type RefinementListItem = RefinementTaskRow;

/**
 * How long a refinement row whose size just changed keeps showing its new
 * size (optimistically, in place) before the underlying list is allowed to
 * refetch and regroup it into its new owner/size bucket. Same ~4s window
 * (and the same "defer the bump until it elapses" approach) as
 * `useTaskActions.ts::RETENTION_MS` — kept as an independent constant here
 * rather than imported, since this hook must not depend on the excluded
 * `useTaskActions.ts` file's internal shape.
 */
export const REFINEMENT_RETENTION_MS = RETENTION_MS;

/**
 * The size cycle a right-swipe on a refinement row performs:
 * unestimated -> S -> M -> L -> XL -> unestimated (wraps back to null
 * rather than sticking at XL), so repeatedly swiping the same row cycles
 * through every bucket predictably instead of getting stuck at one end.
 */
const SIZE_CYCLE: ReadonlyArray<TaskSize | null> = [null, "S", "M", "L", "XL"];

export function nextSizeInCycle(current: TaskSize | null): TaskSize | null {
  const index = SIZE_CYCLE.indexOf(current);
  const nextIndex = (index + 1) % SIZE_CYCLE.length;
  return SIZE_CYCLE[nextIndex] ?? null;
}

/**
 * Centralises refinement-row size mutations (swipe-cycle, direct
 * S/M/L/XL chips, and "clear"), each optimistic and each retained in place
 * for `REFINEMENT_RETENTION_MS` — mirroring `useTaskActions.ts`'s pattern
 * so a row whose size (and therefore owner×size matrix bucket) just changed
 * stays visible long enough for the regrouping to actually be seen, instead
 * of vanishing/jumping the instant the mutation resolves. The global
 * refresh (`bump()`) is deferred to fire exactly once retention elapses,
 * for the same reason `useTaskActions` defers it: an immediate refetch
 * could reorder/remove the very row whose optimistic state we just set.
 */
export function useRefinementActions() {
  const mutations = useRetainedMutations<RefinementListItem>();
  const { run, pendingIds, isPending, retained, errors, clearError } = mutations;

  const setSize = useCallback(
    (task: RefinementListItem, size: TaskSize | null) => {
      const optimistic: RefinementListItem = { ...task, size };
      return run({
        id: task.id,
        optimistic,
        mutate: () => updateTask(task, { size }),
        confirmed: (confirmed) => ({ ...task, ...confirmed, size }),
      });
    },
    [run],
  );

  const cycleSize = useCallback(
    (task: RefinementListItem) => setSize(task, nextSizeInCycle(task.size)),
    [setSize],
  );

  const clearSize = useCallback((task: RefinementListItem) => setSize(task, null), [setSize]);

  /**
   * Assigns (or clears) the responsible member from the row's own focused
   * shared member picker, without ever opening the full task editor. Uses the
   * same optimistic-retain treatment as a size change, since the owner is
   * the matrix's *other* axis: the row would otherwise jump to a different
   * owner bucket (or vanish behind an owner filter) the instant the patch
   * resolves.
   */
  const assignOwner = useCallback(
    (task: RefinementListItem, ownerMemberId: number | null) => {
      const optimistic: RefinementListItem = {
        ...task,
        effectiveOwnerId: ownerMemberId,
        effectiveOwnerSource: ownerMemberId === null ? "none" : "task",
      };
      return run({
        id: task.id,
        optimistic,
        mutate: () =>
          updateTask(task, ownerAssignmentPatch(ownerMemberId)),
        confirmed: (confirmed) => ({
          ...task,
          ...confirmed,
          effectiveOwnerId: ownerMemberId,
          effectiveOwnerSource: ownerMemberId === null ? "none" : "task",
        }),
        throwOnError: true,
      });
    },
    [run],
  );

  return {
    pendingIds,
    isPending,
    retained,
    errors,
    clearError,
    setSize,
    cycleSize,
    clearSize,
    assignOwner,
  };
}
