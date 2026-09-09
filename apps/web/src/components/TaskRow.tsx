import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { Task } from "@machbar/shared";
import { useStrings } from "../lib/strings";
import type { Strings } from "../lib/strings";
import { formatDate, isOverdue } from "../lib/format";
import { isCapturedInboxItem, sortByPosition } from "../lib/taskHelpers";
import { useTaskActions } from "../lib/useTaskActions";
import { useWorkItemCommands } from "../lib/useWorkItemCommands";
import { useInteractionScope } from "../lib/interactionScope";
import { useSwipeSettings } from "../lib/swipeSettings";
import type { PrimarySwipeAction } from "../lib/swipeSettings";
import { useOutlineOrganizeRow } from "../lib/useOutlineOrganize";
import type { OrganizeDirection } from "../lib/useOutlineOrganize";
import { useNextActionBadge } from "../lib/nextActionBadge";
import { INDENT_WIDTH } from "../lib/taskTreeMove";
import { useIdentity } from "../lib/identity";
import { MarkdownNotes } from "./MarkdownNotes";
import {
  formatExactLocalDate,
  formatRelativeDueDate,
  formatRelativeScheduleDate,
} from "../lib/relativeDate";
import { TaskCardTags } from "./TaskCardTags";
import { MemberAvatar } from "./MemberAvatar";
import { useLocale } from "../lib/locale";
import { useSwipeCoach } from "../lib/swipeCoach";
import { SwipeCoachHint } from "./SwipeCoachHint";
import { RowSwipeBackgrounds, RowKebabButton, RowErrorBanner } from "./WorkItemRowChrome";
import { useHorizontalSwipe, DEEP_ACTION_THRESHOLD } from "../lib/useHorizontalSwipe";
import {
  extractPaperlessReferences,
  markdownWithoutPaperlessReferences,
} from "../lib/paperlessAttachments";
import { TaskRowAttachmentPreview } from "./TaskRowAttachmentPreview";
import { useRailConfig } from "../lib/railConfigContext";
import { WorkItemCommandRail } from "./WorkItemCommandRail";

const LONG_PRESS_MS = 480;

/** Arrow keys on the focused drag handle are the pointer-free equivalent of dragging. */
const KEY_DIRECTIONS: Record<string, OrganizeDirection> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowRight: "indent",
  ArrowLeft: "outdent",
};

export interface TaskRowProps {
  task: Task;
  /** The immediate parent task, or null when `task` sits at the project root. */
  parentTask: Task | null;
  /** Nesting level, used for the outline's flat drag/drop projection. */
  depth: number;
  /** Show this row's external-wait revisit date. */
  showRevisitDate?: boolean;
}

/** Short, status-like label for the primary-swipe reveal background. */
function primaryActionBgLabel(
  task: Task,
  action: PrimarySwipeAction,
  strings: Strings,
): string {
  if (task.status === "done" || task.status === "cancelled") return strings.reopen;
  if (task.status === "captured") return strings.actionable;
  switch (action) {
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
  showRevisitDate = false,
}: TaskRowProps) {
  const strings = useStrings();
  const { locale } = useLocale();
  // Fold state is scope-owned (see `interactionScope.tsx`), not private to
  // this row -- `h`/`l` keyboard shortcuts and future non-row callers need
  // to read/set it from outside whichever row happens to render this item.
  const scope = useInteractionScope();
  const collapsed = scope.isCollapsed(taskProp.id);
  const setCollapsed = useCallback(
    (value: boolean) => scope.setCollapsed(taskProp.id, value),
    [scope, taskProp.id],
  );
  const chipsOpen = scope.openRailId === taskProp.id;
  const kebabButtonRef = useRef<HTMLButtonElement>(null);
  const mainButtonRef = useRef<HTMLButtonElement>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A long press turns into a structural drag, but the browser still
  // synthesises a click on whatever the finger came down on when it is
  // lifted — which would open the detail sheet right after the move. Reset
  // this one-shot guard on the next pointerdown so ordinary taps are safe.
  const swallowLongPressClick = useRef(false);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const { members, currentMemberId } = useIdentity();
  const { primarySwipeAction } = useSwipeSettings();
  const { taskFavorites } = useRailConfig();
  // Structural editing (drag handle, keyboard moves, drop preview) is
  // provided by the surrounding `TaskOutline`; it stays absent — and every
  // handle with it — in views whose row order carries no hierarchy meaning.
  const organize = useOutlineOrganizeRow();
  const dispatch = useWorkItemCommands();
  const { isPending, retained, errors, clearError } = useTaskActions();
  const outlineRefreshing = organize?.pendingId !== null;
  const busy = isPending(taskProp.id) || outlineRefreshing;

  // A row that just transitioned keeps rendering with its optimistic status
  // (crossed out / muted) for a few seconds even once the compiled view
  // (Heute/Eingang/Suche/…) no longer contains it — see `useTaskActions`'s
  // `retained` map. Once the request is no longer busy, the optimistic row
  // remains fully actionable so another swipe can immediately continue the
  // state cycle (for example erledigt -> wieder offen).
  const retainedTask = retained.get(taskProp.id);
  const task = retainedTask ?? taskProp;
  const nextActionBadge = useNextActionBadge(task);
  const attachments = useMemo(
    () => extractPaperlessReferences(task.notes),
    [task.notes],
  );
  const notesWithoutAttachments = useMemo(
    () => markdownWithoutPaperlessReferences(task.notes),
    [task.notes],
  );
  const isRetained = Boolean(retainedTask);
  const statusError = errors[taskProp.id];
  const organizeError = organize?.errors[taskProp.id];
  const rowError = statusError ?? organizeError;

  const organizeEnabled = organize?.enabled ?? false;
  const isDragged = organize?.activeId === taskProp.id;
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
  // reveal its children (collapse state is scope-owned, see above).
  const expandRequest = organize?.expandRequest ?? null;
  useEffect(() => {
    if (expandRequest?.taskId === taskProp.id) setCollapsed(false);
  }, [expandRequest, taskProp.id, setCollapsed]);

  const children = sortByPosition(task.children);
  const isDone = task.status === "done";
  const isCancelled = task.status === "cancelled";
  const overdue = isOverdue(task.dueDate, task.status);
  const ownerMember =
    task.effectiveOwnerId === null
      ? null
      : members.find((m) => m.id === task.effectiveOwnerId) ?? null;
  const ownerLabel =
    task.effectiveOwnerId === null
      ? strings.sharedOwner
      : task.effectiveOwnerId === currentMemberId
        ? strings.me
        : ownerMember?.name ?? strings.unknownMember;
  const due = formatDate(task.dueDate, locale);
  const scheduled = formatDate(task.scheduledDate, locale);
  const projectDueRelative = task.projectDueDate
    ? formatRelativeDueDate(task.projectDueDate, new Date(), locale)
    : null;
  const projectDueExact = task.projectDueDate
    ? formatExactLocalDate(task.projectDueDate, locale)
    : null;
  const revisitRelative =
    showRevisitDate && task.externalWait?.revisitDate
      ? formatRelativeScheduleDate(task.externalWait.revisitDate, new Date(), locale)
      : null;
  const revisitExact =
    showRevisitDate && task.externalWait?.revisitDate
      ? formatExactLocalDate(task.externalWait.revisitDate, locale)
      : null;

  const clearLongPress = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  const {
    dragX,
    handlers: swipeHandlers,
    cancel: cancelSwipe,
  } = useHorizontalSwipe<HTMLDivElement>({
    disabled: busy || organize?.activeId != null,
    onPrimary: () => dispatch({ type: "task.primaryAction", task }),
    onDeepPrimary: () => scope.setOpenLifecycle(taskProp.id),
    onSecondary: () => scope.setOpenRail(taskProp.id),
    onRealDrag: clearLongPress,
  });
  // Only one swipe background may be visible at a time — mid-drag it
  // follows the live direction, and once a left-swipe has opened the chip
  // strip the red "more actions" background stays shown until the chips close.
  const showCompleteBg = dragX > 0;
  const showCancelBg = dragX < 0 || chipsOpen;
  const lifecycleOpen = scope.openLifecycleId === taskProp.id;
  // Live feedback that continuing the drag will open the status rail
  // instead of running the primary action, updated during the drag itself
  // (not just on release) so the switch is visible as it happens.
  const isDeepDrag = dragX >= DEEP_ACTION_THRESHOLD;
  const primarySwipeLabel = isDeepDrag
    ? strings.status
    : primaryActionBgLabel(task, primarySwipeAction, strings);
  const swipeCoach = useSwipeCoach(
    `task:${task.id}`,
    !busy && !isRetained && !chipsOpen,
  );

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (busy || organize?.activeId != null) return;
      swallowLongPressClick.current = false;
      // Long press is the touch shortcut into the same drag the visible
      // handle starts; the coordinates of the press become the drag origin.
      // Without structural editing there is nothing for it to start, and
      // arming it anyway would only cancel the swipe the user is making.
      if (!organizeEnabled) return;
      const { clientX, clientY } = e;
      longPressTimer.current = setTimeout(() => {
        cancelSwipe();
        swallowLongPressClick.current = true;
        organize?.beginLongPressDrag(task.id, clientX, clientY);
      }, LONG_PRESS_MS);
    },
    [busy, task.id, organize, organizeEnabled, cancelSwipe],
  );

  const runRailCommand = (command: (typeof taskFavorites)[number]) => {
    // Move focus to the kebab before the rail (and any open overflow list)
    // unmounts, so a focused-workflow sheet's opener-restore targets a
    // control that stays connected across the close/open transition
    // instead of losing focus to <body>.
    kebabButtonRef.current?.focus();
    scope.setOpenRail(null);
    switch (command) {
      case "task.discard":
        dispatch({ type: command, task });
        return;
      default:
        dispatch({ type: command, taskId: task.id });
    }
  };

  return (
    <li
      className={`task-row task-row-surface-${task.status}`}
      style={{ listStyle: "none" }}
      data-workitem-id={taskProp.id}
      data-workitem-role="task"
    >
      <RowSwipeBackgrounds
        classPrefix="task-row"
        primaryLabel={primarySwipeLabel}
        primaryVisible={showCompleteBg}
        primaryVariantClass={isDeepDrag ? "complete deep" : "complete"}
        secondaryLabel={strings.moreActions}
        secondaryVisible={showCancelBg}
        secondaryVariantClass="cancel"
        coachAnimate={swipeCoach.animate}
      />
      <div
        ref={contentRef}
        className={`task-row-content${ownerMember ? " has-owner" : ""}${isDragged ? " dragging" : ""}${isMoving ? " moving" : ""}${isRetained ? " retained" : ""}${swipeCoach.animate ? " swipe-coach-preview" : ""}`}
        style={
          dragX || dragDepthShift
            ? { transform: `translateX(${dragX + dragDepthShift}px)` }
            : undefined
        }
        onPointerDown={(event) => {
          if (swipeCoach.active && event.pointerType === "touch") {
            swipeCoach.dismiss();
          }
          swipeHandlers.onPointerDown(event);
          handlePointerDown(event);
        }}
        onPointerMove={swipeHandlers.onPointerMove}
        onPointerUp={(event) => {
          clearLongPress();
          swipeHandlers.onPointerUp(event);
        }}
        onPointerCancel={() => {
          clearLongPress();
          cancelSwipe();
        }}
        onClickCapture={(e) => {
          swipeHandlers.onClickCapture(e);
          if (!swallowLongPressClick.current) return;
          swallowLongPressClick.current = false;
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        {organizeEnabled ? (
          // The one always-visible structural control per row: press and
          // drag it to move the task. Arrow keys move the task directly
          // while it has focus, without any pointer at all — a plain
          // click/tap does not open any separate mode.
          <button
            type="button"
            className="task-row-drag-handle"
            aria-label={`${strings.moveTask}: ${task.title}`}
            title={strings.moveTask}
            aria-busy={isMoving}
            disabled={outlineRefreshing}
            onPointerDown={(e) => {
              e.stopPropagation();
              organize?.beginDrag(taskProp.id, e.clientX, e.clientY);
            }}
            onClick={() => {
              // A real drag ends with a click on the handle; swallow it so
              // it has no further effect.
              organize?.consumeDragClick();
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
            onClick={() =>
              dispatch({ type: collapsed ? "outline.expand" : "outline.collapse", workItemId: taskProp.id })
            }
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
          disabled={busy}
          onClick={() => dispatch({ type: "task.toggleDone", task })}
        >
          {isDone ? "✓" : isCancelled ? "×" : ""}
        </button>
        <div className="task-row-main-wrap">
          <button
            type="button"
            className="task-row-main"
            ref={mainButtonRef}
            aria-label={task.title}
            disabled={outlineRefreshing}
            onClick={() => dispatch({ type: "task.open", taskId: task.id })}
          >
            <div className="task-row-header">
              <TaskCardTags
                tags={task.effectiveTags}
                contexts={task.effectiveContexts}
              />
              <div className={`task-row-title${isDone ? " done" : ""}${isCancelled ? " cancelled" : ""}`}>
                {task.title}
                {task.blocked ? <span aria-label={strings.blockedBy}> 🔒</span> : null}
              </div>
            </div>
            <div className="task-row-meta">
              {nextActionBadge ? (
                <span
                  className={`task-row-meta-item task-row-next-action-badge task-row-next-action-${nextActionBadge}`}
                >
                  {nextActionBadge === "canonical"
                    ? strings.nextActionBadgeCanonical
                    : nextActionBadge === "additional"
                      ? strings.nextActionBadgeAdditional
                      : strings.nextActionBadgeMarked}
                </span>
              ) : null}
              {task.status !== "actionable" ? (
                <span className={`task-row-meta-item task-row-state task-row-state-${task.status}`}>
                  {strings.taskStatusLabels[task.status]}
                </span>
              ) : null}
              {task.externalWait?.waitingFor?.trim() ? (
                <span className="task-row-meta-item">
                  {strings.waitingFor}: {task.externalWait.waitingFor.trim()}
                </span>
              ) : null}
              {task.dependencies
                .filter((dependency) => !dependency.resolved)
                .map((dependency) => (
                  <span className="task-row-meta-item" key={dependency.id}>
                    {strings.blockedBy}: {dependency.title ?? `#${dependency.dependsOnTaskId}`}
                  </span>
                ))}
              {due ? (
                <span className={`task-row-meta-item${overdue ? " overdue" : ""}`}>
                  {strings.due}: {due}
                </span>
              ) : null}
              {scheduled ? (
                <span className="task-row-meta-item">
                  {strings.scheduled}: {scheduled}
                </span>
              ) : null}
              {revisitRelative && revisitExact ? (
                <span
                  className="task-row-meta-item"
                  title={`${strings.revisitDate}: ${revisitExact}`}
                  aria-label={`${strings.revisitDate}: ${revisitRelative} (${revisitExact})`}
                >
                  {strings.revisitDate}: {revisitRelative}
                </span>
              ) : null}
              {projectDueRelative && projectDueExact ? (
                <span
                  className="task-row-meta-item task-row-project-due"
                  title={`${strings.projectDue}: ${projectDueExact}`}
                  aria-label={`${strings.projectDue}: ${projectDueRelative} (${projectDueExact})`}
                >
                  {strings.projectDue}: {projectDueRelative}
                </span>
              ) : null}
              {children.length ? (
                <span className="task-row-meta-item">
                  {children.filter((c) => c.status === "done" || c.status === "cancelled").length}/{children.length}
                </span>
              ) : null}
            </div>
            {attachments[0] ? (
              <TaskRowAttachmentPreview
                key={attachments[0].id}
                attachment={attachments[0]}
                count={attachments.length}
              />
            ) : null}
          </button>
          {notesWithoutAttachments ? (
            <MarkdownNotes value={notesWithoutAttachments} className="task-row-notes" />
          ) : null}
        </div>
        {ownerMember ? (
          <span
            className="task-row-owner-avatar"
            aria-label={`${strings.owner}: ${ownerLabel}`}
            title={ownerLabel}
          >
            <MemberAvatar member={ownerMember} size="sm" />
          </span>
        ) : null}
        <RowKebabButton
          classPrefix="task-row"
          open={chipsOpen}
          disabled={busy}
          buttonRef={kebabButtonRef}
          onToggle={() =>
            scope.setOpenRail(chipsOpen ? null : taskProp.id)
          }
        />
      </div>
      {swipeCoach.active ? (
        <SwipeCoachHint primaryAction={primarySwipeLabel} onDismiss={swipeCoach.dismiss} />
      ) : null}

      {chipsOpen ? (
        <WorkItemCommandRail
          kind="task"
          favorites={taskFavorites}
          labels={strings.railCommandLabels}
          labelForCommand={(command) =>
            command === "task.waitingLifecycle" && task.externalWait
              ? strings.followUp
              : strings.railCommandLabels[command]
          }
          groupLabel={strings.moreActions}
          overflowLabel={`${strings.more} …`}
          disabled={busy}
          onCommand={runRailCommand}
          {...(isCapturedInboxItem(task)
            ? { hiddenCommands: ["task.changeProject", "task.split"] as const }
            : {})}
          overflowOpen={scope.openOverflowId === taskProp.id}
          onOverflowChange={(open) => scope.setOpenOverflow(open ? taskProp.id : null)}
        />
      ) : null}
      {lifecycleOpen ? (
        <div className="task-row-lifecycle" role="group" aria-label={strings.status}>
          {(["captured", "actionable", "someday", "done", "cancelled"] as const).map((status) => (
            <button
              key={status}
              type="button"
              className="btn btn-sm"
              disabled={busy || task.status === status}
              aria-current={task.status === status ? "true" : undefined}
              onClick={() => {
                scope.setOpenLifecycle(null);
                dispatch({ type: "task.setStatus", task, status });
              }}
            >
              {strings.taskStatusLabels[status]}
            </button>
          ))}
        </div>
      ) : null}

      {rowError ? (
        <RowErrorBanner
          classPrefix="task-row"
          headline={organizeError && !statusError ? strings.moveFailed : strings.error}
          message={rowError}
          onClose={() => {
            clearError(task.id);
            organize?.clearError(taskProp.id);
          }}
        />
      ) : null}

      {!collapsed && children.length > 0 ? (
        <ul className="task-row-children">
          {children.map((child) => (
            <TaskRow
              key={child.id}
              task={child}
              parentTask={task}
              depth={depth + 1}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
