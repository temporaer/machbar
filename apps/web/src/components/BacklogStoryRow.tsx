import { useCallback, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useNavigate } from "react-router-dom";
import type { Project } from "@machbar/shared";
import { strings } from "../lib/strings";
import { formatDate } from "../lib/format";
import { useIdentity } from "../lib/identity";
import type { useBacklogReviewActions } from "../lib/useBacklogReviewActions";
import { AssignDriverSheet } from "./AssignDriverSheet";
import { PlanDatesSheet } from "./PlanDatesSheet";
import { StoryCriteriaSheet } from "./StoryCriteriaSheet";

const SWIPE_THRESHOLD = 72;

export interface BacklogStoryRowProps {
  story: Project;
  actions: ReturnType<typeof useBacklogReviewActions>;
}

type Sheet = "assign-to-activate" | "assign-driver" | "plan-dates" | "criteria" | null;

/**
 * A single backlog story row. Mirrors `TaskRow`'s gesture/action-strip
 * semantics (see `components/TaskRow.tsx`): a right swipe performs the
 * primary transition (here: activate), a left swipe reveals a row of
 * action chips, and the kebab button is the always-available non-gesture
 * alternative to that same reveal. Unlike `TaskRow`, the primary
 * right-swipe action also has its own dedicated non-gesture button (styled
 * like `TaskRow`'s checkbox), since "activate" has no separate detail-sheet
 * entry point the way task completion does.
 *
 * Every chip that edits a *single* aspect of the story (driver, dates,
 * acceptance criteria) opens its own targeted popup and returns straight to
 * the list; only "Bearbeiten" — deliberately the full editor — navigates to
 * the project detail page.
 */
export function BacklogStoryRow({ story: storyProp, actions }: BacklogStoryRowProps) {
  const [dragX, setDragX] = useState(0);
  const [chipsOpen, setChipsOpen] = useState(false);
  const [sheet, setSheet] = useState<Sheet>(null);
  const dragState = useRef<{ startX: number; dragging: boolean }>({ startX: 0, dragging: false });
  const { members } = useIdentity();
  const navigate = useNavigate();
  const { busyId, retained, errors, clearError, activate, archive, assignDriver, schedule } = actions;

  // See `TaskRow`/`useTaskActions` for the full rationale: a story that just
  // transitioned out of the backlog keeps rendering here — muted, with its
  // new status — for `RETENTION_MS` (~4s) instead of vanishing the instant
  // the list refetches and no longer contains it.
  const retainedStory = retained.get(storyProp.id);
  const story = retainedStory ?? storyProp;
  const isRetained = Boolean(retainedStory);
  const rowError = errors[storyProp.id];
  const busy = busyId === story.id;

  const driver = story.ownerMemberId ? members.find((m) => m.id === story.ownerMemberId) : null;
  const hasDriver = story.ownerMemberId !== null;
  const criteria = story.acceptanceCriteria ?? [];
  const criteriaChecked = criteria.filter((c) => c.checked).length;
  const dueLabel = formatDate(story.dueDate);
  const scheduledLabel = formatDate(story.scheduledDate);
  const openCount = story.openCount ?? 0;
  const doneCount = story.doneCount ?? 0;
  const totalTasks = openCount + doneCount;

  const showActivateBg = dragX > 0;
  const showChipsBg = dragX < 0 || chipsOpen;

  const doActivate = useCallback(() => {
    if (isRetained || busy) return;
    if (!hasDriver) {
      setSheet("assign-to-activate");
      return;
    }
    void activate(story);
  }, [isRetained, busy, hasDriver, activate, story]);

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (isRetained) return;
      dragState.current = { startX: e.clientX, dragging: true };
      const target = e.currentTarget;
      if (typeof target.setPointerCapture === "function") {
        target.setPointerCapture(e.pointerId);
      }
    },
    [isRetained],
  );

  const handlePointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragState.current.dragging) return;
    const delta = e.clientX - dragState.current.startX;
    setDragX(Math.max(-140, Math.min(140, delta)));
  }, []);

  const finishDrag = useCallback(() => {
    if (!dragState.current.dragging) return;
    dragState.current.dragging = false;
    if (dragX > SWIPE_THRESHOLD) {
      doActivate();
    } else if (dragX < -SWIPE_THRESHOLD) {
      setChipsOpen(true);
    }
    setDragX(0);
  }, [dragX, doActivate]);

  const cancelDrag = useCallback(() => {
    dragState.current.dragging = false;
    setDragX(0);
  }, []);

  const goToDetail = () => {
    setChipsOpen(false);
    navigate(`/projekte/${story.id}`);
  };

  return (
    <li className="backlog-row" style={{ listStyle: "none" }}>
      <div className={`backlog-row-swipe-bg activate${showActivateBg ? " visible" : ""}`} aria-hidden="true">
        {strings.activateStory}
      </div>
      <div className={`backlog-row-swipe-bg chips${showChipsBg ? " visible" : ""}`} aria-hidden="true">
        {strings.moreActions}
      </div>
      <div
        className={`backlog-row-content${isRetained ? " retained" : ""}`}
        style={dragX ? { transform: `translateX(${dragX}px)` } : undefined}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={cancelDrag}
      >
        <button
          type="button"
          className="backlog-row-activate"
          aria-label={strings.activateStory}
          disabled={busy || isRetained}
          onClick={doActivate}
        >
          ▶
        </button>
        <div className="backlog-row-main">
          <div className="backlog-row-title">
            {story.title}
            {isRetained ? (
              <span className="backlog-row-status-badge">
                {story.status === "active" ? strings.storyActivated : strings.storyArchived}
              </span>
            ) : null}
          </div>
          <div className="backlog-row-meta">
            <span>
              {strings.criteria}: {criteriaChecked}/{criteria.length}
            </span>
            <span>{driver ? driver.name : strings.noDriver}</span>
            {dueLabel ? (
              <span>
                {strings.due}: {dueLabel}
              </span>
            ) : null}
            {scheduledLabel ? (
              <span>
                {strings.scheduled}: {scheduledLabel}
              </span>
            ) : null}
            <span>
              {strings.taskSummary}: {totalTasks > 0 ? `${doneCount}/${totalTasks}` : strings.taskSummaryNone}
            </span>
          </div>
        </div>
        <button
          type="button"
          className="backlog-row-kebab"
          aria-label={strings.moreActions}
          aria-expanded={chipsOpen}
          disabled={isRetained}
          onClick={() => setChipsOpen((o) => !o)}
        >
          ⋯
        </button>
      </div>

      {chipsOpen ? (
        <div className="backlog-row-chips" role="group" aria-label={strings.moreActions}>
          <button type="button" className="btn btn-sm" onClick={() => setSheet("assign-driver")}>
            {strings.driver}
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setSheet("criteria")}>
            {strings.criteria}
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setSheet("plan-dates")}>
            {strings.planDates}
          </button>
          <button type="button" className="btn btn-sm" onClick={goToDetail}>
            {strings.edit}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setChipsOpen(false);
              void archive(story);
            }}
          >
            {strings.archiveStory}
          </button>
        </div>
      ) : null}

      {rowError ? (
        <div className="backlog-row-error" role="alert">
          <span>{strings.error}</span>
          <span className="text-muted">{rowError}</span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => clearError(story.id)}>
            {strings.close}
          </button>
        </div>
      ) : null}

      {sheet === "assign-to-activate" ? (
        <AssignDriverSheet
          members={members}
          currentOwnerMemberId={story.ownerMemberId}
          activateHint
          onClose={() => setSheet(null)}
          onAssign={async (ownerMemberId) => {
            await activate(story, ownerMemberId);
          }}
        />
      ) : null}

      {sheet === "assign-driver" ? (
        <AssignDriverSheet
          members={members}
          currentOwnerMemberId={story.ownerMemberId}
          activateHint={false}
          onClose={() => setSheet(null)}
          onAssign={(ownerMemberId) => assignDriver(story, ownerMemberId)}
        />
      ) : null}

      {sheet === "criteria" ? (
        <StoryCriteriaSheet story={story} onClose={() => setSheet(null)} />
      ) : null}

      {sheet === "plan-dates" ? (
        <PlanDatesSheet story={story} onClose={() => setSheet(null)} onSave={(patch) => schedule(story, patch)} />
      ) : null}
    </li>
  );
}
