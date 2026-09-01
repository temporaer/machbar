import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useNavigate } from "react-router-dom";
import type { Task } from "@machbar/shared";
import type { TaskDetailFocusField } from "../lib/taskDetailContext";
import { useStrings } from "../lib/strings";
import type { Strings } from "../lib/strings";
import { formatDate, isOverdue } from "../lib/format";
import { sortByPosition } from "../lib/taskHelpers";
import { useTaskActions } from "../lib/useTaskActions";
import { useSwipeSettings } from "../lib/swipeSettings";
import type { PrimarySwipeAction } from "../lib/swipeSettings";
import { useOutlineOrganizeRow } from "../lib/useOutlineOrganize";
import type { OrganizeDirection } from "../lib/useOutlineOrganize";
import { INDENT_WIDTH } from "../lib/taskTreeMove";
import { useIdentity } from "../lib/identity";
import { MemberSelectionSheet } from "./MemberSelectionSheet";
import {
  TaskQuickActionSheet,
  type TaskQuickAction,
} from "./TaskQuickActionSheet";
import { InlineChildComposer } from "./InlineChildComposer";
import { InlineSuccessorComposer } from "./InlineSuccessorComposer";
import { MoveTaskSheet } from "./MoveTaskSheet";
import { IconActionButton } from "./IconActionButton";
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
import { useHorizontalSwipe } from "../lib/useHorizontalSwipe";
import {
  extractPaperlessReferences,
  markdownWithoutPaperlessReferences,
} from "../lib/paperlessAttachments";
import { TaskRowAttachmentPreview } from "./TaskRowAttachmentPreview";

const LONG_PRESS_MS = 480;

/** Arrow keys on the focused drag handle are the pointer-free equivalent of dragging. */
const KEY_DIRECTIONS: Record<string, OrganizeDirection> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowRight: "indent",
  ArrowLeft: "outdent",
};

/**
 * Lets blocker-focused views open the external-wait follow-up editor while
 * preserving the normal task-row swipe behavior.
 */
export interface TaskRowWaitingInteraction {
  /**
   * Hands an externally blocked task back to the host so it can open its
   * timestamped follow-up UI.
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
  onOpenDetail,
  taskActions,
  waitingInteraction,
  showRevisitDate = false,
}: TaskRowProps) {
  const strings = useStrings();
  const { locale } = useLocale();
  const [collapsed, setCollapsed] = useState(false);
  const [chipsOpen, setChipsOpen] = useState(false);
  const [quickAction, setQuickAction] = useState<TaskQuickAction | null>(null);
  const [childComposerOpen, setChildComposerOpen] = useState(false);
  const [successorComposerOpen, setSuccessorComposerOpen] = useState(false);
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
  const navigate = useNavigate();
  // Structural editing (drag handle, keyboard moves, drop preview) is
  // provided by the surrounding `TaskOutline`; it stays absent — and every
  // handle with it — in views whose row order carries no hierarchy meaning.
  const organize = useOutlineOrganizeRow();
  const {
    requestToggle,
    requestPrimarySwipe,
    update,
    assignOwner,
    isPending,
    retained,
    errors,
    clearError,
  } = taskActions;
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

  useEffect(() => {
    if (!outlineRefreshing) return;
    setQuickAction(null);
    setAssignProjectOpen(false);
    setChildComposerOpen(false);
    setSuccessorComposerOpen(false);
  }, [outlineRefreshing]);

  // A task dropped into this row while it was collapsed would be invisible
  // right after the move, so the outline asks the destination parent to
  // reveal its children (collapse state is per row and lives here).
  const expandRequest = organize?.expandRequest ?? null;
  useEffect(() => {
    if (expandRequest?.taskId === taskProp.id) setCollapsed(false);
  }, [expandRequest, taskProp.id]);

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
    onPrimary: () => requestPrimarySwipe(task, primarySwipeAction),
    onSecondary: () => setChipsOpen(true),
    onRealDrag: clearLongPress,
  });
  // Only one swipe background may be visible at a time — mid-drag it
  // follows the live direction, and once a left-swipe has opened the chip
  // strip the red "more actions" background stays shown until the chips close.
  const showCompleteBg = dragX > 0;
  const showCancelBg = dragX < 0 || chipsOpen;
  const primarySwipeLabel = primaryActionBgLabel(task, primarySwipeAction, strings);
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

  const openQuickAction = (action: TaskQuickAction) => {
    setQuickAction(action);
    setChipsOpen(false);
  };

  const reopenChip = () => {
    requestToggle(task);
    setChipsOpen(false);
  };

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
      navigate(`/projects/${task.projectId}`);
    } else {
      setAssignProjectOpen(true);
    }
  };

  const closeChips = () => {
    setChipsOpen(false);
    const kebab = kebabButtonRef.current;
    if (kebab && getComputedStyle(kebab).display !== "none") {
      kebab.focus();
    } else {
      mainButtonRef.current?.focus();
    }
  };

  const openChildComposer = () => {
    setChipsOpen(false);
    setChildComposerOpen(true);
  };

  const openSuccessorComposer = () => {
    setChipsOpen(false);
    setSuccessorComposerOpen(true);
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

  const closeSuccessorComposer = () => {
    setSuccessorComposerOpen(false);
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

  const handleSuccessorCreated = () => {
    setSuccessorComposerOpen(false);
    returnFocusToRow();
  };

  return (
    <li
      className={`task-row task-row-surface-${task.status}`}
      style={{ listStyle: "none" }}
    >
      <div className={`task-row-swipe-bg complete${showCompleteBg ? " visible" : ""}${swipeCoach.animate ? " swipe-coach-primary" : ""}`} aria-hidden="true">
        {primarySwipeLabel}
      </div>
      <div className={`task-row-swipe-bg cancel${showCancelBg ? " visible" : ""}${swipeCoach.animate ? " swipe-coach-secondary" : ""}`} aria-hidden="true">
        {strings.moreActions}
      </div>
      <div
        ref={contentRef}
        className={`task-row-content${ownerMember ? " has-owner" : ""}${isDragged ? " dragging" : ""}${isSelectedForOrganize ? " organize-selected" : ""}${isMoving ? " moving" : ""}${isRetained ? " retained" : ""}${swipeCoach.animate ? " swipe-coach-preview" : ""}`}
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
            disabled={outlineRefreshing}
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
          disabled={busy}
          onClick={() => requestToggle(task)}
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
            onClick={() => onOpenDetail(task.id)}
          >
            <div className="task-row-header">
              <TaskCardTags tags={task.effectiveTags} />
              <div className={`task-row-title${isDone ? " done" : ""}${isCancelled ? " cancelled" : ""}`}>
                {task.title}
                {task.blocked ? <span aria-label={strings.blockedBy}> 🔒</span> : null}
              </div>
            </div>
            <div className="task-row-meta">
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
        <button
          type="button"
          className="task-row-kebab"
          aria-label={strings.moreActions}
          aria-expanded={chipsOpen}
          disabled={busy}
          ref={kebabButtonRef}
          onClick={() => setChipsOpen((o) => !o)}
        >
          ⋯
        </button>
      </div>
      {swipeCoach.active ? (
        <SwipeCoachHint primaryAction={primarySwipeLabel} onDismiss={swipeCoach.dismiss} />
      ) : null}

      {chipsOpen ? (
        <div className="task-row-chips" role="group" aria-label={strings.moreActions}>
          <IconActionButton kind="owner" label={strings.assign} disabled={busy} onClick={() => openQuickAction("owner")} />
          <IconActionButton kind="schedule" label={strings.schedule} disabled={busy} onClick={() => openQuickAction("schedule")} />
          <IconActionButton kind="notes" label={strings.notes} disabled={busy} onClick={() => openQuickAction("notes")} />
          <IconActionButton
            kind="child"
            label={strings.addChild}
            disabled={busy}
            onClick={openChildComposer}
          />
          <IconActionButton
            kind="successor"
            label={strings.addSuccessor}
            disabled={busy}
            onClick={openSuccessorComposer}
          />
          <IconActionButton
            kind="project"
            label={task.projectId ? strings.toProject : strings.assignProject}
            disabled={busy}
            onClick={goToProjectChip}
          />
          {isDone || isCancelled ? (
            <IconActionButton kind="reopen" label={strings.reopen} disabled={busy} onClick={reopenChip} />
          ) : null}
          {waitingInteraction && task.externalWait ? (
            <IconActionButton kind="followUp" label={strings.followUp} disabled={busy} onClick={followUpChip} />
          ) : null}
          <IconActionButton kind="more" label={strings.more} disabled={outlineRefreshing} onClick={() => onOpenDetail(task.id)} />
          <IconActionButton kind="close" label={strings.close} onClick={closeChips} />
        </div>
      ) : null}

      {childComposerOpen ? (
        <InlineChildComposer
          parentId={task.id}
          onCancel={closeChildComposer}
          onCreated={handleChildCreated}
        />
      ) : null}

      {successorComposerOpen ? (
        <InlineSuccessorComposer
          predecessorId={task.id}
          onCancel={closeSuccessorComposer}
          onCreated={handleSuccessorCreated}
        />
      ) : null}

      {quickAction === "owner" ? (
        <MemberSelectionSheet
          title={`${strings.assign}: ${task.title}`}
          label={strings.owner}
          idPrefix={`quick-owner-${task.id}`}
          members={members}
          value={task.effectiveOwnerId}
          valueIsExplicit={task.effectiveOwnerSource === "task"}
          unassignedLabel={strings.shared}
          onClose={() => setQuickAction(null)}
          onSelect={async (ownerMemberId) => {
            await assignOwner(task, ownerMemberId);
          }}
        />
      ) : quickAction ? (
        <TaskQuickActionSheet
          task={task}
          action={quickAction}
          onClose={() => setQuickAction(null)}
          onSave={async (patch, optimisticPatch) => {
            await update(task, patch, optimisticPatch, true);
          }}
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
