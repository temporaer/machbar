import { useState } from "react";
import { Link } from "react-router-dom";
import { api, type AgendaScope } from "../lib/api";
import type { Task } from "@machbar/shared";
import { useAsync } from "../lib/useAsync";
import { useIdentity } from "../lib/identity";
import { useStrings } from "../lib/strings";
import {
  LoadingState,
  ErrorState,
  EmptyState,
} from "../components/AsyncStates";
import {
  TaskOutlineInTransitionView,
} from "../components/TaskOutline";
import { QuickAdd } from "../components/QuickAdd";
import { ProjectAgendaRow } from "../components/ProjectAgendaRow";
import { InterventionFocusStrip } from "../components/InterventionFocusStrip";
import { PageHeader } from "../components/PageHeader";
import { ContributionPulse } from "../components/ContributionPulse";
import { ActivityDigest } from "../components/ActivityDigest";
import { readTodayScope, writeTodayScope, nextAgendaScope } from "../lib/todayScope";
import { IconActionGlyph } from "../components/IconActionButton";
import { InteractionScopeProvider } from "../lib/interactionScope";
import { WorkItemKeyboardNavMount } from "../components/WorkItemKeyboardNavMount";
import { useVisibleRefreshInterval } from "../lib/refresh";
import type { AttentionTone } from "../lib/attentionTone";
import { useHomeAssistantStatus } from "../lib/useHomeAssistantStatus";
import {
  TaskListTransitionFeedbackProvider,
  useRequiredTaskListTransitionFeedback,
} from "../lib/taskListTransitionFeedback";

function CompletedTodaySection({
  tasks,
  agendaSelectionKey,
  transitionOutlineId,
  title,
  hint,
  emptyMessage,
}: {
  tasks: Task[];
  agendaSelectionKey: string;
  transitionOutlineId: string;
  title: string;
  hint: string;
  emptyMessage: string;
}) {
  const [manuallyOpen, setManuallyOpen] = useState(false);

  return (
    <details
      className="section"
      key="completedToday"
      open={manuallyOpen}
    >
      <summary
        className="section-title disclosure-summary"
        onClick={event => {
          event.preventDefault();
          setManuallyOpen(open => !open);
        }}
      >
        {title} ({tasks.length})
      </summary>
      <p className="page-subtitle">{hint}</p>
      <TaskOutlineInTransitionView
        key={agendaSelectionKey}
        transitionOutlineId={transitionOutlineId}
        tasks={tasks}
        emptyMessage={emptyMessage}
        preserveRootOrder
        showSwipeHint={false}
        compactDescendants
      />
    </details>
  );
}

export function TodayPage() {
  const { authEnabled, authenticated, currentMemberId } = useIdentity();
  const identityKey = `${authEnabled}:${authenticated}:${currentMemberId}`;
  return (
    <InteractionScopeProvider>
      <WorkItemKeyboardNavMount />
      <TaskListTransitionFeedbackProvider identityKey={identityKey}>
        <TodayContent />
      </TaskListTransitionFeedbackProvider>
    </InteractionScopeProvider>
  );
}

function TodayContent() {
  const strings = useStrings();
  const feedback = useRequiredTaskListTransitionFeedback();
  const { data: homeAssistant } = useHomeAssistantStatus();
  const [scope, setScope] = useState<AgendaScope>(readTodayScope);
  const sections: Array<{
    key: "planned" | "overdue" | "dueToday" | "dueSoon";
    label: string;
  }> = [
    { key: "overdue", label: strings.overdue },
    { key: "dueToday", label: strings.dueToday },
    { key: "planned", label: strings.plannedToday },
    { key: "dueSoon", label: strings.dueSoon },
  ];
  // `IdentityGate` (mounted above every route in `App.tsx`) normally
  // guarantees a member is selected before this page ever renders, but we
  // still guard against a transient/null `currentMemberId` here (e.g. in
  // isolated tests, or a brief render before the gate kicks in) so the
  // page never throws and never ends up requesting -- or rendering --
  // another member's tasks. Re-fetching whenever `currentMemberId` changes
  // ensures switching identities always shows that member's own agenda.
  const { currentMemberId, members } = useIdentity();
  const agendaSelectionKey = `${scope}:${currentMemberId ?? "none"}`;
  const {
    data: loadedAgenda,
    loading,
    error,
    reload,
  } = useAsync(
    async () => ({
      selectionKey: agendaSelectionKey,
      agenda: await api.getAgenda(currentMemberId, scope),
    }),
    [currentMemberId, scope],
  );
  useVisibleRefreshInterval(reload);
  const agenda =
    loadedAgenda?.selectionKey === agendaSelectionKey
      ? loadedAgenda.agenda
      : null;
  const selectScope = (nextScope: AgendaScope) => {
    setScope(nextScope);
    writeTodayScope(nextScope);
  };
  const taskBuckets = {
    planned: agenda?.planned ?? [], overdue: agenda?.overdue ?? [],
    dueToday: agenda?.dueToday ?? [], dueSoon: agenda?.dueSoon ?? [],
    revisit: agenda?.revisit ?? [], completedToday: agenda?.completedToday ?? [],
    additional: [...(agenda?.shared ?? []), ...(agenda?.unscheduled ?? [])],
  };
  const projectCandidates = (agenda?.projects ?? []).map(entry => ({ ...entry, id: entry.project.id }));
  const projectBuckets = {
    planned: projectCandidates.filter(entry => entry.attentionBucket === "planned"),
    overdue: projectCandidates.filter(entry => entry.attentionBucket === "overdue"),
    dueToday: projectCandidates.filter(entry => entry.attentionBucket === "dueToday"),
    dueSoon: projectCandidates.filter(entry => entry.attentionBucket === "dueSoon"),
  };
  const revisitTasks = taskBuckets.revisit;
  const completedTodayTasks = taskBuckets.completedToday;
  const additionalTasks = taskBuckets.additional;
  const projectAgenda = Object.values(projectBuckets).flat();
  const projectsByBucket = projectBuckets;
  const visibleSectionTasks: Record<
    "planned" | "overdue" | "dueToday" | "dueSoon",
    Task[]
  > = {
    planned: taskBuckets.planned,
    overdue: taskBuckets.overdue,
    dueToday: taskBuckets.dueToday,
    dueSoon: taskBuckets.dueSoon,
  };
  const resolveProjectOwner = (ownerMemberId: number | null) =>
    scope === "all" && ownerMemberId !== null
      ? (members.find((member) => member.id === ownerMemberId) ?? null)
      : null;
  const toneBySection: Record<
    "planned" | "overdue" | "dueToday" | "dueSoon",
    AttentionTone
  > = {
    planned: "planned",
    overdue: "overdue",
    dueToday: "due-today",
    dueSoon: "due-soon",
  };
  const hasForegroundAttention =
    sections.some(
      (section) =>
        visibleSectionTasks[section.key].length > 0 ||
        projectsByBucket[section.key].length > 0,
    ) || revisitTasks.length > 0;
  const renderAgendaSection = (section: (typeof sections)[number]) => {
    const transitionOutlineId = `today:${section.key}`;
    const tasks = visibleSectionTasks[section.key];
    if (
      tasks.length === 0 &&
      projectsByBucket[section.key].length === 0 &&
      !feedback.hasTransitions(transitionOutlineId)
    ) return null;
    return (
    <div className="section" key={section.key}>
      <div className="section-title">{section.label}</div>
      {tasks.length > 0 || feedback.hasTransitions(transitionOutlineId) ? (
        <TaskOutlineInTransitionView
          key={`${agendaSelectionKey}:${transitionOutlineId}`}
          transitionOutlineId={transitionOutlineId}
          tasks={tasks}
          emptyMessage={strings.noItems}
          preserveRootOrder
          showSwipeHint={false}
          compactDescendants
          attentionTone={toneBySection[section.key]}
        />
      ) : null}
      {projectsByBucket[section.key].length > 0 ? (
        <div
          className={`list${
            visibleSectionTasks[section.key].length > 0
              ? " today-project-agenda-list"
              : ""
          }`}
        >
          {projectsByBucket[section.key].map((entry) => (
            <ProjectAgendaRow
              key={entry.project.id}
              entry={entry}
              owner={resolveProjectOwner(entry.project.ownerMemberId)}
              attentionTone={toneBySection[section.key]}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
  };

  return (
      <div className="today-page">
        <PageHeader
          title={strings.today}
          actions={
            <>
              {homeAssistant?.intakeReady ? (
                <Link
                  to="/more/cleanup-round"
                  className="page-header-button cleanup-round-shortcut"
                  aria-label={strings.cleanupRoundShortcutLabel}
                  title={strings.cleanupRoundShortcutTitle}
                >
                  <span aria-hidden="true">✨</span>
                </Link>
              ) : null}
              <Link
                to="/more/week"
                className="page-header-button"
                aria-label={strings.weekPlanning}
                title={strings.weekPlanning}
              >
                <IconActionGlyph kind="schedule" />
              </Link>
              <button
                type="button"
                className="page-header-button today-scope-toggle"
                aria-label={
                  scope === "mine"
                    ? strings.todayHouseholdScope
                    : scope === "all"
                      ? strings.todayWorkScope
                      : strings.todayMineScope
                }
                aria-pressed={scope !== "mine"}
                title={
                  scope === "mine"
                    ? strings.todayHouseholdScope
                    : scope === "all"
                      ? strings.todayWorkScope
                      : strings.todayMineScope
                }
                onClick={() => selectScope(nextAgendaScope(scope))}
              >
                <IconActionGlyph
                  kind={
                    scope === "mine" ? "owner" : scope === "all" ? "household" : "work"
                  }
                />
              </button>
              <Link
                to="/more/all"
                className="page-header-button"
                aria-label={strings.search}
                title={strings.search}
              >
                <IconActionGlyph kind="search" />
              </Link>
            </>
          }
        />
        <ActivityDigest />
        <ContributionPulse />
        {loading ? <LoadingState /> : null}
        {error ? <ErrorState message={error} onRetry={reload} /> : null}
        {agenda ? (
          <InterventionFocusStrip focus={agenda.interventions} />
        ) : null}
        {agenda
          ? (() => {
              const total =
                sections.reduce((sum, s) => sum + visibleSectionTasks[s.key].length, 0) +
                additionalTasks.length +
                revisitTasks.length +
                completedTodayTasks.length +
                projectAgenda.length;
              const interventionContent =
                agenda.interventions.running.length +
                agenda.interventions.review.length +
                (agenda.interventions.reports?.length ?? 0);
              const hasTransitions = [
                ...sections.map(section => `today:${section.key}`),
                "today:revisit",
                "today:additional",
                "today:completedToday",
              ].some(id => feedback.hasTransitions(id));
              if (total + interventionContent === 0 && !hasTransitions)
                return <EmptyState message={strings.todayEmpty} />;
              return (
                <>
                  {sections
                    .filter(
                      (section) =>
                        section.key !== "dueSoon" &&
                        (visibleSectionTasks[section.key].length > 0 ||
                          projectsByBucket[section.key].length > 0 ||
                          feedback.hasTransitions(`today:${section.key}`)),
                    )
                    .map(renderAgendaSection)}
                  {revisitTasks.length > 0 || feedback.hasTransitions("today:revisit") ? (
                    <div className="section" key="revisit">
                      <div className="section-title">{strings.revisit}</div>
                      <TaskOutlineInTransitionView
                        key={`${agendaSelectionKey}:today:revisit`}
                        transitionOutlineId="today:revisit"
                        tasks={revisitTasks}
                        emptyMessage={strings.noItems}
                        preserveRootOrder
                        showRevisitDate
                        showSwipeHint={false}
                        compactDescendants
                        attentionTone="revisit"
                      />
                    </div>
                  ) : null}
                  {sections
                    .filter(
                      (section) =>
                        section.key === "dueSoon" &&
                        (visibleSectionTasks[section.key].length > 0 ||
                          projectsByBucket[section.key].length > 0 ||
                          feedback.hasTransitions(`today:${section.key}`)),
                    )
                    .map(renderAgendaSection)}
                  {additionalTasks.length > 0 || feedback.hasTransitions("today:additional") ? (
                    <details
                      className="section"
                      open={feedback.hasTransitions("today:additional") || !hasForegroundAttention}
                    >
                      <summary className="section-title disclosure-summary">
                        {strings.unscheduled} ({additionalTasks.length})
                      </summary>
                      <TaskOutlineInTransitionView
                        key={`${agendaSelectionKey}:today:additional`}
                        transitionOutlineId="today:additional"
                        tasks={additionalTasks}
                        emptyMessage={strings.noItems}
                        preserveRootOrder
                        showSwipeHint={false}
                        compactDescendants
                        attentionTone="available"
                      />
                    </details>
                  ) : null}
                  {completedTodayTasks.length > 0 || feedback.hasTransitions("today:completedToday") ? (
                    <CompletedTodaySection
                      tasks={completedTodayTasks}
                      agendaSelectionKey={agendaSelectionKey}
                      transitionOutlineId="today:completedToday"
                      title={strings.completedToday}
                      hint={strings.completedTodayHint}
                      emptyMessage={strings.noItems}
                    />
                  ) : null}
                </>
              );
            })()
          : null}
        <QuickAdd {...(scope === "work" ? { defaultScope: "work" as const } : {})} />
      </div>
  );
}
