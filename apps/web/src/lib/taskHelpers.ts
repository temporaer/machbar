import type { Task } from "@machbar/shared";

function isOpen(task: Task): boolean {
  return task.status !== "done" && task.status !== "cancelled";
}

export function hasOpenDescendants(task: Task): boolean {
  return task.children.some(
    (child) => isOpen(child) || hasOpenDescendants(child),
  );
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
      ...(alreadyClosed
        ? {}
        : {
            status,
            needsClarification: false,
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
      if (isOpen(child)) roots.push(child);
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
      if (t.status === "done" || t.status === "cancelled") done += 1;
      else open += 1;
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
