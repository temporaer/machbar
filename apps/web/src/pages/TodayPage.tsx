import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useIdentity } from "../lib/identity";
import { strings } from "../lib/strings";
import { LoadingState, ErrorState, EmptyState } from "../components/AsyncStates";
import { TaskOutline } from "../components/TaskOutline";
import { QuickAdd } from "../components/QuickAdd";
import { ProjectAgendaCard } from "../components/ProjectAgendaCard";
import { PageHeader, type PageHint } from "../components/PageHeader";

const sections: Array<{
  key: "planned" | "overdue" | "dueToday" | "dueSoon";
  label: string;
}> = [
  { key: "planned", label: strings.plannedToday },
  { key: "overdue", label: strings.overdue },
  { key: "dueToday", label: strings.dueToday },
  { key: "dueSoon", label: strings.dueSoon },
];

export function TodayPage() {
  // `IdentityGate` (mounted above every route in `App.tsx`) normally
  // guarantees a member is selected before this page ever renders, but we
  // still guard against a transient/null `currentMemberId` here (e.g. in
  // isolated tests, or a brief render before the gate kicks in) so the
  // page never throws and never ends up requesting -- or rendering --
  // another member's tasks. Re-fetching whenever `currentMemberId` changes
  // ensures switching identities always shows that member's own agenda.
  const { currentMemberId } = useIdentity();
  const { data: agenda, loading, error, reload } = useAsync(
    () => api.getAgenda(currentMemberId),
    [currentMemberId],
  );
  const revisitTasks = agenda?.revisit ?? [];
  const followUpTasks = agenda?.followUp ?? [];
  const additionalTasks = [...(agenda?.shared ?? []), ...(agenda?.unscheduled ?? [])];
  const projectAgenda = agenda?.projects ?? [];
  const pageHints: PageHint[] = [
    { text: strings.todayExplanation },
    ...(followUpTasks.length > 0
      ? [{ label: strings.followUp, text: strings.followUpHint }]
      : []),
    ...(revisitTasks.length > 0
      ? [{ label: strings.revisit, text: strings.revisitHint }]
      : []),
  ];

  return (
    <div>
      <PageHeader title={strings.today} hints={pageHints} />
      {loading ? <LoadingState /> : null}
      {error ? <ErrorState message={error} onRetry={reload} /> : null}
      {agenda ? (
        (() => {
          const total =
            sections.reduce((sum, s) => sum + agenda[s.key].length, 0) +
            followUpTasks.length +
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
                      <ProjectAgendaCard key={entry.project.id} entry={entry} />
                    ))}
                  </div>
                </section>
              ) : null}
              {sections
                .filter((s) => agenda[s.key].length > 0)
                .map((s) => (
                  <div className="section" key={s.key}>
                    <div className="section-title">{s.label}</div>
                    <TaskOutline tasks={agenda[s.key]} emptyMessage={strings.noItems} />
                  </div>
                ))}
              {followUpTasks.length > 0 ? (
                <div className="section">
                  <div className="section-title">{strings.followUp}</div>
                  <TaskOutline tasks={followUpTasks} emptyMessage={strings.noItems} />
                </div>
              ) : null}
              {revisitTasks.length > 0 ? (
                <div className="section" key="revisit">
                  <div className="section-title">{strings.revisit}</div>
                  <TaskOutline tasks={revisitTasks} emptyMessage={strings.noItems} />
                </div>
              ) : null}
              {additionalTasks.length > 0 ? (
                <div className="section">
                  <div className="section-title">{strings.unscheduled}</div>
                  <TaskOutline tasks={additionalTasks} emptyMessage={strings.noItems} />
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
