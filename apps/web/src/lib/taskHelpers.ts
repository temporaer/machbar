import type { Task } from "@machbar/shared";

function isOpen(task: Task): boolean {
  return task.status !== "done" && task.status !== "cancelled";
}

function isOpenAction(task: Task): boolean {
  return task.kind === "action" && isOpen(task);
}

/**
 * An unclassified root capture: still `captured`, never filed under a
 * project or parent task. Filing it into a project/parent via
 * `task.changeProject` is the intended refile/clarification path — the API
 * atomically classifies it out of `captured` as part of that move — so this
 * helper must NOT be used to hide the move affordance. It still gates
 * commands the API rejects outright for a captured root item: adding
 * children/splitting it (`task_promotion_invalid`, since it isn't filed
 * anywhere yet to hold steps) and other classification-requiring commands.
 */
export function isCapturedInboxItem(task: Task): boolean {
  return (
    task.status === "captured" &&
    task.projectId === null &&
    task.parentTaskId === null
  );
}

export function hasOpenDescendants(task: Task): boolean {
  return task.children.some((child) => isOpenAction(child) || hasOpenDescendants(child));
}

/**
 * Mirrors a parent terminal command's descendant policy in an optimistic tree.
 * Closed nodes stay unchanged, but traversal continues because they can contain
 * open descendants.
 */
export function markOpenDescendantsTerminal(
  children: Task[],
  status: Extract<Task["status"], "done" | "cancelled">,
  at: string,
): Task[] {
  return children.map((child) => {
    const alreadyClosed = child.status === "done" || child.status === "cancelled";
    return {
      ...child,
      ...(child.kind !== "action" || alreadyClosed
        ? {}
        : {
            status,
            completedAt: status === "done" ? at : null,
            cancelledAt: status === "cancelled" ? at : null,
          }),
      children: markOpenDescendantsTerminal(child.children, status, at),
    };
  });
}

/**
 * Returns the highest open task on each descendant branch. Closed tasks may
 * still contain open descendants, so their branches must keep being searched.
 */
export function openDescendantRoots(task: Task): Task[] {
  const roots: Task[] = [];
  const walk = (children: Task[]) => {
    for (const child of children) {
      if (isOpenAction(child)) roots.push(child);
      else walk(child.children);
    }
  };
  walk(task.children);
  return roots;
}

export function sortByPosition<T extends { position: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.position - b.position);
}

export function countTasks(tasks: Task[]): { open: number; done: number } {
  let open = 0;
  let done = 0;
  const walk = (list: Task[]) => {
    for (const t of list) {
      if (t.kind === "action") {
        if (t.status === "done" || t.status === "cancelled") done += 1;
        else open += 1;
      }
      if (t.children.length) walk(t.children);
    }
  };
  walk(tasks);
  return { open, done };
}

export function flattenTasks(tasks: Task[]): Task[] {
  const out: Task[] = [];
  const walk = (list: Task[]) => {
    for (const t of list) {
      out.push(t);
      if (t.children.length) walk(t.children);
    }
  };
  walk(tasks);
  return out;
}

/** Index each unique task once, reusing cached descendant sets for ancestors
 * and for callers supplying an already flattened tree. */
export function indexTaskDescendants(tasks: readonly Task[]): Map<number, Set<number>> {
  const index = new Map<number, Set<number>>();
  const visit = (task: Task): Set<number> => {
    const cached = index.get(task.id);
    if (cached) return cached;
    const descendants = new Set<number>();
    index.set(task.id, descendants);
    for (const child of task.children) {
      descendants.add(child.id);
      for (const id of visit(child)) descendants.add(id);
    }
    return descendants;
  };
  tasks.forEach(visit);
  return index;
}

/** A parent's terminal policy may change a child's lifecycle, not its other
 * authoritative fields or hierarchy. Equal-revision derived values stay fresh. */
export function applyDescendantTerminalOutcome<T extends Task>(current: T, inherited: Task): T {
  if (inherited.kind !== "action" || inherited.revision < current.revision ||
      (inherited.status !== "done" && inherited.status !== "cancelled") ||
      inherited.status === current.status) return current;
  return { ...current, revision: inherited.revision, status: inherited.status,
    completedAt: inherited.completedAt, cancelledAt: inherited.cancelledAt,
    needsClarification: inherited.needsClarification };
}

/** Confirmed equal-revision reads own derived fields. Pending writes keep
 * their optimistic values until the request settles. */
export function projectTaskValue(current: Task, retained: Task | undefined, pending = false): Task {
  return retained && (retained.revision > current.revision || (pending && retained.revision === current.revision))
    ? retained : current;
}

/** Sort authoritative siblings before placement; rendered placement is final. */
export function orderTaskTree(tasks: Task[], preserveRoots = false, preserveDescendants = false): Task[] {
  const roots = preserveRoots ? tasks : sortByPosition(tasks);
  return roots.map(task => ({ ...task,
    children: preserveDescendants ? task.children : orderTaskTree(task.children),
  }));
}
