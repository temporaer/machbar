import { useState } from "react";
import { api, type AgendaScope } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useIdentity } from "../lib/identity";
import { useStrings } from "../lib/strings";
import { LoadingState, ErrorState, EmptyState } from "../components/AsyncStates";
import { TaskOutline } from "../components/TaskOutline";
import { QuickAdd } from "../components/QuickAdd";
import { ProjectAgendaCard } from "../components/ProjectAgendaCard";
import { PageHeader, type PageHint } from "../components/PageHeader";
import { useSwipeSettings } from "../lib/swipeSettings";
import { ContributionPulse } from "../components/ContributionPulse";
import { readTodayScope, writeTodayScope } from "../lib/todayScope";
import { IconActionGlyph } from "../components/IconActionButton";

export function TodayPage() {
  const strings = useStrings();
  const [scope, setScope] = useState<AgendaScope>(readTodayScope);
  const sections: Array<{
    key: "planned" | "overdue" | "dueToday" | "dueSoon";
    label: string;
  }> = [
    { key: "planned", label: strings.plannedToday },
    { key: "overdue", label: strings.overdue },
    { key: "dueToday", label: strings.dueToday },
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
  const { primarySwipeAction } = useSwipeSettings();
  const agendaSelectionKey = `${scope}:${currentMemberId ?? "none"}`;
  const { data: loadedAgenda, loading, error, reload } = useAsync(
    async () => ({
      selectionKey: agendaSelectionKey,
      agenda: await api.getAgenda(currentMemberId, scope),
    }),
    [currentMemberId, scope],
  );
  const agenda =
    loadedAgenda?.selectionKey === agendaSelectionKey
      ? loadedAgenda.agenda
      : null;
  const selectScope = (nextScope: AgendaScope) => {
    setScope(nextScope);
    writeTodayScope(nextScope);
  };
  const revisitTasks = agenda?.revisit ?? [];
  const additionalTasks = [...(agenda?.shared ?? []), ...(agenda?.unscheduled ?? [])];
  const projectAgenda = agenda?.projects ?? [];
  const pageHints: PageHint[] = [
    { text: strings.todayExplanation },
    { text: strings.todayScopeHint },
    {
      label: strings.taskGestures,
      text: strings.taskGestureHint(
        strings.primarySwipeActionLabels[primarySwipeAction],
      ),
    },
    ...(revisitTasks.length > 0
      ? [{ label: strings.revisit, text: strings.revisitHint }]
      : []),
  ];

  return (
    <div className="today-page">
      <PageHeader
        title={strings.today}
        actions={
          <button
            type="button"
            className="page-header-button today-scope-toggle"
            aria-label={strings.todayHouseholdScope}
            aria-pressed={scope === "all"}
            title={strings.todayHouseholdScope}
            onClick={() => selectScope(scope === "mine" ? "all" : "mine")}
          >
            <IconActionGlyph kind="household" />
          </button>
        }
        hints={pageHints}
      />
      <ContributionPulse />
      {loading ? <LoadingState /> : null}
      {error ? <ErrorState message={error} onRetry={reload} /> : null}
      {agenda ? (
        (() => {
          const total =
            sections.reduce((sum, s) => sum + agenda[s.key].length, 0) +
            additionalTasks.length +
            revisitTasks.length +
            projectAgenda.length;
          if (total === 0) return <EmptyState message={strings.todayEmpty} />;
          return (
            <>
              {projectAgenda.length > 0 ? (
                <section className="section" aria-labelledby="today-projects-heading">
                  <h2 className="section-title" id="today-projects-heading">
                    {strings.projectAgenda}
                  </h2>
                  <div className="list">
                    {projectAgenda.map((entry) => (
                      <ProjectAgendaCard
                        key={entry.project.id}
                        entry={entry}
                        owner={
                          scope === "all" && entry.project.ownerMemberId !== null
                            ? members.find(
                                (member) =>
                                  member.id === entry.project.ownerMemberId,
                              ) ?? null
                            : null
                        }
                      />
                    ))}
                  </div>
                </section>
              ) : null}
              {sections
                .filter((s) => agenda[s.key].length > 0)
                .map((s) => (
                  <div className="section" key={s.key}>
                    <div className="section-title">{s.label}</div>
                    <TaskOutline
                      tasks={agenda[s.key]}
                      emptyMessage={strings.noItems}
                      preserveRootOrder
                      showSwipeHint={false}
                    />
                  </div>
                ))}
              {revisitTasks.length > 0 ? (
                <div className="section" key="revisit">
                  <div className="section-title">{strings.revisit}</div>
                  <TaskOutline
                    tasks={revisitTasks}
                    emptyMessage={strings.noItems}
                    preserveRootOrder
                    showRevisitDate
                    showSwipeHint={false}
                  />
                </div>
              ) : null}
              {additionalTasks.length > 0 ? (
                <div className="section">
                  <div className="section-title">{strings.unscheduled}</div>
                  <TaskOutline
                    tasks={additionalTasks}
                    emptyMessage={strings.noItems}
                    preserveRootOrder
                    showSwipeHint={false}
                  />
                </div>
              ) : null}
            </>
          );
        })()
      ) : null}
      <QuickAdd />
    </div>
  );
}
