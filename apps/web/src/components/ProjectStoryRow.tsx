import { useCallback, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import type { ProjectWithActions, ProjectWorkflowAction } from "../lib/api";
import { strings, projectStatusLabels, stuckReasonLabels } from "../lib/strings";
import { formatDate } from "../lib/format";
import {
  formatCompactWaitDuration,
  formatExactLocalDate,
} from "../lib/relativeDate";
import { useIdentity } from "../lib/identity";
import {
  classifyProjectListItem,
  type ProjectListClassification,
} from "../lib/projectListFilter";
import { useRefresh } from "../lib/refresh";
import {
  canClearDriver,
  needsDriverBeforeAction,
  primaryWorkflowAction,
  projectTransitionLabels,
  projectWorkflowIcons,
  projectWorkflowLabels,
  secondaryWorkflowActions,
} from "../lib/projectWorkflow";
import type { useProjectWorkflowActions } from "../lib/useProjectWorkflowActions";
import { AssignDriverSheet } from "./AssignDriverSheet";
import { PlanDatesSheet } from "./PlanDatesSheet";
import { StoryCriteriaSheet } from "./StoryCriteriaSheet";
import { ProjectTagsSheet } from "./ProjectTagsSheet";
import { IconActionButton, IconActionGlyph } from "./IconActionButton";
import { MemberLabel } from "./MemberAvatar";
import "./ProjectStoryRow.css";

const SWIPE_THRESHOLD = 72;
/** Beyond this the pointer sequence counts as a drag, not a tap. */
const DRAG_SLOP = 8;

/**
 * Semantic accent driving the row's status badge, left-edge stripe, primary
 * swipe background and dedicated primary button: six distinguishable looks
 * instead of one blanket "green means go" treatment, so an active story that
 * is waiting or stuck does not read as actionable progress.
 */
type StatusAccent = "backlog" | "active" | "waiting" | "stuck" | "completed" | "archived";

const statusAccentByClassification: Record<ProjectListClassification, StatusAccent> = {
  "active-actionable": "active",
  "active-stuck": "stuck",
  "healthy-waiting": "waiting",
  backlog: "backlog",
  completed: "completed",
  archived: "archived",
};

export interface ProjectStoryRowProps {
  story: ProjectWithActions;
  actions: ReturnType<typeof useProjectWorkflowActions>;
  /**
   * `compact` — the Backlog-Review meta line (criteria, driver, dates, tasks).
   * `card` — the Projekte tab: same meta plus next action and the task /
   * acceptance-criteria progress bars.
   */
  variant?: "compact" | "card";
}

type Sheet = "assign-to-activate" | "assign-driver" | "plan-dates" | "criteria" | "tags" | null;

/**
 * One story row with the full mobile workflow gestures, shared by the
 * Projekte tab (`ProjectsPage`) and Backlog Review (`BacklogReviewPage`).
 *
 * Gestures mirror `TaskRow`'s semantics: a **right swipe** performs the
 * status-appropriate primary transition (backlog → aktivieren, aktiv →
 * abschließen, abgeschlossen → wieder öffnen, archiviert → aktivieren), a
 * **left swipe** reveals the action-chip strip, and the kebab button is the
 * always-available non-gesture alternative to that reveal. Unlike `TaskRow`,
 * the primary action also keeps its own dedicated button on touch devices
 * (`.story-row-primary`): a story workflow has no detail-sheet button that
 * doubles as its non-gesture path, so the row must provide one itself.
 *
 * Only transitions the backend advertises in `availableActions` are ever
 * offered; every remaining legal one appears as a chip (e.g. "In Backlog
 * zurücklegen", "Archivieren"). Chips that edit a *single* aspect (driver,
 * dates, acceptance criteria, tags) open their own targeted popup and return
 * straight to the list; "Projekt öffnen" navigates to the project page, and
 * tapping the row itself still opens the story detail as before.
 */
export function ProjectStoryRow({ story: storyProp, actions, variant = "compact" }: ProjectStoryRowProps) {
  const [dragX, setDragX] = useState(0);
  const [chipsOpen, setChipsOpen] = useState(false);
  const [sheet, setSheet] = useState<Sheet>(null);
  const dragState = useRef<{ startX: number; dragging: boolean; captured: boolean }>({
    startX: 0,
    dragging: false,
    captured: false,
  });
  // Set when a pointer sequence turned into a real drag, so the click the
  // browser synthesises afterwards does not navigate to the detail page.
  const swallowNextClick = useRef(false);
  const { members } = useIdentity();
  const { bump } = useRefresh();
  const navigate = useNavigate();
  const { busyId, retained, errors, clearError, runAction, activate, assignDriver, schedule } = actions;

  // A story that just transitioned keeps rendering here — muted, with the
  // past-tense confirmation of what happened — for `RETENTION_MS` (~4s)
  // instead of snapping to its refetched state immediately. Exactly like the
  // task list, the row stays *actionable* the moment the request resolves
  // (only `busyId` disables it), so workflows can be cycled straight away.
  const retainedEntry = retained.get(storyProp.id);
  const story = retainedEntry?.story ?? storyProp;
  const isRetained = Boolean(retainedEntry);
  const rowError = errors[storyProp.id];
  const busy = busyId === story.id;

  const driver = story.ownerMemberId ? members.find((m) => m.id === story.ownerMemberId) : null;
  const criteria = story.acceptanceCriteria ?? [];
  const criteriaChecked = criteria.filter((c) => c.checked).length;
  const dueLabel = formatDate(story.dueDate);
  const scheduledLabel = formatDate(story.scheduledDate);
  const openCount = story.openCount ?? 0;
  const doneCount = story.doneCount ?? 0;
  const totalTasks = openCount + doneCount;

  const primaryAction = primaryWorkflowAction(story);
  const primaryLabel = primaryAction ? projectWorkflowLabels[primaryAction] : strings.workflowStep;
  const secondaryActions = secondaryWorkflowActions(story);
  const statusLabel = retainedEntry
    ? projectTransitionLabels[retainedEntry.action]
    : projectStatusLabels[story.status];
  const classification = classifyProjectListItem(story);
  const accent = statusAccentByClassification[classification];
  const isHealthyWaiting = classification === "healthy-waiting";
  const waitingOn = story.waitingOn ?? [];
  const waitingDuration = story.waitingUntil
    ? formatCompactWaitDuration(story.waitingUntil)
    : null;
  const waitingUntilExact = story.waitingUntil
    ? formatExactLocalDate(story.waitingUntil)
    : null;
  const waitingDurationSuffix = waitingDuration ? ` · noch ${waitingDuration}` : "";
  const waitingOnSummary =
    waitingOn.length > 0
      ? `${strings.waitingOn}: ${waitingOn.slice(0, 2).join(" · ")}${
          waitingOn.length > 2 ? ` · ${strings.waitingOnMore(waitingOn.length - 2)}` : ""
        }${waitingDurationSuffix}`
      : `${strings.waitingReasonMissing}${waitingDurationSuffix}`;
  const nextOpenCriterion = criteria.find((criterion) => !criterion.checked);
  const criterionSummary =
    criteria.length === 0
      ? null
      : nextOpenCriterion
        ? `${strings.criteria}: ${nextOpenCriterion.text}`
        : strings.resultComplete;

  const showPrimaryBg = dragX > 0;
  const showChipsBg = dragX < 0 || chipsOpen;

  const doPrimary = useCallback(() => {
    if (busy || !primaryAction) return;
    if (needsDriverBeforeAction(story, primaryAction)) {
      setSheet("assign-to-activate");
      return;
    }
    void runAction(story, primaryAction);
  }, [busy, primaryAction, runAction, story]);

  const openSheet = (next: Exclude<Sheet, null>) => {
    setChipsOpen(false);
    setSheet(next);
  };

  const runSecondary = (action: ProjectWorkflowAction) => {
    setChipsOpen(false);
    if (needsDriverBeforeAction(story, action)) {
      setSheet("assign-to-activate");
      return;
    }
    void runAction(story, action);
  };

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (busy) return;
      dragState.current = { startX: e.clientX, dragging: true, captured: false };
      swallowNextClick.current = false;
    },
    [busy],
  );

  const handlePointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragState.current.dragging) return;
    const delta = e.clientX - dragState.current.startX;
    // Capture only once this really is a drag: a pointer captured by this
    // container also receives the compatibility mouse events of everything
    // inside it, which would swallow plain clicks on the buttons and the
    // detail link. Not every environment implements capture (jsdom), so the
    // call stays guarded.
    if (!dragState.current.captured && Math.abs(delta) > DRAG_SLOP) {
      dragState.current.captured = true;
      const target = e.currentTarget;
      if (typeof target.setPointerCapture === "function") {
        target.setPointerCapture(e.pointerId);
      }
    }
    setDragX(Math.max(-140, Math.min(140, delta)));
  }, []);

  const finishDrag = useCallback(() => {
    if (!dragState.current.dragging) return;
    dragState.current.dragging = false;
    if (Math.abs(dragX) > DRAG_SLOP) swallowNextClick.current = true;
    if (dragX > SWIPE_THRESHOLD) {
      doPrimary();
    } else if (dragX < -SWIPE_THRESHOLD) {
      setChipsOpen(true);
    }
    setDragX(0);
  }, [dragX, doPrimary]);

  const cancelDrag = useCallback(() => {
    dragState.current.dragging = false;
    setDragX(0);
  }, []);

  // Tapping the row still opens the story detail (a real link, so it keeps
  // href semantics) — but a swipe must never navigate, so the click the
  // browser emits at the end of a drag is swallowed once.
  const handleMainClick = (e: ReactMouseEvent<HTMLAnchorElement>) => {
    if (swallowNextClick.current) {
      swallowNextClick.current = false;
      e.preventDefault();
      return;
    }
    setChipsOpen(false);
  };

  const goToDetail = () => {
    setChipsOpen(false);
    navigate(`/projekte/${story.id}`);
  };

  return (
    <li className={`story-row story-row-accent-${accent}`} style={{ listStyle: "none" }}>
      <div className={`story-row-swipe-bg primary${showPrimaryBg ? " visible" : ""}`} aria-hidden="true">
        {primaryLabel}
      </div>
      <div className={`story-row-swipe-bg chips${showChipsBg ? " visible" : ""}`} aria-hidden="true">
        {strings.moreActions}
      </div>
      <div
        className={`story-row-content${isRetained ? " retained" : ""}`}
        style={dragX ? { transform: `translateX(${dragX}px)` } : undefined}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={cancelDrag}
      >
        <button
          type="button"
          className={`story-row-primary story-row-primary--${accent}`}
          aria-label={primaryLabel}
          disabled={busy || !primaryAction}
          onClick={doPrimary}
        >
          {primaryAction ? projectWorkflowIcons[primaryAction] : "·"}
        </button>
        <Link className="story-row-main" to={`/projekte/${story.id}`} onClick={handleMainClick}>
          <div className="story-row-title">
            {story.title}
            <span className="sr-only">{strings.projectStatus}: </span>
            <span className={`story-row-status-badge story-row-status-badge--${accent}`}>{statusLabel}</span>
            {story.stuckReason ? (
              <span className="badge badge-stuck">{stuckReasonLabels[story.stuckReason]}</span>
            ) : null}
          </div>
          <div className="story-row-meta">
            {variant !== "card" ? (
              <span>
                {strings.criteria}: {criteriaChecked}/{criteria.length}
              </span>
            ) : null}
            <span>
              {driver ? (
                <MemberLabel member={driver} size="xs" />
              ) : (
                strings.noDriver
              )}
            </span>
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
            {variant !== "card" ? (
              <span>
                {strings.taskSummary}: {totalTasks > 0 ? `${doneCount}/${totalTasks}` : strings.taskSummaryNone}
              </span>
            ) : null}
          </div>
          {story.refinementIssues?.slice(0, 2).map((issue) => (
            <span
              className={issue.severity === "urgent" ? "badge badge-stuck" : "badge"}
              key={`${issue.entityType}-${issue.entityId}-${issue.code}`}
            >
              {issue.label}
            </span>
          ))}
          {variant === "card" ? (
            <>
              {criterionSummary ? (
                <p className="story-row-criterion">{criterionSummary}</p>
              ) : null}
              <p
                className="story-row-next-action"
                title={
                  isHealthyWaiting && waitingUntilExact
                    ? `Wiedervorlage am ${waitingUntilExact}`
                    : undefined
                }
              >
                {isHealthyWaiting
                  ? waitingOnSummary
                  : story.nextAction
                    ? `${strings.nextAction}: ${story.nextAction.title}`
                    : strings.noNextAction}
              </p>
              {totalTasks > 0 ? (
                <div
                  className="project-card-progress"
                  style={{
                    gridTemplateColumns: `repeat(${totalTasks}, minmax(0, 1fr))`,
                  }}
                  role="progressbar"
                  aria-label={strings.taskProgress}
                  aria-valuenow={doneCount}
                  aria-valuemin={0}
                  aria-valuemax={totalTasks}
                  aria-valuetext={`${doneCount}/${totalTasks}`}
                >
                  {Array.from({ length: totalTasks }, (_, index) => (
                    <span
                      className={index < doneCount ? "completed" : "open"}
                      key={index}
                    />
                  ))}
                </div>
              ) : null}
            </>
          ) : null}
        </Link>
        {isHealthyWaiting ? (
          <span className="story-row-waiting-qualifier" role="img" aria-label={strings.waiting}>
            <IconActionGlyph kind="waiting" />
          </span>
        ) : null}
        <button
          type="button"
          className="story-row-kebab"
          aria-label={strings.moreActions}
          aria-expanded={chipsOpen}
          disabled={busy}
          onClick={() => setChipsOpen((o) => !o)}
        >
          ⋯
        </button>
      </div>

      {chipsOpen ? (
        <div className="story-row-chips" role="group" aria-label={strings.moreActions}>
          <IconActionButton kind="owner" label={strings.driver} onClick={() => openSheet("assign-driver")} />
          <IconActionButton kind="criteria" label={strings.criteria} onClick={() => openSheet("criteria")} />
          <IconActionButton kind="schedule" label={strings.planDates} onClick={() => openSheet("plan-dates")} />
          <IconActionButton kind="tags" label={strings.tags} onClick={() => openSheet("tags")} />
          <IconActionButton kind="openProject" label={strings.openProject} onClick={goToDetail} />
          {secondaryActions.map((action) => (
            <button
              key={action}
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() => runSecondary(action)}
            >
              {projectWorkflowLabels[action]}
            </button>
          ))}
        </div>
      ) : null}

      {rowError ? (
        <div className="story-row-error" role="alert">
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
          // The backend rejects clearing the driver of a story that has left
          // the backlog, so that choice is not even offered there.
          allowUnassigned={canClearDriver(story)}
          onClose={() => setSheet(null)}
          onAssign={(ownerMemberId) => assignDriver(story, ownerMemberId)}
        />
      ) : null}

      {sheet === "criteria" ? <StoryCriteriaSheet story={story} onClose={() => setSheet(null)} /> : null}

      {sheet === "plan-dates" ? (
        <PlanDatesSheet story={story} onClose={() => setSheet(null)} onSave={(patch) => schedule(story, patch)} />
      ) : null}

      {sheet === "tags" ? (
        <ProjectTagsSheet
          story={story}
          onClose={() => setSheet(null)}
          onSave={async (tagIds) => {
            await api.updateProject(story.id, { tagIds });
            bump();
          }}
        />
      ) : null}
    </li>
  );
}
