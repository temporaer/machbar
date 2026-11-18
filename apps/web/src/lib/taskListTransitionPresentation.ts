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
  taskTitle: string;
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
  | {
      kind: "ancestor";
      taskId: number;
      title: string;
      children: TaskListRow[];
      sourceStep: TaskListPositionStep;
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
        taskTitle: task.title,
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
    !roots.some(task => task.id === entry.sourcePath?.[0]?.taskId) &&
    entry.sourcePath !== null,
  );
  const replacementIds = new Set(
    originTransitions
      .filter(entry => entry.sourcePath?.length === 1 && isDetachedConfirmation(entry))
      .map(entry => entry.event.taskId),
  );
  const visibleRoots = roots.filter(task =>
    !suppressedTaskIds.has(task.id) && !replacementIds.has(task.id),
  );
  const candidates: Array<{ step: TaskListPositionStep; row: TaskListRow }> = [];
  const groupedAncestors = new Map<number, { step: TaskListPositionStep; entries: TaskListTransitionEntry[] }>();
  for (const transition of originTransitions) {
    const step = transition.sourcePath?.[0];
    if (!step) continue;
    if (transition.sourcePath?.length === 1) {
      candidates.push({ step, row: { kind: "transition", transition } });
      continue;
    }
    const group = groupedAncestors.get(step.taskId) ?? { step, entries: [] };
    group.entries.push({ ...transition, sourcePath: transition.sourcePath!.slice(1) });
    groupedAncestors.set(step.taskId, group);
  }
  for (const [taskId, group] of groupedAncestors) {
    const children = composeTaskListRows([], group.entries, outlineId, taskId, suppressedTaskIds);
    if (children.length) {
      candidates.push({
        step: group.step,
        row: {
          kind: "ancestor",
          taskId,
          title: group.step.taskTitle,
          children,
          sourceStep: group.step,
        },
      });
    }
  }

  const placements = new Map<number, Array<{ step: TaskListPositionStep; row: TaskListRow }>>();
  const trailing: Array<{ step: TaskListPositionStep; row: TaskListRow }> = [];
  for (const candidate of candidates) {
    const { step } = candidate;
    const anchor = step.siblingIds
      .slice(step.siblingIds.indexOf(step.taskId) + 1)
      .find(id => visibleRoots.some(task => task.id === id));
    if (anchor === undefined) {
      trailing.push(candidate);
      continue;
    }
    const group = placements.get(anchor) ?? [];
    group.push(candidate);
    placements.set(anchor, group);
  }

  const rank = (candidate: { step: TaskListPositionStep }) =>
    candidate.step.siblingIds.indexOf(candidate.step.taskId);
  const ordered = (group: Array<{ step: TaskListPositionStep; row: TaskListRow }>) =>
    group.sort((left, right) => rank(left) - rank(right) || left.step.taskId - right.step.taskId)
      .map(candidate => candidate.row);
  const result: TaskListRow[] = [];
  for (const task of visibleRoots) {
    result.push(...ordered(placements.get(task.id) ?? []));
    const childTransitions = transitions
      .filter(entry =>
        entry.sourceOutlineId === outlineId &&
        entry.sourcePath?.[0]?.taskId === task.id &&
        entry.sourcePath.length > 1,
      )
      .map(entry => ({ ...entry, sourcePath: entry.sourcePath!.slice(1) }));
    result.push({ kind: "task", task, childTransitions });
  }
  result.push(...ordered(trailing));
  return result;
}

export function suppressedTransitionTaskIds(
  transitions: readonly TaskListTransitionEntry[],
  outlineId: string,
  renderableOutlineIds: ReadonlySet<string>,
): Set<number> {
  return new Set(transitions
    .filter(entry =>
      entry.sourceOutlineId !== outlineId &&
      entry.sourceOutlineId !== null &&
      renderableOutlineIds.has(entry.sourceOutlineId) &&
      entry.sourcePath !== null &&
      isDetachedConfirmation(entry),
    )
    .map(entry => entry.event.taskId));
}

export function composeTaskListPresentation(
  roots: readonly Task[],
  transitions: readonly TaskListTransitionEntry[],
  outlineId: string,
  renderableOutlineIds: ReadonlySet<string>,
) {
  const suppressedTaskIds = suppressedTransitionTaskIds(transitions, outlineId, renderableOutlineIds);
  return {
    rows: composeTaskListRows(roots, transitions, outlineId, null, suppressedTaskIds),
    suppressedTaskIds,
  };
}
