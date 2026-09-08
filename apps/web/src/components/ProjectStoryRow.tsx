import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import type { ProjectWithActions, ProjectWorkflowAction } from "../lib/api";
import { storyWorkflowCommand } from "../lib/commands";
import { useStrings } from "../lib/strings";
import { formatDate } from "../lib/format";
import {
  formatCompactWaitDuration,
  formatExactLocalDate,
  formatRelativeDueDate,
  formatRelativeScheduleDate,
  isFutureCalendarDate,
} from "../lib/relativeDate";
import { useIdentity } from "../lib/identity";
import {
  classifyProjectListItem,
  type ProjectListClassification,
} from "../lib/projectListFilter";
import {
  primaryWorkflowAction,
  projectTransitionLabel,
  projectWorkflowIcons,
  projectWorkflowLabel,
  secondaryWorkflowActions,
} from "../lib/projectWorkflow";
import { useProjectActions } from "../lib/useProjectActions";
import { useWorkItemCommands } from "../lib/useWorkItemCommands";
import { useOptionalInteractionScope } from "../lib/interactionScope";
import { IconActionGlyph } from "./IconActionButton";
import { MemberAvatar } from "./MemberAvatar";
import { useLocale } from "../lib/locale";
import "./ProjectStoryRow.css";
import { useSwipeCoach } from "../lib/swipeCoach";
import { SwipeCoachHint } from "./SwipeCoachHint";
import { RowSwipeBackgrounds, RowKebabButton, RowErrorBanner } from "./WorkItemRowChrome";
import { useHorizontalSwipe } from "../lib/useHorizontalSwipe";
import { TaskCardTags } from "./TaskCardTags";
import { useRailConfig } from "../lib/railConfigContext";
import { WorkItemCommandRail } from "./WorkItemCommandRail";

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
  "active-waiting": "waiting",
  backlog: "backlog",
  completed: "completed",
  archived: "archived",
};

export interface ProjectStoryRowProps {
  story: ProjectWithActions;
  /**
   * `compact` — the inventory/Review meta line (criteria, driver, dates, tasks).
   * `card` — the Projekte tab: same meta plus next action and the task /
   * acceptance-criteria progress bars.
   */
  variant?: "compact" | "card";
}


/**
 * One story row with the full mobile workflow gestures, shared by the
 * project lists and inventory views.
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
 * zurücklegen", "Archivieren"). The row renders no workflow sheets of its
 * own: every command — lifecycle transition, driver, dates, acceptance
 * criteria, tags — is dispatched as a semantic `story.*` command and
 * rendered by `ProjectWorkflowHost`, including the prerequisites a
 * transition may need first (see `lifecyclePrerequisite()`). "Projekt
 * öffnen" navigates to the project page, and tapping the row itself still
 * opens the story detail as before.
 */
export function ProjectStoryRow({ story: storyProp, variant = "compact" }: ProjectStoryRowProps) {
  const strings = useStrings();
  const { locale } = useLocale();
  const { members } = useIdentity();
  const navigate = useNavigate();
  const dispatch = useWorkItemCommands();
  // `null` on any host outside a navigable interaction surface; logical
  // active-item updates are best-effort there.
  const scope = useOptionalInteractionScope();
  // Sourced from the shared `ProjectActionsProvider` instance (see
  // `useProjectActions.tsx`); passing just this row's own `story` is enough
  // for its retained entry to release once this prop confirms the same
  // revision, without needing the host page's whole loaded collection.
  const { isPending, retained, errors, clearError } = useProjectActions([storyProp]);

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
  const isActiveWaiting = classification === "active-waiting";
  const waitingOn = story.waitingOn ?? [];
  const now = new Date();
  const waitingDuration = story.waitingUntil
    ? formatCompactWaitDuration(story.waitingUntil, now, locale)
    : null;
  const waitingRelativeDate = story.waitingUntil
    ? formatRelativeDueDate(story.waitingUntil, now, locale)
    : null;
  const waitingUntilExact = story.waitingUntil
    ? formatExactLocalDate(story.waitingUntil, locale)
    : null;
  const nextActionScheduleRelative = story.nextAction?.scheduledDate
    ? formatRelativeScheduleDate(
        story.nextAction.scheduledDate,
        now,
        locale,
      )
    : null;
  const nextActionScheduleExact = story.nextAction?.scheduledDate
    ? formatExactLocalDate(story.nextAction.scheduledDate, locale)
    : null;
  const nextActionScheduleAccessible =
    story.nextAction &&
    nextActionScheduleRelative &&
    nextActionScheduleExact
      ? `${strings.nextAction} ${nextActionScheduleRelative} (${nextActionScheduleExact}): ${story.nextAction.title}`
      : null;
  const waitingDurationSuffix =
    story.waitingUntil && waitingRelativeDate
      ? isFutureCalendarDate(story.waitingUntil, now)
        ? waitingDuration
          ? ` · ${strings.remainingDuration(waitingDuration)}`
          : ""
        : ` · ${strings.revisitDate}: ${waitingRelativeDate}`
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
    dispatch(storyWorkflowCommand(story, primaryAction));
  }, [busy, dispatch, primaryAction, story]);
  const swipe = useHorizontalSwipe<HTMLDivElement>({
    disabled: busy,
    onPrimary: () => scope?.setOpenLifecycle(storyProp.id),
    onSecondary: () => scope?.setOpenRail(storyProp.id),
  });
  const { dragX } = swipe;
  const chipsOpen = scope?.openRailId === storyProp.id;
  const lifecycleOpen = scope?.openLifecycleId === storyProp.id;
  const { projectFavorites } = useRailConfig();
  const showPrimaryBg = dragX > 0;
  const showChipsBg = dragX < 0 || chipsOpen;
  const swipeCoach = useSwipeCoach(
    `project:${story.id}`,
    !busy && !isRetained && !chipsOpen && primaryAction !== null,
  );

  const runSecondary = (action: ProjectWorkflowAction) => {
    scope?.setOpenRail(null);
    dispatch(storyWorkflowCommand(story, action));
  };

  /**
   * `.story-row-main` navigates via this handler rather than being a real
   * `<Link>`/`<a>`: a real anchor is subject to native browser gestures a
   * plain button never triggers (HTML5 image/text drag, iOS Safari's
   * long-press link-preview callout, desktop/Android's "open/copy link"
   * context menu). Any of those can swallow the pointer sequence the swipe
   * gesture relies on before our own handlers see it, independent of the
   * `suppressNextClick` click-suppression below. `TaskRow`'s equivalent
   * `.task-row-main` is a button for the same reason.
   */
  const handleMainClick = () => {
    scope?.setOpenRail(null);
    scope?.setActive(story.id, "story");
    navigate(`/projects/${story.id}`);
  };

  const runRailCommand = (command: (typeof projectFavorites)[number]) => {
    scope?.setOpenRail(null);
    dispatch({ type: command, story });
  };

  const runLifecycleAction = (action: ProjectWorkflowAction) => {
    scope?.setOpenLifecycle(null);
    runSecondary(action);
  };

  return (
    <li
      className={`story-row story-row-accent-${accent}`}
      style={{ listStyle: "none" }}
      data-workitem-id={story.id}
      data-workitem-role="story"
    >
      <RowSwipeBackgrounds
        classPrefix="story-row"
        primaryLabel={primaryLabel}
        primaryVisible={showPrimaryBg}
        primaryVariantClass="primary"
        secondaryLabel={strings.moreActions}
        secondaryVisible={showChipsBg}
        secondaryVariantClass="chips"
        coachAnimate={swipeCoach.animate}
      />
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
        <button
          type="button"
          className="story-row-main"
          disabled={busy}
          onClick={handleMainClick}
        >
          <div className="story-row-title">
            {story.title}
            <span className="sr-only">{strings.projectStatus}: </span>
            <span className={`story-row-status-badge story-row-status-badge--${accent}`}>{statusLabel}</span>
            {story.stuckReason ? (
              <span className="badge badge-stuck">{strings.stuckReasonLabels[story.stuckReason]}</span>
            ) : null}
          </div>
          {variant !== "card" ||
          dueLabel ||
          scheduledLabel ||
          story.contexts.length > 0 ? (
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
                  {strings.projectRevisitDate}: {scheduledLabel}
                </span>
              ) : null}
              {variant !== "card" ? (
                <span>
                  {strings.taskSummary}: {totalTasks > 0 ? `${doneCount}/${totalTasks}` : strings.taskSummaryNone}
                </span>
              ) : null}
              <TaskCardTags tags={[]} contexts={story.contexts} />
            </div>
          ) : null}
          {variant === "card" ? (
            <>
              {criterionSummary ? (
                <p className="story-row-criterion">{criterionSummary}</p>
              ) : null}
              <p
                className="story-row-next-action"
                title={
                  isActiveWaiting && waitingUntilExact
                    ? strings.projectRevisitOn(waitingUntilExact)
                    : nextActionScheduleAccessible ?? undefined
                }
                aria-label={
                  !isActiveWaiting && nextActionScheduleAccessible
                    ? nextActionScheduleAccessible
                    : undefined
                }
              >
                {isActiveWaiting
                  ? waitingOnSummary
                  : story.nextAction
                    ? `${strings.nextAction}${
                        nextActionScheduleRelative
                          ? ` ${nextActionScheduleRelative}`
                          : ""
                      }: ${story.nextAction.title}`
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
        </button>
        {driver ? (
          <span
            className="story-row-driver-avatar"
            aria-label={`${strings.driver}: ${driver.name}`}
            title={driver.name}
          >
            <MemberAvatar member={driver} size="sm" />
          </span>
        ) : null}
        {isActiveWaiting ? (
          <span className="story-row-waiting-qualifier" role="img" aria-label={strings.waiting}>
            <IconActionGlyph kind="waiting" />
          </span>
        ) : null}
        <RowKebabButton
          classPrefix="story-row"
          open={chipsOpen}
          disabled={busy}
          onToggle={() =>
            scope?.setOpenRail(chipsOpen ? null : storyProp.id)
          }
        />
      </div>
      {swipeCoach.active ? (
        <SwipeCoachHint primaryAction={primaryLabel} onDismiss={swipeCoach.dismiss} />
      ) : null}

      {chipsOpen ? (
        <WorkItemCommandRail
          kind="project"
          favorites={projectFavorites}
          labels={strings.railCommandLabels}
          groupLabel={strings.moreActions}
          overflowLabel={`${strings.more} …`}
          disabled={busy}
          onCommand={runRailCommand}
          overflowOpen={scope.openOverflowId === story.id}
          onOverflowChange={(open) => scope.setOpenOverflow(open ? story.id : null)}
        />
      ) : null}
      {lifecycleOpen ? (
        <div className="story-row-lifecycle" role="group" aria-label={strings.status}>
          <button type="button" className="btn btn-sm" disabled aria-current="true">
            {strings.projectStatusLabels[story.status]}
          </button>
          {story.availableActions.map((action) => (
            <button
              key={action}
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() => runLifecycleAction(action)}
            >
              {projectWorkflowLabel(action, strings)}
            </button>
          ))}
        </div>
      ) : null}

      {rowError ? (
        <RowErrorBanner
          classPrefix="story-row"
          message={rowError}
          onClose={() => clearError(story.id)}
        />
      ) : null}
    </li>
  );
}
