import { useCallback, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { ProjectWithActions, ProjectWorkflowAction } from "../lib/api";
import { useStrings } from "../lib/strings";
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
import {
  canClearDriver,
  needsDriverBeforeAction,
  primaryWorkflowAction,
  projectTransitionLabel,
  projectWorkflowIcons,
  projectWorkflowLabel,
  secondaryWorkflowActions,
} from "../lib/projectWorkflow";
import type { useProjectActions } from "../lib/useProjectActions";
import { PlanDatesSheet } from "./PlanDatesSheet";
import { StoryCriteriaSheet } from "./StoryCriteriaSheet";
import { ProjectTagsSheet } from "./ProjectTagsSheet";
import { IconActionButton, IconActionGlyph } from "./IconActionButton";
import { MemberAvatar } from "./MemberAvatar";
import { useLocale } from "../lib/locale";
import { formatRefinementIssue } from "../lib/refinementFormatting";
import "./ProjectStoryRow.css";
import { useSwipeCoach } from "../lib/swipeCoach";
import { SwipeCoachHint } from "./SwipeCoachHint";
import { MemberSelectionSheet } from "./MemberSelectionSheet";
import { useHorizontalSwipe } from "../lib/useHorizontalSwipe";

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
  actions: ReturnType<typeof useProjectActions>;
  /**
   * `compact` — the Backlog-Review meta line (criteria, driver, dates, tasks).
   * `card` — the Projekte tab: same meta plus next action and the task /
   * acceptance-criteria progress bars.
   */
  variant?: "compact" | "card";
}

type Sheet =
  | "assign-to-activate"
  | "assign-driver"
  | "plan-dates"
  | "criteria"
  | "tags"
  | null;

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
  const strings = useStrings();
  const { locale } = useLocale();
  const [chipsOpen, setChipsOpen] = useState(false);
  const [sheet, setSheet] = useState<Sheet>(null);
  const { members } = useIdentity();
  const navigate = useNavigate();
  const {
    isPending,
    retained,
    errors,
    clearError,
    runAction,
    activate,
    update,
    assignDriver,
    schedule,
  } = actions;

  // A story that just transitioned keeps rendering here — muted, with the
  // past-tense confirmation of what happened — for `RETENTION_MS` (~4s)
  // instead of snapping to its refetched state immediately. Exactly like the
  // task list, the row stays *actionable* the moment the request resolves.
  const retainedEntry = retained.get(storyProp.id);
  const story = retainedEntry?.story ?? storyProp;
  const isRetained = Boolean(retainedEntry);
  const rowError = errors[storyProp.id];
  const busy = isPending(story.id);

  const driver = story.ownerMemberId ? members.find((m) => m.id === story.ownerMemberId) : null;
  const criteria = story.acceptanceCriteria ?? [];
  const criteriaChecked = criteria.filter((c) => c.checked).length;
  const dueLabel = formatDate(story.dueDate, locale);
  const scheduledLabel = formatDate(story.scheduledDate, locale);
  const openCount = story.openCount ?? 0;
  const doneCount = story.doneCount ?? 0;
  const totalTasks = openCount + doneCount;

  const primaryAction = primaryWorkflowAction(story);
  const primaryLabel = primaryAction
    ? projectWorkflowLabel(primaryAction, strings)
    : strings.workflowStep;
  const secondaryActions = secondaryWorkflowActions(story);
  const statusLabel = retainedEntry?.action
    ? projectTransitionLabel(retainedEntry.action, strings)
    : strings.projectStatusLabels[story.status];
  const classification = classifyProjectListItem(story);
  const accent = statusAccentByClassification[classification];
  const isHealthyWaiting = classification === "healthy-waiting";
  const waitingOn = story.waitingOn ?? [];
  const waitingDuration = story.waitingUntil
    ? formatCompactWaitDuration(story.waitingUntil, new Date(), locale)
    : null;
  const waitingUntilExact = story.waitingUntil
    ? formatExactLocalDate(story.waitingUntil, locale)
    : null;
  const waitingDurationSuffix = waitingDuration
    ? ` · ${strings.remainingDuration(waitingDuration)}`
    : "";
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

  const doPrimary = useCallback(() => {
    if (busy || !primaryAction) return;
    if (needsDriverBeforeAction(story, primaryAction)) {
      setSheet("assign-to-activate");
      return;
    }
    void runAction(story, primaryAction);
  }, [busy, primaryAction, runAction, story]);
  const swipe = useHorizontalSwipe<HTMLDivElement>({
    disabled: busy,
    onPrimary: doPrimary,
    onSecondary: () => setChipsOpen(true),
  });
  const { dragX } = swipe;
  const showPrimaryBg = dragX > 0;
  const showChipsBg = dragX < 0 || chipsOpen;
  const swipeCoach = useSwipeCoach(
    `project:${story.id}`,
    !busy && !isRetained && !chipsOpen && primaryAction !== null,
  );

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

  const handleMainClick = () => {
    setChipsOpen(false);
  };

  const goToDetail = () => {
    setChipsOpen(false);
    navigate(`/projects/${story.id}`);
  };

  return (
    <li className={`story-row story-row-accent-${accent}`} style={{ listStyle: "none" }}>
      <div className={`story-row-swipe-bg primary${showPrimaryBg ? " visible" : ""}${swipeCoach.animate ? " swipe-coach-primary" : ""}`} aria-hidden="true">
        {primaryLabel}
      </div>
      <div className={`story-row-swipe-bg chips${showChipsBg ? " visible" : ""}${swipeCoach.animate ? " swipe-coach-secondary" : ""}`} aria-hidden="true">
        {strings.moreActions}
      </div>
      <div
        className={`story-row-content${driver ? " has-driver" : ""}${isRetained ? " retained" : ""}${swipeCoach.animate ? " swipe-coach-preview" : ""}`}
        style={dragX ? { transform: `translateX(${dragX}px)` } : undefined}
        onPointerDown={(event) => {
          if (swipeCoach.active && event.pointerType === "touch") {
            swipeCoach.dismiss();
          }
          swipe.handlers.onPointerDown(event);
        }}
        onPointerMove={swipe.handlers.onPointerMove}
        onPointerUp={swipe.handlers.onPointerUp}
        onPointerCancel={swipe.handlers.onPointerCancel}
        onClickCapture={swipe.handlers.onClickCapture}
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
        <Link className="story-row-main" to={`/projects/${story.id}`} onClick={handleMainClick}>
          <div className="story-row-title">
            {story.title}
            <span className="sr-only">{strings.projectStatus}: </span>
            <span className={`story-row-status-badge story-row-status-badge--${accent}`}>{statusLabel}</span>
            {story.stuckReason ? (
              <span className="badge badge-stuck">{strings.stuckReasonLabels[story.stuckReason]}</span>
            ) : null}
          </div>
          {variant !== "card" || dueLabel || scheduledLabel ? (
            <div className="story-row-meta">
              {variant !== "card" ? (
                <span>
                  {strings.criteria}: {criteriaChecked}/{criteria.length}
                </span>
              ) : null}
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
          ) : null}
          {story.refinementIssues?.slice(0, 2).map((issue) => (
            <span
              className={issue.severity === "urgent" ? "badge badge-stuck" : "badge"}
              key={`${issue.entityType}-${issue.entityId}-${issue.code}`}
            >
              {formatRefinementIssue(issue, locale).label}
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
                    ? strings.projectRevisitOn(waitingUntilExact)
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
        {driver ? (
          <span
            className="story-row-driver-avatar"
            aria-label={`${strings.driver}: ${driver.name}`}
            title={driver.name}
          >
            <MemberAvatar member={driver} size="sm" />
          </span>
        ) : null}
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
      {swipeCoach.active ? (
        <SwipeCoachHint primaryAction={primaryLabel} onDismiss={swipeCoach.dismiss} />
      ) : null}

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
              {projectWorkflowLabel(action, strings)}
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
        <MemberSelectionSheet
          title={strings.assignDriver}
          label={strings.driver}
          idPrefix={`activate-driver-${story.id}`}
          members={members}
          value={story.ownerMemberId}
          unassignedLabel={null}
          hint={strings.assignDriverToActivateHint}
          onClose={() => setSheet(null)}
          onSelect={async (ownerMemberId) => {
            await activate(story, ownerMemberId);
          }}
        />
      ) : null}

      {sheet === "assign-driver" ? (
        <MemberSelectionSheet
          title={strings.assignDriver}
          label={strings.driver}
          idPrefix={`project-driver-${story.id}`}
          members={members}
          value={story.ownerMemberId}
          unassignedLabel={canClearDriver(story) ? strings.noDriver : null}
          hint={canClearDriver(story) ? undefined : strings.driverLockedHint}
          onClose={() => setSheet(null)}
          onSelect={async (ownerMemberId) => {
            await assignDriver(story, ownerMemberId);
          }}
        />
      ) : null}

      {sheet === "criteria" ? <StoryCriteriaSheet story={story} onClose={() => setSheet(null)} /> : null}

      {sheet === "plan-dates" ? (
        <PlanDatesSheet
          story={story}
          onClose={() => setSheet(null)}
          onSave={async (patch) => {
            await schedule(story, patch);
          }}
        />
      ) : null}

      {sheet === "tags" ? (
        <ProjectTagsSheet
          story={story}
          onClose={() => setSheet(null)}
          onSave={async (tagIds) => {
            await update(story, { tagIds }, undefined, true);
          }}
        />
      ) : null}
    </li>
  );
}
