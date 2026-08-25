import { useCallback, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { Task } from "@machbar/shared";
import { strings } from "../lib/strings";
import { formatDate, isOverdue } from "../lib/format";
import { sortByPosition } from "../lib/taskHelpers";
import { useTaskActions } from "../lib/useTaskActions";
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
  onOpenDetail: (taskId: number) => void;
  onPickParent: (task: Task) => void;
  onPickProject: (task: Task, subtree: boolean) => void;
  taskActions: ReturnType<typeof useTaskActions>;
}

export function TaskRow({
  task,
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
  const dragState = useRef<{ startX: number; dragging: boolean; pointerId: number | null }>({
    startX: 0,
    dragging: false,
    pointerId: null,
  });
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { bump } = useRefresh();
  const { members } = useIdentity();
  const { requestToggle, requestCancel, busyId } = taskActions;

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
      if (organizeMode) return;
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
    [organizeMode, onEnterOrganizeMode],
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
      requestToggle(task);
    } else if (dragX < -SWIPE_THRESHOLD) {
      requestCancel(task);
    }
    setDragX(0);
  }, [dragX, requestToggle, requestCancel, task]);

  const moveUp = () => void api.reorderTask(task.id, index - 1).then(bump);
  const moveDown = () => void api.reorderTask(task.id, index + 1).then(bump);
  const indent = () => void api.indentTask(task.id).then(bump);
  const outdent = () => void api.outdentTask(task.id).then(bump);

  return (
    <li className="task-row" style={{ listStyle: "none" }}>
      <div className="task-row-swipe-bg complete" aria-hidden="true">
        {strings.done}
      </div>
      <div className="task-row-swipe-bg cancel" aria-hidden="true">
        {strings.cancelled}
      </div>
      <div
        className={`task-row-content${organizeMode ? " organizing" : ""}`}
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
        <button
          type="button"
          className={`task-row-checkbox${isDone ? " done" : ""}${isCancelled ? " cancelled" : ""}`}
          aria-label={isDone || isCancelled ? strings.reopen : strings.done}
          disabled={busyId === task.id}
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
      </div>

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
