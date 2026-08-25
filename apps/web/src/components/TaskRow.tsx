import { useCallback, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { Task, TaskStatus } from "@machbar/shared";
import type { TaskDetailFocusField } from "../lib/taskDetailContext";
import { strings } from "../lib/strings";
import { formatDate, isOverdue } from "../lib/format";
import { sortByPosition } from "../lib/taskHelpers";
import { useTaskActions } from "../lib/useTaskActions";
import { useSwipeSettings } from "../lib/swipeSettings";
import type { PrimarySwipeAction } from "../lib/swipeSettings";
import { useRefresh } from "../lib/refresh";
import { api } from "../lib/api";
import { useIdentity } from "../lib/identity";

const SWIPE_THRESHOLD = 72;
const LONG_PRESS_MS = 480;

export interface TaskRowProps {
  task: Task;
  /** The immediate parent task, or null when `task` sits at the project root. */
  parentTask: Task | null;
  depth: number;
  index: number;
  /** Sorted sibling list (including `task` itself) so indent/reorder can find neighbours. */
  siblings: Task[];
  organizeMode: boolean;
  onEnterOrganizeMode: () => void;
  onOpenDetail: (taskId: number, focusField?: TaskDetailFocusField) => void;
  onPickParent: (task: Task) => void;
  onPickProject: (task: Task, subtree: boolean) => void;
  taskActions: ReturnType<typeof useTaskActions>;
}

/** Short, status-like label for the primary-swipe reveal background. */
function primaryActionBgLabel(task: Task, action: PrimarySwipeAction): string {
  if (task.status === "done" || task.status === "cancelled") return strings.reopen;
  switch (action) {
    case "waiting":
      return strings.waiting;
    case "someday":
      return strings.someday;
    case "cancel":
      return strings.cancelled;
    case "complete":
    default:
      return strings.done;
  }
}

export function TaskRow({
  task: taskProp,
  parentTask,
  depth,
  index,
  siblings,
  organizeMode,
  onEnterOrganizeMode,
  onOpenDetail,
  onPickParent,
  onPickProject,
  taskActions,
}: TaskRowProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [dragX, setDragX] = useState(0);
  const [chipsOpen, setChipsOpen] = useState(false);
  const dragState = useRef<{ startX: number; dragging: boolean; pointerId: number | null }>({
    startX: 0,
    dragging: false,
    pointerId: null,
  });
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { bump } = useRefresh();
  const { members } = useIdentity();
  const { primarySwipeAction } = useSwipeSettings();
  const { requestToggle, requestPrimarySwipe, setStatus, busyId, retained, errors, clearError } = taskActions;

  // A row that just transitioned keeps rendering with its optimistic status
  // (crossed out / muted) for a few seconds even once the compiled view
  // (Heute/Eingang/Suche/…) no longer contains it — see `useTaskActions`'s
  // `retained` map. While retained, this row's own controls are disabled so
  // a stale/mid-flight task can't be mutated a second time from here.
  const retainedTask = retained.get(taskProp.id);
  const task = retainedTask ?? taskProp;
  const isRetained = Boolean(retainedTask);
  const rowError = errors[taskProp.id];

  const children = sortByPosition(task.children);
  const isDone = task.status === "done";
  const isCancelled = task.status === "cancelled";
  const overdue = isOverdue(task.dueDate, task.status);
  const ownerName = task.effectiveOwnerId ? members.find((m) => m.id === task.effectiveOwnerId)?.name : null;
  const due = formatDate(task.dueDate);
  const previousSibling = index > 0 ? siblings[index - 1] : undefined;

  const clearLongPress = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (organizeMode || isRetained) return;
      dragState.current = { startX: e.clientX, dragging: true, pointerId: e.pointerId };
      // Not every environment implements pointer capture (e.g. jsdom in
      // tests), so guard the call instead of assuming it always exists.
      const target = e.currentTarget;
      if (typeof target.setPointerCapture === "function") {
        target.setPointerCapture(e.pointerId);
      }
      longPressTimer.current = setTimeout(() => {
        onEnterOrganizeMode();
        dragState.current.dragging = false;
        setDragX(0);
      }, LONG_PRESS_MS);
    },
    [organizeMode, isRetained, onEnterOrganizeMode],
  );

  const handlePointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragState.current.dragging) return;
    const delta = e.clientX - dragState.current.startX;
    if (Math.abs(delta) > 8) clearLongPress();
    setDragX(Math.max(-140, Math.min(140, delta)));
  }, []);

  const finishDrag = useCallback(() => {
    clearLongPress();
    if (!dragState.current.dragging) return;
    dragState.current.dragging = false;
    if (dragX > SWIPE_THRESHOLD) {
      // One configurable direction performs the primary state transition.
      requestPrimarySwipe(task, primarySwipeAction);
    } else if (dragX < -SWIPE_THRESHOLD) {
      // The opposite direction reveals the touch-chip row instead of acting.
      setChipsOpen(true);
    }
    setDragX(0);
  }, [dragX, requestPrimarySwipe, task, primarySwipeAction]);

  const moveUp = () => void api.reorderTask(task.id, index - 1).then(bump);
  const moveDown = () => void api.reorderTask(task.id, index + 1).then(bump);
  const indent = () => void api.indentTask(task.id).then(bump);
  const outdent = () => void api.outdentTask(task.id).then(bump);

  const openChip = (field?: TaskDetailFocusField) => {
    onOpenDetail(task.id, field);
    setChipsOpen(false);
  };

  const toggleWaitingChip = () => {
    const next: TaskStatus = task.status === "waiting" ? "actionable" : "waiting";
    setStatus(task, next);
    setChipsOpen(false);
  };

  const reopenChip = () => {
    requestToggle(task);
    setChipsOpen(false);
  };

  return (
    <li className="task-row" style={{ listStyle: "none" }}>
      <div className="task-row-swipe-bg complete" aria-hidden="true">
        {primaryActionBgLabel(task, primarySwipeAction)}
      </div>
      <div className="task-row-swipe-bg cancel" aria-hidden="true">
        {strings.moreActions}
      </div>
      <div
        className={`task-row-content${organizeMode ? " organizing" : ""}${isRetained ? " retained" : ""}`}
        style={dragX ? { transform: `translateX(${dragX}px)` } : undefined}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={() => {
          clearLongPress();
          dragState.current.dragging = false;
          setDragX(0);
        }}
      >
        {children.length > 0 ? (
          <button
            type="button"
            className="task-row-toggle"
            aria-expanded={!collapsed}
            aria-label={collapsed ? strings.expand : strings.collapse}
            onClick={() => setCollapsed((c) => !c)}
          >
            {collapsed ? "▸" : "▾"}
          </button>
        ) : (
          <span className="task-row-toggle" aria-hidden="true" />
        )}
        {/*
          Hidden on coarse pointers (touch) via CSS only — see
          `.task-row-checkbox` in styles/index.css — since swiping/chips
          cover that role there. Kept for mouse/keyboard use, and the
          detail sheet's explicit Erledigen/Wieder-öffnen button (opened by
          tapping the row) remains a non-gesture path everywhere.
        */}
        <button
          type="button"
          className={`task-row-checkbox${isDone ? " done" : ""}${isCancelled ? " cancelled" : ""}`}
          aria-label={isDone || isCancelled ? strings.reopen : strings.done}
          disabled={busyId === task.id || isRetained}
          onClick={() => requestToggle(task)}
        >
          {isDone ? "✓" : isCancelled ? "×" : ""}
        </button>
        <button type="button" className="task-row-main" onClick={() => onOpenDetail(task.id)}>
          <div className={`task-row-title${isDone ? " done" : ""}${isCancelled ? " cancelled" : ""}`}>
            {task.title}
            {task.blocked ? <span aria-label={strings.blockedBy}> 🔒</span> : null}
          </div>
          <div className="task-row-meta">
            {task.status === "waiting" && task.waitingFor ? (
              <span>
                {strings.waitingFor}: {task.waitingFor}
              </span>
            ) : null}
            {due ? (
              <span className={overdue ? "overdue" : undefined}>
                {strings.due}: {due}
              </span>
            ) : null}
            {ownerName ? <span>{ownerName}</span> : null}
            {task.effectiveContext ? <span>#{task.effectiveContext}</span> : null}
            {children.length ? (
              <span>
                {children.filter((c) => c.status === "done" || c.status === "cancelled").length}/{children.length}
              </span>
            ) : null}
          </div>
        </button>
        <button
          type="button"
          className="task-row-kebab"
          aria-label={strings.moreActions}
          aria-expanded={chipsOpen}
          disabled={isRetained}
          onClick={() => setChipsOpen((o) => !o)}
        >
          ⋯
        </button>
      </div>

      {chipsOpen ? (
        <div className="task-row-chips" role="group" aria-label={strings.moreActions}>
          <button type="button" className="btn btn-sm" onClick={() => openChip("owner")}>
            {strings.assign}
          </button>
          <button type="button" className="btn btn-sm" onClick={() => openChip("schedule")}>
            {strings.schedule}
          </button>
          <button type="button" className="btn btn-sm" onClick={() => openChip("notes")}>
            {strings.notes}
          </button>
          {isDone || isCancelled ? (
            // A finished/cancelled task has no "waiting" state to toggle —
            // offer the real reopen flow instead of letting this chip fall
            // through to a generic status update (which wouldn't clear
            // completedAt/cancelledAt and would leave them stale).
            <button type="button" className="btn btn-sm" onClick={reopenChip}>
              {strings.reopen}
            </button>
          ) : (
            <button type="button" className="btn btn-sm" onClick={toggleWaitingChip}>
              {task.status === "waiting" ? strings.makeActionable : strings.waiting}
            </button>
          )}
          <button type="button" className="btn btn-sm" onClick={() => openChip()}>
            {strings.more}
          </button>
        </div>
      ) : null}

      {rowError ? (
        <div className="task-row-error" role="alert">
          <span>{strings.error}</span>
          <span className="text-muted">{rowError}</span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => clearError(task.id)}>
            {strings.close}
          </button>
        </div>
      ) : null}

      {organizeMode ? (
        <div className="organize-controls" role="group" aria-label={strings.organizeControls}>
          <button type="button" className="btn btn-sm" disabled={index === 0} onClick={moveUp}>
            ↑ {strings.moveUp}
          </button>
          <button type="button" className="btn btn-sm" disabled={index === siblings.length - 1} onClick={moveDown}>
            ↓ {strings.moveDown}
          </button>
          <button type="button" className="btn btn-sm" disabled={!previousSibling} onClick={indent}>
            → {strings.indent}
          </button>
          <button type="button" className="btn btn-sm" disabled={!parentTask} onClick={outdent}>
            ← {strings.outdent}
          </button>
          <button type="button" className="btn btn-sm" onClick={() => onPickParent(task)}>
            {strings.changeParent}
          </button>
          <button type="button" className="btn btn-sm" onClick={() => onPickProject(task, false)}>
            {strings.moveProject}
          </button>
          <button type="button" className="btn btn-sm" onClick={() => onPickProject(task, true)}>
            {strings.moveSubtree}
          </button>
        </div>
      ) : null}

      {!collapsed && children.length > 0 ? (
        <ul className="task-row-children">
          {children.map((child, i) => (
            <TaskRow
              key={child.id}
              task={child}
              parentTask={task}
              depth={depth + 1}
              index={i}
              siblings={children}
              organizeMode={organizeMode}
              onEnterOrganizeMode={onEnterOrganizeMode}
              onOpenDetail={onOpenDetail}
              onPickParent={onPickParent}
              onPickProject={onPickProject}
              taskActions={taskActions}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
