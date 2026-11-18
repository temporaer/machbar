import type { Task, TaskStatus } from "@machbar/shared";

export interface TaskTransitionFeedbackEvent {
  taskId: number;
  targetStatus: TaskStatus;
  occurrence: boolean;
  phase: "pending" | "success" | "failure";
  sourceRevision: number;
  resultStatus?: TaskStatus;
  resultRevision?: number;
}

export interface TaskListPositionStep {
  taskId: number;
  parentTaskId: number | null;
  siblingIds: number[];
}

export interface TaskListTransition {
  task: Task;
  event: TaskTransitionFeedbackEvent;
  sourcePath: readonly TaskListPositionStep[] | null;
}

export type TaskListTransitionEntry = TaskListTransition & {
  sourceOutlineId: string | null;
};

export type TaskListRow =
  | {
      kind: "task";
      task: Task;
      childTransitions: TaskListTransitionEntry[];
    }
  | { kind: "transition"; transition: TaskListTransitionEntry };

export function findTaskListPosition(
  roots: readonly Task[],
  taskId: number,
): TaskListPositionStep[] | null {
  return findTaskListPositions(roots).get(taskId) ?? null;
}

export function findTaskListPositions(
  roots: readonly Task[],
): Map<number, TaskListPositionStep[]> {
  const positions = new Map<number, TaskListPositionStep[]>();
  const visit = (
    siblings: readonly Task[],
    parentTaskId: number | null,
    ancestors: readonly TaskListPositionStep[],
  ) => {
    const siblingIds = siblings.map(sibling => sibling.id);
    for (const task of siblings) {
      const step = {
        taskId: task.id,
        parentTaskId,
        siblingIds,
      };
      const path = [...ancestors, step];
      positions.set(task.id, path);
      visit(task.children, task.id, path);
    }
  };
  visit(roots, null, []);
  return positions;
}

function isDetachedConfirmation(entry: TaskListTransitionEntry) {
  return entry.event.phase === "success" && !entry.event.occurrence;
}

export function composeTaskListRows(
  roots: readonly Task[],
  transitions: readonly TaskListTransitionEntry[],
  outlineId: string,
  parentTaskId: number | null = null,
  suppressedTaskIds: ReadonlySet<number> = new Set(),
): TaskListRow[] {
  const originTransitions = transitions.filter(entry =>
    entry.sourceOutlineId === outlineId &&
    entry.sourcePath?.[0]?.parentTaskId === parentTaskId &&
    entry.sourcePath.length === 1 &&
    !roots.some(task => task.id === entry.event.taskId),
  );
  const replacementIds = new Set(
    originTransitions.filter(isDetachedConfirmation).map(entry => entry.event.taskId),
  );
  const visibleRoots = roots.filter(task =>
    !suppressedTaskIds.has(task.id) && !replacementIds.has(task.id),
  );
  const placements = new Map<number, TaskListTransitionEntry[]>();
  const trailing: TaskListTransitionEntry[] = [];

  for (const transition of originTransitions) {
    const step = transition.sourcePath?.[0];
    if (!step) continue;
    const anchor = step.siblingIds
      .slice(step.siblingIds.indexOf(step.taskId) + 1)
      .find(id => visibleRoots.some(task => task.id === id));
    if (anchor === undefined) {
      trailing.push(transition);
      continue;
    }
    const group = placements.get(anchor) ?? [];
    group.push(transition);
    placements.set(anchor, group);
  }

  const rank = (entry: TaskListTransitionEntry) => {
    const step = entry.sourcePath?.[0];
    return step ? step.siblingIds.indexOf(step.taskId) : Number.MAX_SAFE_INTEGER;
  };
  const result: TaskListRow[] = [];
  for (const task of visibleRoots) {
    result.push(...(placements.get(task.id) ?? [])
      .sort((left, right) => rank(left) - rank(right) || left.event.taskId - right.event.taskId)
      .map(transition => ({ kind: "transition" as const, transition })));
    const childTransitions = transitions
      .filter(entry =>
        entry.sourceOutlineId === outlineId &&
        entry.sourcePath?.[0]?.taskId === task.id &&
        entry.sourcePath.length > 1,
      )
      .map(entry => ({ ...entry, sourcePath: entry.sourcePath!.slice(1) }));
    result.push({ kind: "task", task, childTransitions });
  }
  result.push(...trailing
    .sort((left, right) => rank(left) - rank(right) || left.event.taskId - right.event.taskId)
    .map(transition => ({ kind: "transition" as const, transition })));
  return result;
}

export function suppressedTransitionTaskIds(
  transitions: readonly TaskListTransitionEntry[],
  outlineId: string,
): Set<number> {
  return new Set(transitions
    .filter(entry => entry.sourceOutlineId !== outlineId && isDetachedConfirmation(entry))
    .map(entry => entry.event.taskId));
}
