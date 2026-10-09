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
import { TaskOutline } from "../components/TaskOutline";
import { QuickAdd } from "../components/QuickAdd";
import { ProjectAgendaRow } from "../components/ProjectAgendaRow";
import { PageHeader, type PageHint } from "../components/PageHeader";
import { ContributionPulse } from "../components/ContributionPulse";
import { ActivityDigest } from "../components/ActivityDigest";
import { readTodayScope, writeTodayScope, nextAgendaScope } from "../lib/todayScope";
import { IconActionGlyph } from "../components/IconActionButton";
import { InteractionScopeProvider } from "../lib/interactionScope";
import { WorkItemKeyboardNavMount } from "../components/WorkItemKeyboardNavMount";
import { useVisibleRefreshInterval } from "../lib/refresh";
import type { AttentionTone } from "../lib/attentionTone";
import { useHomeAssistantStatus } from "../lib/useHomeAssistantStatus";

export function TodayPage() {
  const strings = useStrings();
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
  const revisitTasks = agenda?.revisit ?? [];
  const completedTodayTasks = agenda?.completedToday ?? [];
  const additionalTasks = [
    ...(agenda?.shared ?? []),
    ...(agenda?.unscheduled ?? []),
  ];
  const projectAgenda = agenda?.projects ?? [];
  const projectsByBucket: Record<
    "planned" | "overdue" | "dueToday" | "dueSoon",
    typeof projectAgenda
  > = {
    planned: [],
    overdue: [],
    dueToday: [],
    dueSoon: [],
  };
  for (const entry of projectAgenda) {
    projectsByBucket[entry.attentionBucket].push(entry);
  }
  const visibleSectionTasks: Record<
    "planned" | "overdue" | "dueToday" | "dueSoon",
    Task[]
  > = {
    planned: agenda?.planned ?? [],
    overdue: agenda?.overdue ?? [],
    dueToday: agenda?.dueToday ?? [],
    dueSoon: agenda?.dueSoon ?? [],
  };
  const resolveProjectOwner = (ownerMemberId: number | null) =>
    scope === "all" && ownerMemberId !== null
      ? (members.find((member) => member.id === ownerMemberId) ?? null)
      : null;
  const pageHints: PageHint[] = [
    { text: strings.todayExplanation },
    { text: strings.todayScopeHint },
    ...(revisitTasks.length > 0
      ? [{ label: strings.revisit, text: strings.revisitHint }]
      : []),
  ];
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
  const renderAgendaSection = (section: (typeof sections)[number]) => (
    <div className="section" key={section.key}>
      <div className="section-title">{section.label}</div>
      {visibleSectionTasks[section.key].length > 0 ? (
        <TaskOutline
          tasks={visibleSectionTasks[section.key]}
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

  return (
    <InteractionScopeProvider>
      <WorkItemKeyboardNavMount />
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
            </>
          }
          hints={pageHints}
        />
        <ActivityDigest />
        <ContributionPulse />
        {loading ? <LoadingState /> : null}
        {error ? <ErrorState message={error} onRetry={reload} /> : null}
        {agenda
          ? (() => {
              const total =
                sections.reduce((sum, s) => sum + visibleSectionTasks[s.key].length, 0) +
                additionalTasks.length +
                revisitTasks.length +
                completedTodayTasks.length +
                projectAgenda.length;
              if (total === 0)
                return <EmptyState message={strings.todayEmpty} />;
              return (
                <>
                  {sections
                    .filter(
                      (section) =>
                        section.key !== "dueSoon" &&
                        (visibleSectionTasks[section.key].length > 0 ||
                          projectsByBucket[section.key].length > 0),
                    )
                    .map(renderAgendaSection)}
                  {revisitTasks.length > 0 ? (
                    <div className="section" key="revisit">
                      <div className="section-title">{strings.revisit}</div>
                      <TaskOutline
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
                          projectsByBucket[section.key].length > 0),
                    )
                    .map(renderAgendaSection)}
                  {additionalTasks.length > 0 ? (
                    <details className="section" open={!hasForegroundAttention}>
                      <summary className="section-title disclosure-summary">
                        {strings.unscheduled} ({additionalTasks.length})
                      </summary>
                      <TaskOutline
                        tasks={additionalTasks}
                        emptyMessage={strings.noItems}
                        preserveRootOrder
                        showSwipeHint={false}
                        compactDescendants
                        attentionTone="available"
                      />
                    </details>
                  ) : null}
                  {completedTodayTasks.length > 0 ? (
                    <details className="section" key="completedToday">
                      <summary className="section-title disclosure-summary">
                        {strings.completedToday} ({completedTodayTasks.length})
                      </summary>
                      <p className="page-subtitle">{strings.completedTodayHint}</p>
                      <TaskOutline
                        tasks={completedTodayTasks}
                        emptyMessage={strings.noItems}
                        preserveRootOrder
                        showSwipeHint={false}
                        compactDescendants
                      />
                    </details>
                  ) : null}
                </>
              );
            })()
          : null}
        <QuickAdd {...(scope === "work" ? { defaultScope: "work" as const } : {})} />
      </div>
    </InteractionScopeProvider>
  );
}
