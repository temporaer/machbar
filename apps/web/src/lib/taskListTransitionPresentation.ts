import type { Task } from "@machbar/shared";
import type { TaskTransitionFeedbackEvent } from "./useTaskActions";

export interface TaskListTransition {
  task: Task;
  event: TaskTransitionFeedbackEvent;
  sourceIndex?: number | null;
}

export type TaskListTransitionEntry = TaskListTransition & {
  sourceOutlineId: string | null;
};

export type TaskListRow =
  | { kind: "task"; task: Task }
  | { kind: "transition"; transition: TaskListTransition };

export function transitionSourceIndex(
  rootTaskIds: readonly number[],
  taskId: number,
  outlineId: string | undefined,
  entries: Iterable<TaskListTransitionEntry>,
  currentTaskIds: ReadonlySet<number>,
): number | null {
  const index = rootTaskIds.indexOf(taskId);
  if (index < 0 || !outlineId) return null;
  let sourceIndex = index;
  const precedingDepartures = [...entries]
    .filter(entry =>
      entry.sourceOutlineId === outlineId &&
      entry.sourceIndex !== null &&
      entry.sourceIndex !== undefined &&
      !currentTaskIds.has(entry.event.taskId),
    )
    .map(entry => entry.sourceIndex!)
    .sort((left, right) => left - right);
  for (const departureIndex of precedingDepartures) {
    if (departureIndex <= sourceIndex) sourceIndex += 1;
  }
  return sourceIndex;
}

export function removeTransitionAndRebase<T extends TaskListTransitionEntry>(
  entries: ReadonlyMap<number, T>,
  taskId: number,
  currentTaskIds: ReadonlySet<number>,
): Map<number, T> {
  const current = entries.get(taskId);
  const next = new Map(entries);
  next.delete(taskId);
  if (
    current?.sourceIndex === null ||
    current?.sourceIndex === undefined ||
    currentTaskIds.has(taskId)
  ) {
    return next;
  }
  for (const [id, entry] of next) {
    if (
      entry.sourceOutlineId === current.sourceOutlineId &&
      entry.sourceIndex !== null &&
      entry.sourceIndex !== undefined &&
      entry.sourceIndex > current.sourceIndex
    ) {
      next.set(id, { ...entry, sourceIndex: entry.sourceIndex - 1 });
    }
  }
  return next;
}

export function composeTaskListRows(
  roots: readonly Task[],
  departures: readonly TaskListTransition[],
): TaskListRow[] {
  const departuresByIndex = new Map<number, TaskListTransition[]>();
  const trailing: TaskListTransition[] = [];
  const orderedDepartures = [...departures].sort((left, right) =>
    (left.sourceIndex ?? Number.POSITIVE_INFINITY) -
      (right.sourceIndex ?? Number.POSITIVE_INFINITY) ||
    left.event.taskId - right.event.taskId,
  );
  for (const transition of orderedDepartures) {
    if (transition.sourceIndex === undefined || transition.sourceIndex === null) {
      trailing.push(transition);
      continue;
    }
    const precedingCount = orderedDepartures.filter(entry =>
      entry.sourceIndex !== undefined &&
      entry.sourceIndex !== null &&
      entry.sourceIndex < transition.sourceIndex!,
    ).length;
    const index = Math.max(0, Math.min(roots.length, transition.sourceIndex - precedingCount));
    if (index === roots.length) {
      trailing.push(transition);
      continue;
    }
    const entries = departuresByIndex.get(index) ?? [];
    entries.push(transition);
    departuresByIndex.set(index, entries);
  }

  return [
    ...roots.flatMap((task, index): TaskListRow[] => [
      ...(departuresByIndex.get(index) ?? []).map(transition => ({
        kind: "transition" as const,
        transition,
      })),
      { kind: "task" as const, task },
    ]),
    ...trailing.map(transition => ({ kind: "transition" as const, transition })),
  ];
}
