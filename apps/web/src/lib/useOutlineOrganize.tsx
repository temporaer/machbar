import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Task } from "@machbar/shared";
import { api } from "./api";
import { useRefresh } from "./refresh";
import { useStrings } from "./strings";
import type { Strings } from "./strings";
import { localizedErrorMessage } from "./errorMessage";
import {
  INDENT_WIDTH,
  applyMove,
  locateTask,
  outlineRootGroup,
  planMove,
  projectDrop,
  rowsExcludingSubtree,
  slotFromPointer,
} from "./taskTreeMove";
import type { DropProjection, MovePlan, OutlineRow } from "./taskTreeMove";

/** Movements the non-pointer (keyboard / selected-task toolbar) path offers. */
export type OrganizeDirection = "up" | "down" | "indent" | "outdent";

/** Pointer travel before a press on the drag handle becomes an actual drag. */
const DRAG_START_THRESHOLD = 4;

export interface OutlineOrganizeValue {
  /** False for compiled views, where screen order carries no hierarchy meaning. */
  enabled: boolean;
  activeId: number | null;
  selectedId: number | null;
  /** Task whose structural mutation is currently in flight. */
  pendingId: number | null;
  projection: DropProjection | null;
  /** Levels the dragged row would shift by, for the live depth preview. */
  dragDepthDelta: number;
  /**
   * Destination parent of the most recent move. Rows watch this so a task
   * dropped into a *collapsed* parent does not silently vanish: the
   * addressed parent expands itself (collapse state lives per row).
   */
  expandRequest: { taskId: number } | null;
  errors: Record<number, string>;
  registerRow: (taskId: number, row: OutlineRow, element: HTMLElement | null) => void;
  /** Arms a pointer drag; it only becomes real once the pointer actually moves. */
  beginDrag: (taskId: number, clientX: number, clientY: number) => void;
  /** Starts a drag immediately (touch long press), using the press origin. */
  beginLongPressDrag: (taskId: number, clientX: number, clientY: number) => void;
  toggleSelect: (taskId: number) => void;
  /** True exactly once after a real drag, so the handle's click never toggles selection too. */
  consumeDragClick: () => boolean;
  moveBy: (taskId: number, direction: OrganizeDirection) => void;
  clearError: (taskId: number) => void;
}

const OutlineOrganizeContext = createContext<OutlineOrganizeValue | null>(null);
export const OutlineOrganizeProvider = OutlineOrganizeContext.Provider;

/** Rows read this to render their handle, drag state and inline move errors. */
export function useOutlineOrganizeRow(): OutlineOrganizeValue | null {
  return useContext(OutlineOrganizeContext);
}

interface DragSession {
  taskId: number;
  startX: number;
  startY: number;
  activeDepth: number;
  rows: OutlineRow[];
  rects: { top: number; height: number }[];
  active: boolean;
  moved: boolean;
  /** Started on the handle (so its click is ours to swallow), not by a row long press. */
  fromHandle: boolean;
  projection: DropProjection | null;
}

function sameProjection(a: DropProjection | null, b: DropProjection | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.parentId === b.parentId && a.depth === b.depth && a.index === b.index && a.beforeTaskId === b.beforeTaskId;
}

function errorMessage(err: unknown, strings: Strings): string {
  const detail = localizedErrorMessage(err, strings);
  return detail ? `${strings.moveFailed}: ${detail}` : strings.moveFailed;
}

/**
 * Owns everything about structurally editing one outline: the pointer drag
 * session, the equivalent keyboard/toolbar moves, the optimistic tree and
 * its rollback.
 *
 * `organizable` is the caller's explicit statement that this outline shows
 * one *complete* sibling group (a project's own task tree). Compiled views
 * (Heute, Eingang, Suche, …) show an arbitrary subset of tasks, so a
 * position derived from screen order would be meaningless there — worse,
 * it would be applied to the full group on the server. The structural
 * shape of the data is then still checked on top of that opt-in.
 *
 * Optimism is tied to the identity of the `tasks` prop: as long as the
 * caller keeps handing us the same array we keep showing our locally moved
 * tree, and the moment fresh server data arrives (a new array) the override
 * is dropped without any extra bookkeeping. A rejected move restores the
 * previous tree *in place* — no global refresh is triggered, since that
 * would also tear down unrelated optimistic state (retained rows) elsewhere
 * — and surfaces a localized message on the affected row instead.
 */
export function useOutlineOrganize(tasks: Task[], organizable: boolean) {
  const strings = useStrings();
  const { bump } = useRefresh();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [override, setOverride] = useState<{ base: Task[]; tasks: Task[] } | null>(null);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [pendingId, setPendingId] = useState<number | null>(null);
  const [projection, setProjection] = useState<DropProjection | null>(null);
  const [indicatorTop, setIndicatorTop] = useState(0);
  const [expandRequest, setExpandRequest] = useState<{ taskId: number } | null>(null);
  const [errors, setErrors] = useState<Record<number, string>>({});

  const effectiveTasks = override && override.base === tasks ? override.tasks : tasks;
  const structuralGroup = useMemo(() => outlineRootGroup(effectiveTasks), [effectiveTasks]);
  const rootGroup = organizable ? structuralGroup : null;
  const enabled = rootGroup !== null;

  const registry = useRef<Map<number, { row: OutlineRow; element: HTMLElement }>>(new Map());
  const session = useRef<DragSession | null>(null);
  const suppressClick = useRef(false);
  const mounted = useRef(true);
  const refocusId = useRef<number | null>(null);

  // Window listeners and async mutations both outlive the render that
  // created them, so everything they need is mirrored here instead of being
  // captured in a stale closure.
  const latest = useRef({ tasks, effectiveTasks, rootGroup, override, pendingId });
  latest.current = { tasks, effectiveTasks, rootGroup, override, pendingId };

  useEffect(() => {
    // Re-asserted on (re-)mount rather than only cleared on unmount: React's
    // StrictMode mounts, unmounts and remounts every effect in development,
    // which would otherwise leave the flag permanently false and make every
    // later move skip its refresh, its rollback and its busy reset.
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const registerRow = useCallback((taskId: number, row: OutlineRow, element: HTMLElement | null) => {
    if (element) registry.current.set(taskId, { row, element });
    else registry.current.delete(taskId);
  }, []);

  // Runs after every row has (re-)registered, i.e. once the moved row's new
  // DOM node exists. One attempt only — a stale request must never steal
  // focus from something the user did in the meantime.
  useEffect(() => {
    const taskId = refocusId.current;
    if (taskId === null) return;
    refocusId.current = null;
    registry.current.get(taskId)?.element.querySelector<HTMLElement>(".task-row-drag-handle")?.focus();
  }, [effectiveTasks]);

  const clearError = useCallback((taskId: number) => {
    setErrors((prev) => {
      if (!(taskId in prev)) return prev;
      const next = { ...prev };
      delete next[taskId];
      return next;
    });
  }, []);

  const execute = useCallback(async (plan: MovePlan) => {
    switch (plan.kind) {
      case "reorder":
        await api.reorderTask(plan.taskId, plan.position);
        return;
      case "indent":
        await api.indentTask(plan.taskId);
        return;
      case "outdent":
        await api.outdentTask(plan.taskId);
        return;
      case "changeParent":
        // Only a move back to the top level needs the project spelled out;
        // under a parent the server derives it from that parent.
        if (plan.parentTaskId === null) await api.changeParent(plan.taskId, null, plan.projectId);
        else await api.changeParent(plan.taskId, plan.parentTaskId);
        return;
      case "move":
        await api.moveTask(plan.taskId, { parentTaskId: plan.parentTaskId, position: plan.position });
        return;
      default:
    }
  }, []);

  const commitMove = useCallback(
    (taskId: number, targetParentId: number | null, targetIndex: number) => {
      const { tasks: baseTasks, effectiveTasks: current, rootGroup: group, override: previousOverride, pendingId: busy } =
        latest.current;
      if (!group || busy !== null) return;
      // A row that only exists as a retention snapshot (or a destination
      // that just vanished) has no place in the real tree — never guess.
      if (!locateTask(current, taskId, group.parentId)) return;
      if (targetParentId !== group.parentId && !locateTask(current, targetParentId as number, group.parentId)) return;

      const plan = planMove({
        roots: current,
        rootParentId: group.parentId,
        rootProjectId: group.projectId,
        taskId,
        targetParentId,
        targetIndex,
      });
      if (plan.kind === "none") return;

      const optimistic = applyMove(current, taskId, targetParentId, targetIndex, group.parentId);
      if (optimistic === current) return;

      // Re-parenting moves the row to a different list, so React unmounts
      // and remounts it — which would drop keyboard focus mid-sequence.
      // Remember to put it back on the row's own handle.
      const active = document.activeElement;
      if (active instanceof HTMLElement && registry.current.get(taskId)?.element.contains(active)) {
        refocusId.current = taskId;
      }

      clearError(taskId);
      setOverride({ base: baseTasks, tasks: optimistic });
      setPendingId(taskId);
      // A destination parent that happens to be collapsed would swallow the
      // row the user just moved; ask it to reveal its children. A fresh
      // object every time, so a repeated move to the same parent is still a
      // new request and never blocks collapsing it again by hand.
      if (targetParentId !== null && targetParentId !== group.parentId) {
        setExpandRequest({ taskId: targetParentId });
      }
      void (async () => {
        try {
          await execute(plan);
          if (!mounted.current) return;
          // The server is the authority on hierarchy (cycles, positions):
          // refresh once it accepted the move so every view converges.
          bump();
        } catch (err) {
          if (!mounted.current) return;
          setOverride(previousOverride);
          setErrors((prev) => ({
            ...prev,
            [taskId]: errorMessage(err, strings),
          }));
        } finally {
          if (mounted.current) setPendingId(null);
        }
      })();
    },
    [bump, clearError, execute, strings],
  );

  const snapshotRows = useCallback((taskId: number) => {
    const entries = [...registry.current.values()];
    entries.sort((a, b) => {
      if (a.element === b.element) return 0;
      const relation = a.element.compareDocumentPosition(b.element);
      // eslint-disable-next-line no-bitwise
      if (relation & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      // eslint-disable-next-line no-bitwise
      if (relation & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
    const rootParentId = latest.current.rootGroup?.parentId ?? null;
    const rows: OutlineRow[] = entries.map(({ row }) => ({
      taskId: row.taskId,
      parentId: row.depth === 0 ? rootParentId : row.parentId,
      depth: row.depth,
    }));
    const activeRow = rows.find((row) => row.taskId === taskId);
    if (!activeRow) return null;
    const targets = rowsExcludingSubtree(rows, taskId);
    const rects = targets.map((row) => {
      const rect = registry.current.get(row.taskId)!.element.getBoundingClientRect();
      return { top: rect.top, height: rect.height };
    });
    return { rows: targets, rects, activeDepth: activeRow.depth };
  }, []);

  const indicatorTopFor = useCallback((snapshotRects: { top: number; height: number }[], slot: number) => {
    const containerTop = containerRef.current?.getBoundingClientRect().top ?? 0;
    if (snapshotRects.length === 0) return 0;
    const target = snapshotRects[slot];
    if (target) return target.top - containerTop;
    const last = snapshotRects[snapshotRects.length - 1]!;
    return last.top + last.height - containerTop;
  }, []);

  // Window listeners must keep a *stable* identity for the whole drag (a
  // re-render mid-drag would otherwise leave the old listener attached
  // forever), so the dispatchers below never change while the handlers they
  // forward to are refreshed on every render.
  const handlers = useRef({
    move: (_event: PointerEvent) => {},
    up: () => {},
    cancel: () => {},
    key: (_event: KeyboardEvent) => {},
  });
  const onWindowPointerMove = useCallback((event: PointerEvent) => handlers.current.move(event), []);
  const onWindowPointerUp = useCallback(() => handlers.current.up(), []);
  const onWindowPointerCancel = useCallback(() => handlers.current.cancel(), []);
  const onWindowKeyDown = useCallback((event: KeyboardEvent) => handlers.current.key(event), []);

  const endSession = useCallback(
    (commit: boolean) => {
      const current = session.current;
      session.current = null;
      window.removeEventListener("pointermove", onWindowPointerMove);
      window.removeEventListener("pointerup", onWindowPointerUp);
      window.removeEventListener("pointercancel", onWindowPointerCancel);
      window.removeEventListener("keydown", onWindowKeyDown);
      if (!current) return;
      // Only a drag that began *on the handle* ends with a click on that
      // handle. Swallowing one after a row long press would instead eat the
      // user's next, unrelated tap on some handle.
      suppressClick.current = current.moved && current.fromHandle;
      setActiveId(null);
      setProjection(null);
      // A cancelled (or never-really-started) drag must not mutate anything.
      if (!commit || !current.active || !current.projection) return;
      commitMove(current.taskId, current.projection.parentId, current.projection.index);
    },
    [commitMove, onWindowPointerMove, onWindowPointerUp, onWindowPointerCancel, onWindowKeyDown],
  );

  handlers.current = {
    move: (event: PointerEvent) => {
      const current = session.current;
      if (!current) return;
      const offsetX = event.clientX - current.startX;
      const offsetY = event.clientY - current.startY;
      if (!current.active) {
        if (Math.abs(offsetX) < DRAG_START_THRESHOLD && Math.abs(offsetY) < DRAG_START_THRESHOLD) return;
        current.active = true;
        setActiveId(current.taskId);
      }
      current.moved = true;
      const slot = slotFromPointer(current.rects, event.clientY);
      const next = projectDrop({
        rows: current.rows,
        slot,
        activeDepth: current.activeDepth,
        offsetX,
        rootParentId: latest.current.rootGroup?.parentId ?? null,
      });
      if (sameProjection(next, current.projection)) return;
      current.projection = next;
      setProjection(next);
      setIndicatorTop(indicatorTopFor(current.rects, slot));
    },
    up: () => endSession(true),
    cancel: () => endSession(false),
    key: (event: KeyboardEvent) => {
      if (event.key === "Escape") endSession(false);
    },
  };

  const startSession = useCallback(
    (taskId: number, clientX: number, clientY: number, immediate: boolean, fromHandle: boolean) => {
      if (!latest.current.rootGroup || latest.current.pendingId !== null) return;
      if (session.current) endSession(false);
      const snapshot = snapshotRows(taskId);
      if (!snapshot) return;
      const next: DragSession = {
        taskId,
        startX: clientX,
        startY: clientY,
        activeDepth: snapshot.activeDepth,
        rows: snapshot.rows,
        rects: snapshot.rects,
        active: immediate,
        moved: false,
        fromHandle,
        projection: null,
      };
      session.current = next;
      window.addEventListener("pointermove", onWindowPointerMove);
      window.addEventListener("pointerup", onWindowPointerUp);
      window.addEventListener("pointercancel", onWindowPointerCancel);
      window.addEventListener("keydown", onWindowKeyDown);
      if (immediate) {
        setActiveId(taskId);
        const slot = slotFromPointer(snapshot.rects, clientY);
        const initial = projectDrop({
          rows: snapshot.rows,
          slot,
          activeDepth: snapshot.activeDepth,
          offsetX: 0,
          rootParentId: latest.current.rootGroup.parentId,
        });
        next.projection = initial;
        setProjection(initial);
        setIndicatorTop(indicatorTopFor(snapshot.rects, slot));
      }
    },
    [
      endSession,
      indicatorTopFor,
      snapshotRows,
      onWindowPointerMove,
      onWindowPointerUp,
      onWindowPointerCancel,
      onWindowKeyDown,
    ],
  );

  useEffect(
    () => () => {
      if (session.current) endSession(false);
    },
    [endSession],
  );

  const beginDrag = useCallback(
    (taskId: number, clientX: number, clientY: number) => startSession(taskId, clientX, clientY, false, true),
    [startSession],
  );
  const beginLongPressDrag = useCallback(
    (taskId: number, clientX: number, clientY: number) => startSession(taskId, clientX, clientY, true, false),
    [startSession],
  );

  const consumeDragClick = useCallback(() => {
    const suppressed = suppressClick.current;
    suppressClick.current = false;
    return suppressed;
  }, []);

  const toggleSelect = useCallback((taskId: number) => {
    setSelectedId((prev) => (prev === taskId ? null : taskId));
  }, []);

  const moveBy = useCallback(
    (taskId: number, direction: OrganizeDirection) => {
      const { effectiveTasks: current, rootGroup: group } = latest.current;
      if (!group) return;
      const located = locateTask(current, taskId, group.parentId);
      if (!located) return;
      switch (direction) {
        case "up":
          if (located.index === 0) return;
          commitMove(taskId, located.parentId, located.index - 1);
          return;
        case "down":
          if (located.index >= located.siblings.length - 1) return;
          commitMove(taskId, located.parentId, located.index + 1);
          return;
        case "indent": {
          const previous = located.siblings[located.index - 1];
          if (!previous) return;
          commitMove(taskId, previous.id, previous.children.length);
          return;
        }
        case "outdent": {
          if (located.parentId === group.parentId || located.parentId === null) return;
          const parent = locateTask(current, located.parentId, group.parentId);
          if (!parent) return;
          commitMove(taskId, parent.parentId, parent.index + 1);
          return;
        }
        default:
      }
    },
    [commitMove],
  );

  const dragDepthDelta = useMemo(() => {
    if (activeId === null || !projection) return 0;
    const located = locateTask(effectiveTasks, activeId, rootGroup?.parentId ?? null);
    return located ? projection.depth - located.depth : 0;
  }, [activeId, projection, effectiveTasks, rootGroup]);

  /** Spoken/braille feedback for the current drop target (drag has no visual for AT). */
  const announcement = useMemo(() => {
    if (activeId === null || !projection || !rootGroup) return "";
    const dragged = locateTask(effectiveTasks, activeId, rootGroup.parentId);
    if (!dragged) return "";
    const parent =
      projection.parentId !== null && projection.parentId !== rootGroup.parentId
        ? locateTask(effectiveTasks, projection.parentId, rootGroup.parentId)
        : null;
    const target = parent ? `${strings.dropUnder} „${parent.task.title}“` : strings.dropTopLevel;
    return `${dragged.task.title}: ${target} · ${strings.dropPosition} ${projection.index + 1}`;
  }, [activeId, projection, effectiveTasks, rootGroup]);

  const value = useMemo<OutlineOrganizeValue>(
    () => ({
      enabled,
      activeId,
      selectedId,
      pendingId,
      projection,
      dragDepthDelta,
      expandRequest,
      errors,
      registerRow,
      beginDrag,
      beginLongPressDrag,
      toggleSelect,
      consumeDragClick,
      moveBy,
      clearError,
    }),
    [
      enabled,
      activeId,
      selectedId,
      pendingId,
      projection,
      dragDepthDelta,
      expandRequest,
      errors,
      registerRow,
      beginDrag,
      beginLongPressDrag,
      toggleSelect,
      consumeDragClick,
      moveBy,
      clearError,
    ],
  );

  const selected = useMemo(() => {
    if (selectedId === null || !rootGroup) return null;
    const located = locateTask(effectiveTasks, selectedId, rootGroup.parentId);
    if (!located) return null;
    return {
      task: located.task,
      canMoveUp: located.index > 0,
      canMoveDown: located.index < located.siblings.length - 1,
      canIndent: located.index > 0,
      canOutdent: located.parentId !== rootGroup.parentId && located.parentId !== null,
    };
  }, [selectedId, effectiveTasks, rootGroup]);

  return {
    /** The tree to render: server data, or the optimistic tree while a move is pending. */
    tasks: effectiveTasks,
    enabled,
    value,
    containerRef,
    projection,
    indicatorTop,
    indentWidth: INDENT_WIDTH,
    announcement,
    selected,
    pendingId,
    moveBy,
    select: setSelectedId,
  };
}
