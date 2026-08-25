import type { Task } from "@machbar/shared";
import { sortByPosition } from "./taskHelpers";

/**
 * Pure geometry/tree helpers behind the outline's drag editing. Everything
 * here is deliberately free of React and of the network layer so the drag
 * projection, the API mapping and the optimistic tree rewrite can be
 * reasoned about (and tested) on their own.
 *
 * All traversals are iterative: an outline may legitimately be dozens of
 * levels deep, and these run on every pointer move, so neither the call
 * stack nor a full re-walk of untouched branches may grow with depth more
 * than necessary. Untouched branches keep their original object identity
 * (structural sharing), which keeps React re-renders cheap on deep trees.
 */

/** Horizontal distance (px) that corresponds to exactly one outline level. */
export const INDENT_WIDTH = 32;

/** One *visible* outline row, in visual (top-to-bottom) order. */
export interface OutlineRow {
  taskId: number;
  /** Parent task id — the outline's shared root parent for top-level rows. */
  parentId: number | null;
  depth: number;
}

/** Where a drag would drop, given the current pointer position. */
export interface DropProjection {
  parentId: number | null;
  depth: number;
  /** Index inside the destination sibling group, counted *without* the dragged task. */
  index: number;
  /** Row the insertion line is drawn above; `null` = below the last visible row. */
  beforeTaskId: number | null;
}

/**
 * Which existing hierarchy endpoint expresses a requested move. The
 * dedicated verbs are preferred whenever the move matches them exactly, so
 * the server keeps applying its own indent/outdent semantics (and its
 * cycle/consistency checks) instead of us re-deriving them here.
 */
export type MovePlan =
  | { kind: "none" }
  | { kind: "reorder"; taskId: number; position: number }
  | { kind: "indent"; taskId: number }
  | { kind: "outdent"; taskId: number }
  | { kind: "changeParent"; taskId: number; parentTaskId: number | null; projectId: number | null }
  | { kind: "move"; taskId: number; parentTaskId: number | null; position: number };

export interface TaskLocation {
  task: Task;
  /** Parent task id, or the outline's root parent id for a top-level task. */
  parentId: number | null;
  /** The task's sibling group, in display order. */
  siblings: Task[];
  /** Index of the task inside `siblings`. */
  index: number;
  depth: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function sameList(a: Task[], b: Task[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** Ids of the dragged row plus every *visible* descendant below it. */
export function visibleSubtreeIds(rows: OutlineRow[], activeId: number): Set<number> {
  const ids = new Set<number>();
  const start = rows.findIndex((r) => r.taskId === activeId);
  if (start < 0) return ids;
  const activeDepth = rows[start]!.depth;
  ids.add(activeId);
  for (let i = start + 1; i < rows.length; i += 1) {
    const row = rows[i]!;
    if (row.depth <= activeDepth) break;
    ids.add(row.taskId);
  }
  return ids;
}

/** The visible rows a drop may target: everything except the dragged subtree. */
export function rowsExcludingSubtree(rows: OutlineRow[], activeId: number): OutlineRow[] {
  const excluded = visibleSubtreeIds(rows, activeId);
  return rows.filter((row) => !excluded.has(row.taskId));
}

/**
 * Insertion slot for a pointer position: the number of rows whose vertical
 * midpoint is above the pointer. `rects` must line up with the drop-target
 * rows, and is measured once when the drag starts (rows do not move while
 * dragging, and re-measuring on every pointer move would be wasteful on
 * long outlines).
 */
export function slotFromPointer(rects: { top: number; height: number }[], pointerY: number): number {
  for (let i = 0; i < rects.length; i += 1) {
    const rect = rects[i]!;
    if (pointerY < rect.top + rect.height / 2) return i;
  }
  return rects.length;
}

/**
 * Turns "pointer is in slot N, dragged this far sideways" into a concrete
 * parent/depth/index. The depth is bounded by what the neighbouring rows
 * allow — at most one level deeper than the row above (so a task can only
 * become a child of a task actually preceding it), and never shallower than
 * the row below, which would otherwise be orphaned into a different group.
 */
export function projectDrop(params: {
  /** Visible rows without the dragged subtree, in visual order. */
  rows: OutlineRow[];
  slot: number;
  /** Depth the dragged row had before the drag started. */
  activeDepth: number;
  offsetX: number;
  rootParentId: number | null;
  indentWidth?: number;
}): DropProjection {
  const { rows, activeDepth, offsetX, rootParentId } = params;
  const indentWidth = params.indentWidth ?? INDENT_WIDTH;
  const slot = clamp(params.slot, 0, rows.length);
  const previous = slot > 0 ? rows[slot - 1] : undefined;
  const next = slot < rows.length ? rows[slot] : undefined;

  const maxDepth = previous ? previous.depth + 1 : 0;
  const minDepth = next ? next.depth : 0;
  const desiredDepth = activeDepth + Math.round(offsetX / indentWidth);
  const depth = clamp(desiredDepth, Math.min(minDepth, maxDepth), maxDepth);

  let parentId = rootParentId;
  if (depth > 0) {
    for (let i = slot - 1; i >= 0; i -= 1) {
      const row = rows[i]!;
      if (row.depth === depth - 1) {
        parentId = row.taskId;
        break;
      }
    }
  }

  let index = 0;
  for (let i = 0; i < slot; i += 1) {
    if (rows[i]!.parentId === parentId && rows[i]!.depth === depth) index += 1;
  }

  return { parentId, depth, index, beforeTaskId: next?.taskId ?? null };
}

/** Locates a task inside the outline tree without recursing. */
export function locateTask(
  roots: Task[],
  taskId: number,
  rootParentId: number | null,
): TaskLocation | null {
  const stack: { list: Task[]; parentId: number | null; depth: number }[] = [
    { list: sortByPosition(roots), parentId: rootParentId, depth: 0 },
  ];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    const index = frame.list.findIndex((t) => t.id === taskId);
    if (index >= 0) {
      return {
        task: frame.list[index]!,
        parentId: frame.parentId,
        siblings: frame.list,
        index,
        depth: frame.depth,
      };
    }
    for (const child of frame.list) {
      if (child.children.length > 0) {
        stack.push({ list: sortByPosition(child.children), parentId: child.id, depth: frame.depth + 1 });
      }
    }
  }
  return null;
}

/** The sibling group of a parent id, in display order. */
export function childrenOf(roots: Task[], parentId: number | null, rootParentId: number | null): Task[] {
  if (parentId === rootParentId) return sortByPosition(roots);
  const located = locateTask(roots, parentId as number, rootParentId);
  return located ? sortByPosition(located.task.children) : [];
}

/** True when `candidateId` sits inside `taskId`'s own subtree. */
export function isDescendantOf(
  roots: Task[],
  taskId: number,
  candidateId: number | null,
  rootParentId: number | null,
): boolean {
  if (candidateId === null) return false;
  const located = locateTask(roots, taskId, rootParentId);
  if (!located) return false;
  const stack: Task[] = [...located.task.children];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.id === candidateId) return true;
    for (const child of node.children) stack.push(child);
  }
  return false;
}

/**
 * Maps a requested destination onto the narrowest existing endpoint.
 * `targetIndex` is always an index inside the destination sibling group
 * *excluding* the moved task, which is exactly what the backend's
 * `moveTask` expects.
 */
export function planMove(params: {
  roots: Task[];
  rootParentId: number | null;
  rootProjectId: number | null;
  taskId: number;
  targetParentId: number | null;
  targetIndex: number;
}): MovePlan {
  const { roots, rootParentId, rootProjectId, taskId, targetParentId, targetIndex } = params;
  const current = locateTask(roots, taskId, rootParentId);
  if (!current) return { kind: "none" };

  if (targetParentId === current.parentId) {
    const bounded = clamp(targetIndex, 0, current.siblings.length - 1);
    if (bounded === current.index) return { kind: "none" };
    return { kind: "reorder", taskId, position: bounded };
  }

  const destination = childrenOf(roots, targetParentId, rootParentId).filter((t) => t.id !== taskId);
  const atEnd = targetIndex >= destination.length;

  const previousSibling = current.index > 0 ? current.siblings[current.index - 1] : undefined;
  if (previousSibling && targetParentId === previousSibling.id && atEnd) {
    return { kind: "indent", taskId };
  }

  if (current.parentId !== null && current.parentId !== rootParentId) {
    const parent = locateTask(roots, current.parentId, rootParentId);
    if (parent && targetParentId === parent.parentId && targetIndex === parent.index + 1) {
      return { kind: "outdent", taskId };
    }
  }

  if (atEnd) {
    return { kind: "changeParent", taskId, parentTaskId: targetParentId, projectId: rootProjectId };
  }
  return { kind: "move", taskId, parentTaskId: targetParentId, position: targetIndex };
}

/**
 * Rebuilds the tree, letting `edit` rewrite individual sibling groups.
 * Iterative (explicit stack) and identity-preserving: a group `edit`
 * returns unchanged keeps its original array *and* its parent node object.
 */
function rebuildGroups(
  roots: Task[],
  rootParentId: number | null,
  edit: (group: Task[], parentId: number | null) => Task[],
): Task[] {
  interface Frame {
    parentId: number | null;
    node: Task | null;
    source: Task[];
    result: Task[];
    cursor: number;
  }
  const stack: Frame[] = [{ parentId: rootParentId, node: null, source: roots, result: [], cursor: 0 }];

  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (frame.cursor < frame.source.length) {
      const child = frame.source[frame.cursor]!;
      frame.cursor += 1;
      if (child.children.length > 0) {
        stack.push({ parentId: child.id, node: child, source: child.children, result: [], cursor: 0 });
      } else {
        // Leaf groups still have to be offered to `edit`: an empty child
        // list is a perfectly valid drop destination (indenting under a
        // task that has no children yet).
        const nextChildren = edit(child.children, child.id);
        frame.result.push(
          sameList(nextChildren, child.children) ? child : { ...child, children: nextChildren },
        );
      }
      continue;
    }

    stack.pop();
    const nextChildren = edit(frame.result, frame.parentId);
    if (!frame.node) {
      return sameList(nextChildren, roots) ? roots : nextChildren;
    }
    const unchanged = sameList(nextChildren, frame.source);
    stack[stack.length - 1]!.result.push(
      unchanged ? frame.node : { ...frame.node, children: nextChildren },
    );
  }
  return roots;
}

/**
 * Optimistic counterpart of the backend move: detaches the task (with its
 * whole subtree) and reinserts it at `targetIndex` of the destination
 * group, renumbering `position` in both affected groups exactly the way
 * the server's `reindexGroup` does — otherwise the rendered order (which
 * sorts by `position`) would snap straight back.
 */
export function applyMove(
  roots: Task[],
  taskId: number,
  targetParentId: number | null,
  targetIndex: number,
  rootParentId: number | null,
): Task[] {
  const located = locateTask(roots, taskId, rootParentId);
  if (!located) return roots;
  // Never fabricate a cycle locally; the server stays the authority, but an
  // obviously impossible optimistic tree would corrupt the rollback state.
  if (targetParentId === taskId || isDescendantOf(roots, taskId, targetParentId, rootParentId)) {
    return roots;
  }
  const moved: Task = { ...located.task, parentTaskId: targetParentId };

  const edit = (group: Task[], parentId: number | null): Task[] => {
    const isSource = group.some((t) => t.id === taskId);
    const isDestination = parentId === targetParentId;
    if (!isSource && !isDestination) return group;
    const ordered = sortByPosition(group).filter((t) => t.id !== taskId);
    if (isDestination) ordered.splice(clamp(targetIndex, 0, ordered.length), 0, moved);
    return ordered.map((t, i) => (t.position === i ? t : { ...t, position: i }));
  };

  return rebuildGroups(roots, rootParentId, edit);
}

/**
 * True when every root row belongs to one real sibling group. Only then do
 * outline positions/levels mean anything: compiled views (Heute, Suche, …)
 * mix tasks from unrelated parents and projects, where reordering or
 * re-parenting by screen position would be meaningless.
 */
export function outlineRootGroup(
  tasks: Task[],
): { parentId: number | null; projectId: number | null } | null {
  const first = tasks[0];
  if (!first) return null;
  for (const task of tasks) {
    if (task.parentTaskId !== first.parentTaskId || task.projectId !== first.projectId) return null;
  }
  return { parentId: first.parentTaskId, projectId: first.projectId };
}
