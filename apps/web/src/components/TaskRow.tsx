import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useNavigate } from "react-router-dom";
import type { Task, TaskStatus } from "@machbar/shared";
import type { TaskDetailFocusField } from "../lib/taskDetailContext";
import { strings } from "../lib/strings";
import { formatDate, isOverdue } from "../lib/format";
import { sortByPosition } from "../lib/taskHelpers";
import { useTaskActions } from "../lib/useTaskActions";
import { useSwipeSettings } from "../lib/swipeSettings";
import type { PrimarySwipeAction } from "../lib/swipeSettings";
import { useOutlineOrganizeRow } from "../lib/useOutlineOrganize";
import type { OrganizeDirection } from "../lib/useOutlineOrganize";
import { INDENT_WIDTH } from "../lib/taskTreeMove";
import { useIdentity } from "../lib/identity";
import {
  TaskQuickActionSheet,
  type TaskQuickAction,
} from "./TaskQuickActionSheet";
import { InlineChildComposer } from "./InlineChildComposer";
import { MoveTaskSheet } from "./MoveTaskSheet";
import { TaskActionIcon } from "./TaskActionIcon";

const SWIPE_THRESHOLD = 72;
const LONG_PRESS_MS = 480;

/** Arrow keys on the focused drag handle are the pointer-free equivalent of dragging. */
const KEY_DIRECTIONS: Record<string, OrganizeDirection> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowRight: "indent",
  ArrowLeft: "outdent",
};

/**
 * Opts a `TaskOutline`/`TaskRow` tree into "waiting row mode", used by the
 * Warten page's own outline. Its mere presence (regardless of `onFollowUp`
 * actually doing anything) switches the primary (right) swipe from the
 * globally configured `PrimarySwipeAction` to always setting the task back
 * to `actionable` — "erledigen"/"Irgendwann"/"Verwerfen" make no sense
 * against a row that is, by construction, always `waiting` here — while
 * still going through the existing optimistic retention/error flow (see
 * `useTaskActions`), completely independent of the global swipe setting
 * stored by `useSwipeSettings`.
 */
export interface TaskRowWaitingInteraction {
  /**
   * Hands a waiting task back to the host so it can open its own follow-up
   * UI (e.g. `WaitingFollowUpSheet`). Only offered as a chip when the task
   * is still `waiting` — a row that a swipe/chip already turned actionable
   * has nothing left to "follow up" on.
   */
  onFollowUp: (task: Task) => void;
}

export interface TaskRowProps {
  task: Task;
  /** The immediate parent task, or null when `task` sits at the project root. */
  parentTask: Task | null;
  /** Nesting level, used for the outline's flat drag/drop projection. */
  depth: number;
  onOpenDetail: (taskId: number, focusField?: TaskDetailFocusField) => void;
  taskActions: ReturnType<typeof useTaskActions>;
  /** See `TaskRowWaitingInteraction`. Absent everywhere but the Warten page's outline. */
  waitingInteraction?: TaskRowWaitingInteraction | undefined;
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
  onOpenDetail,
  taskActions,
  waitingInteraction,
}: TaskRowProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [dragX, setDragX] = useState(0);
  const [chipsOpen, setChipsOpen] = useState(false);
  const [quickAction, setQuickAction] = useState<TaskQuickAction | null>(null);
  const [childComposerOpen, setChildComposerOpen] = useState(false);
  // Only reachable for a projectless task (see `projectChipClick`) — the
  // existing searchable/recent project picker, restricted to its
  // project-only step so no parent picker is shown for a plain assignment.
  const [assignProjectOpen, setAssignProjectOpen] = useState(false);
  // The "Teilaufgabe hinzufügen" button itself lives inside the collapsible
  // chip strip (unmounted whenever the composer replaces it), so focus is
  // returned to the always-mounted kebab button instead — the closest
  // stable element in this task's own row ("vicinity" of the task/new
  // child), which also re-opens the chip strip if pressed again.
  const kebabButtonRef = useRef<HTMLButtonElement>(null);
  const dragState = useRef<{ startX: number; dragging: boolean; pointerId: number | null; captured: boolean }>({
    startX: 0,
    dragging: false,
    pointerId: null,
    captured: false,
  });
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A long press turns into a structural drag, but the browser still
  // synthesises a click on whatever the finger came down on when it is
  // lifted — which would open the detail sheet right after the move. Same
  // one-shot idea as `ProjectStoryRow`'s `swallowNextClick`, reset by the
  // next `pointerdown` so ordinary taps are never affected. (The swipe
  // gesture doesn't need it: it takes pointer capture past the 8 px slop,
  // which retargets the compatibility mouse events to the container.)
  const swallowNextClick = useRef(false);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const { members } = useIdentity();
  const { primarySwipeAction } = useSwipeSettings();
  const navigate = useNavigate();
  // Structural editing (drag handle, keyboard moves, drop preview) is
  // provided by the surrounding `TaskOutline`; it stays absent — and every
  // handle with it — in views whose row order carries no hierarchy meaning.
  const organize = useOutlineOrganizeRow();
  const {
    requestToggle,
    requestPrimarySwipe,
    setStatus,
    quickUpdate,
    busyId,
    retained,
    errors,
    clearError,
  } = taskActions;

  // A row that just transitioned keeps rendering with its optimistic status
  // (crossed out / muted) for a few seconds even once the compiled view
  // (Heute/Eingang/Suche/…) no longer contains it — see `useTaskActions`'s
  // `retained` map. Once the request is no longer busy, the optimistic row
  // remains fully actionable so another swipe can immediately continue the
  // state cycle (for example erledigt -> wieder offen).
  const retainedTask = retained.get(taskProp.id);
  const task = retainedTask ?? taskProp;
  const isRetained = Boolean(retainedTask);
  const statusError = errors[taskProp.id];
  const organizeError = organize?.errors[taskProp.id];
  const rowError = statusError ?? organizeError;

  const organizeEnabled = organize?.enabled ?? false;
  const isDragged = organize?.activeId === taskProp.id;
  const isSelectedForOrganize = organize?.selectedId === taskProp.id;
  const isMoving = organize?.pendingId === taskProp.id;
  // While dragging, the row itself previews the projected level so the drop
  // depth is obvious even before the insertion line is read.
  const dragDepthShift = isDragged ? (organize?.dragDepthDelta ?? 0) * INDENT_WIDTH : 0;

  // Keep the outline's row registry in sync: it is what turns the rendered
  // (and therefore currently *visible*, i.e. non-collapsed) tree into the
  // flat, ordered list a pointer drag projects against.
  const registerRow = organize?.registerRow;
  const parentTaskId = parentTask?.id ?? null;
  useEffect(() => {
    if (!registerRow) return undefined;
    const row = { taskId: taskProp.id, parentId: parentTaskId, depth };
    registerRow(taskProp.id, row, contentRef.current);
    return () => registerRow(taskProp.id, row, null);
  }, [registerRow, taskProp.id, parentTaskId, depth]);

  // A task dropped into this row while it was collapsed would be invisible
  // right after the move, so the outline asks the destination parent to
  // reveal its children (collapse state is per row and lives here).
  const expandRequest = organize?.expandRequest ?? null;
  useEffect(() => {
    if (expandRequest?.taskId === taskProp.id) setCollapsed(false);
  }, [expandRequest, taskProp.id]);

  // Only one swipe background may be visible at a time — mid-drag it
  // follows the live direction, and once a left-swipe has opened the chip
  // strip the red "more actions" background stays shown (matching the
  // "remains open after drag reset" requirement) until the chips close.
  const showCompleteBg = dragX > 0;
  const showCancelBg = dragX < 0 || chipsOpen;

  const children = sortByPosition(task.children);
  const isDone = task.status === "done";
  const isCancelled = task.status === "cancelled";
  const overdue = isOverdue(task.dueDate, task.status);
  const ownerName = task.effectiveOwnerId ? members.find((m) => m.id === task.effectiveOwnerId)?.name : null;
  const due = formatDate(task.dueDate);

  const clearLongPress = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (busyId === task.id || organize?.activeId != null) return;
      swallowNextClick.current = false;
      dragState.current = { startX: e.clientX, dragging: true, pointerId: e.pointerId, captured: false };
      // Long press is the touch shortcut into the same drag the visible
      // handle starts; the coordinates of the press become the drag origin.
      // Without structural editing there is nothing for it to start, and
      // arming it anyway would only cancel the swipe the user is making.
      if (!organizeEnabled) return;
      const { clientX, clientY } = e;
      longPressTimer.current = setTimeout(() => {
        dragState.current.dragging = false;
        setDragX(0);
        swallowNextClick.current = true;
        organize?.beginLongPressDrag(task.id, clientX, clientY);
      }, LONG_PRESS_MS);
    },
    [busyId, task.id, organize, organizeEnabled],
  );

  const handlePointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragState.current.dragging) return;
    const delta = e.clientX - dragState.current.startX;
    if (Math.abs(delta) > 8) clearLongPress();
    // Capture the pointer only once this is a real drag: a captured pointer
    // also retargets the compatibility mouse events of the row's buttons and
    // links to this container, which would swallow plain clicks. Not every
    // environment implements pointer capture (e.g. jsdom in tests), so the
    // call stays guarded.
    if (!dragState.current.captured && Math.abs(delta) > 8) {
      dragState.current.captured = true;
      const target = e.currentTarget;
      if (typeof target.setPointerCapture === "function") {
        target.setPointerCapture(e.pointerId);
      }
    }
    setDragX(Math.max(-140, Math.min(140, delta)));
  }, []);

  const finishDrag = useCallback(() => {
    clearLongPress();
    if (!dragState.current.dragging) return;
    dragState.current.dragging = false;
    if (dragX > SWIPE_THRESHOLD) {
      if (waitingInteraction) {
        // Waiting row mode overrides the globally configured primary swipe
        // action: the one transition that ever makes sense against a
        // waiting row is "wieder machbar", so it always applies here
        // regardless of what `useSwipeSettings` currently holds — while
        // still going through `setStatus`'s existing optimistic
        // retention/error flow, same as every other status swipe.
        setStatus(task, "actionable");
      } else {
        // One configurable direction performs the primary state transition.
        requestPrimarySwipe(task, primarySwipeAction);
      }
    } else if (dragX < -SWIPE_THRESHOLD) {
      // The opposite direction reveals the touch-chip row instead of acting.
      setChipsOpen(true);
    }
    setDragX(0);
  }, [dragX, requestPrimarySwipe, setStatus, task, primarySwipeAction, waitingInteraction]);

  const openQuickAction = (action: TaskQuickAction) => {
    setQuickAction(action);
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

  // Only wired up by the host of "waiting row mode" (the Warten page) — see
  // `TaskRowWaitingInteraction`. The icon itself never renders without both
  // `waitingInteraction` and a `waiting` task, so this is only ever called
  // in that combination.
  const followUpChip = () => {
    waitingInteraction?.onFollowUp(task);
    setChipsOpen(false);
  };

  // A task that already belongs to a project keeps navigating straight
  // there. A projectless task has nowhere to navigate to, so the very same
  // icon instead opens the existing project picker (search + recents) —
  // never a disabled dead end.
  const goToProjectChip = () => {
    setChipsOpen(false);
    if (task.projectId) {
      navigate(`/projekte/${task.projectId}`);
    } else {
      setAssignProjectOpen(true);
    }
  };

  const openChildComposer = () => {
    setChipsOpen(false);
    setChildComposerOpen(true);
  };

  // The kebab is `disabled` while a status mutation of this row is in
  // flight, and focusing a disabled button is a no-op that would drop the
  // caret to `<body>`. Fall back to the row's first focusable control so
  // keyboard users always land back inside the task they were editing.
  const returnFocusToRow = () => {
    const kebab = kebabButtonRef.current;
    if (kebab && !kebab.disabled) {
      kebab.focus();
      return;
    }
    contentRef.current?.querySelector<HTMLElement>("button:not(:disabled), a[href]")?.focus();
  };

  // Cancel never mutates anything — the composer just unmounts, and focus
  // returns to the button that opened it (the task/new-child vicinity).
  const closeChildComposer = () => {
    setChildComposerOpen(false);
    returnFocusToRow();
  };

  // Closing the picker — whether by cancelling or after a successful
  // assignment (`MoveTaskSheet` calls `onClose` itself once the save
  // resolves) — returns focus to the row's vicinity, same as every other
  // sheet opened from this row.
  const closeAssignProject = () => {
    setAssignProjectOpen(false);
    returnFocusToRow();
  };

  // Collapsed state lives in this component only, so a freshly created
  // child (nested under a possibly-collapsed row) must be made visible
  // right here once creation succeeds — the refresh bus alone wouldn't
  // reopen it.
  const handleChildCreated = () => {
    setCollapsed(false);
    setChildComposerOpen(false);
    returnFocusToRow();
  };

  return (
    <li className="task-row" style={{ listStyle: "none" }}>
      <div className={`task-row-swipe-bg complete${showCompleteBg ? " visible" : ""}`} aria-hidden="true">
        {waitingInteraction ? strings.makeActionable : primaryActionBgLabel(task, primarySwipeAction)}
      </div>
      <div className={`task-row-swipe-bg cancel${showCancelBg ? " visible" : ""}`} aria-hidden="true">
        {strings.moreActions}
      </div>
      <div
        ref={contentRef}
        className={`task-row-content${isDragged ? " dragging" : ""}${isSelectedForOrganize ? " organize-selected" : ""}${isMoving ? " moving" : ""}${isRetained ? " retained" : ""}`}
        style={
          dragX || dragDepthShift
            ? { transform: `translateX(${dragX + dragDepthShift}px)` }
            : undefined
        }
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={() => {
          clearLongPress();
          dragState.current.dragging = false;
          setDragX(0);
        }}
        onClickCapture={(e) => {
          if (!swallowNextClick.current) return;
          swallowNextClick.current = false;
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        {organizeEnabled ? (
          // The one always-visible structural control per row: press and
          // drag it to move the task, or activate it (mouse, tap or
          // keyboard) to open the single selected-task toolbar. Arrow keys
          // move the task directly, without any pointer at all.
          <button
            type="button"
            className="task-row-drag-handle"
            aria-label={`${strings.moveTask}: ${task.title}`}
            title={strings.moveTask}
            aria-pressed={isSelectedForOrganize}
            aria-busy={isMoving}
            onPointerDown={(e) => {
              e.stopPropagation();
              organize?.beginDrag(taskProp.id, e.clientX, e.clientY);
            }}
            onClick={() => {
              // A real drag ends with a click on the handle; that click must
              // not also toggle the selection.
              if (organize?.consumeDragClick()) return;
              organize?.toggleSelect(taskProp.id);
            }}
            onKeyDown={(e) => {
              const direction = KEY_DIRECTIONS[e.key];
              if (!direction) return;
              e.preventDefault();
              organize?.moveBy(taskProp.id, direction);
            }}
          >
            ⠿
          </button>
        ) : null}
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
        <button
          type="button"
          className="task-row-kebab"
          aria-label={strings.moreActions}
          aria-expanded={chipsOpen}
          disabled={busyId === task.id}
          ref={kebabButtonRef}
          onClick={() => setChipsOpen((o) => !o)}
        >
          ⋯
        </button>
      </div>

      {chipsOpen ? (
        <div className="task-row-chips" role="group" aria-label={strings.moreActions}>
          <TaskActionIcon kind="owner" label={strings.assign} onClick={() => openQuickAction("owner")} />
          <TaskActionIcon kind="schedule" label={strings.schedule} onClick={() => openQuickAction("schedule")} />
          <TaskActionIcon kind="notes" label={strings.notes} onClick={() => openQuickAction("notes")} />
          <TaskActionIcon
            kind="child"
            label={strings.addChild}
            disabled={busyId === task.id}
            onClick={openChildComposer}
          />
          <TaskActionIcon
            kind="project"
            label={task.projectId ? strings.toProject : strings.assignProject}
            onClick={goToProjectChip}
          />
          {isDone || isCancelled ? (
            // A finished/cancelled task has no "waiting" state to toggle —
            // offer the real reopen flow instead of letting this chip fall
            // through to a generic status update (which wouldn't clear
            // completedAt/cancelledAt and would leave them stale).
            <TaskActionIcon kind="reopen" label={strings.reopen} onClick={reopenChip} />
          ) : (
            <TaskActionIcon
              kind={task.status === "waiting" ? "actionable" : "waiting"}
              label={task.status === "waiting" ? strings.makeActionable : strings.waiting}
              onClick={toggleWaitingChip}
            />
          )}
          {waitingInteraction && task.status === "waiting" ? (
            // Only offered by the host of "waiting row mode" (the Warten
            // page) and only against a still-waiting task — see
            // `TaskRowWaitingInteraction`.
            <TaskActionIcon kind="followUp" label={strings.followUp} onClick={followUpChip} />
          ) : null}
          <TaskActionIcon kind="more" label={strings.more} onClick={() => onOpenDetail(task.id)} />
        </div>
      ) : null}

      {childComposerOpen ? (
        <InlineChildComposer
          parentId={task.id}
          onCancel={closeChildComposer}
          onCreated={handleChildCreated}
        />
      ) : null}

      {quickAction ? (
        <TaskQuickActionSheet
          task={task}
          action={quickAction}
          onClose={() => setQuickAction(null)}
          onSave={(patch, optimisticPatch) =>
            quickUpdate(task, patch, optimisticPatch)
          }
        />
      ) : null}

      {assignProjectOpen ? (
        <MoveTaskSheet task={task} mode="project" onClose={closeAssignProject} />
      ) : null}

      {rowError ? (
        <div className="task-row-error" role="alert">
          <span>{organizeError && !statusError ? strings.moveFailed : strings.error}</span>
          <span className="text-muted">{rowError}</span>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => {
              clearError(task.id);
              organize?.clearError(taskProp.id);
            }}
          >
            {strings.close}
          </button>
        </div>
      ) : null}

      {!collapsed && children.length > 0 ? (
        <ul className="task-row-children">
          {children.map((child) => (
            <TaskRow
              key={child.id}
              task={child}
              parentTask={task}
              depth={depth + 1}
              onOpenDetail={onOpenDetail}
              taskActions={taskActions}
              waitingInteraction={waitingInteraction}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
