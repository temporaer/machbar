import { useCallback, useEffect, useRef, useState } from "react";
import type { Tag, TaskSize } from "@machbar/shared";
import { api } from "./api";
import type { RefinementTaskRow } from "./api";
import { useRefresh } from "./refresh";
import { useStrings } from "./strings";
import type { Strings } from "./strings";
import {
  isStaleWriteConflict,
  localizedErrorMessage,
} from "./errorMessage";

/**
 * `GET /api/refinement/tasks` (see `api.ts::getRefinementTasks` /
 * `apps/api/src/repo/refinementRepo.ts::RefinementTaskRow`) doesn't carry
 * `blocked`/`waitingFor` — those live on the full `Task` contract returned
 * by e.g. `api.searchTasks`. `RefinementPage` merges them in by task id
 * (the same "fetch everything, no filters" technique `SearchPage` already
 * uses) so the list/row can still show blocked/waiting context. Declared
 * here (not backend-mirrored) so the page, this hook, and
 * `RefinementTaskRow` all share one shape.
 */
export interface RefinementListItem extends RefinementTaskRow {
  blocked: boolean;
  waitingFor: string | null;
  effectiveTags: Tag[];
}

/**
 * How long a refinement row whose size just changed keeps showing its new
 * size (optimistically, in place) before the underlying list is allowed to
 * refetch and regroup it into its new owner/size bucket. Same ~4s window
 * (and the same "defer the bump until it elapses" approach) as
 * `useTaskActions.ts::RETENTION_MS` — kept as an independent constant here
 * rather than imported, since this hook must not depend on the excluded
 * `useTaskActions.ts` file's internal shape.
 */
export const REFINEMENT_RETENTION_MS = 4000;

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

function errorMessage(err: unknown, strings: Strings): string {
  return localizedErrorMessage(err, strings);
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
  const strings = useStrings();
  const { bump } = useRefresh();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [retained, setRetained] = useState<Map<number, RefinementListItem>>(new Map());
  const [errors, setErrors] = useState<Record<number, string>>({});
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(
    () => () => {
      timers.current.forEach((t) => clearTimeout(t));
      timers.current.clear();
    },
    [],
  );

  const release = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (t) {
      clearTimeout(t);
      timers.current.delete(id);
    }
    setRetained((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const retain = useCallback(
    (optimisticTask: RefinementListItem) => {
      setRetained((prev) => {
        const next = new Map(prev);
        next.set(optimisticTask.id, optimisticTask);
        return next;
      });
      const existing = timers.current.get(optimisticTask.id);
      if (existing) clearTimeout(existing);
      const timeout = setTimeout(() => {
        release(optimisticTask.id);
        bump();
      }, REFINEMENT_RETENTION_MS);
      timers.current.set(optimisticTask.id, timeout);
    },
    [release, bump],
  );

  const clearError = useCallback((id: number) => {
    setErrors((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const setSize = useCallback(
    (task: RefinementListItem, size: TaskSize | null) => {
      setBusyId(task.id);
      clearError(task.id);
      const optimistic: RefinementListItem = { ...task, size };
      retain(optimistic);
      return api
        .updateTask(task.id, { size, expectedRevision: task.revision })
        .catch((err: unknown) => {
          release(task.id);
          if (isStaleWriteConflict(err)) bump();
          setErrors((prev) => ({
            ...prev,
            [task.id]: errorMessage(err, strings),
          }));
        })
        .finally(() => setBusyId(null));
    },
    [clearError, retain, release, strings],
  );

  const cycleSize = useCallback(
    (task: RefinementListItem) => setSize(task, nextSizeInCycle(task.size)),
    [setSize],
  );

  const clearSize = useCallback((task: RefinementListItem) => setSize(task, null), [setSize]);

  /**
   * Assigns (or clears) the responsible member from the row's own focused
   * `AssignOwnerSheet`, without ever opening the full task editor. Uses the
   * same optimistic-retain treatment as a size change, since the owner is
   * the matrix's *other* axis: the row would otherwise jump to a different
   * owner bucket (or vanish behind an owner filter) the instant the patch
   * resolves.
   */
  const assignOwner = useCallback(
    (task: RefinementListItem, ownerMemberId: number | null) => {
      setBusyId(task.id);
      clearError(task.id);
      const optimistic: RefinementListItem = {
        ...task,
        effectiveOwnerId: ownerMemberId,
        effectiveOwnerSource: ownerMemberId === null ? "none" : "task",
      };
      retain(optimistic);
      return api
        .updateTask(task.id, {
          ownerMemberId,
          ownerInheritanceMode: ownerMemberId === null ? "none" : "explicit",
          expectedRevision: task.revision,
        })
        .catch((err: unknown) => {
          // Rolled back, then rethrown so the still-open `AssignOwnerSheet`
          // reports the failure where the user acted, instead of closing and
          // duplicating it as a row-level error banner.
          release(task.id);
          if (isStaleWriteConflict(err)) bump();
          throw err;
        })
        .finally(() => setBusyId(null));
    },
    [bump, clearError, retain, release],
  );

  return { busyId, retained, errors, clearError, setSize, cycleSize, clearSize, assignOwner };
}
