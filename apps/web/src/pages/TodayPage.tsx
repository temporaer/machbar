import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { strings } from "../lib/strings";
import { LoadingState, ErrorState, EmptyState } from "../components/AsyncStates";
import { TaskOutline } from "../components/TaskOutline";
import { QuickAdd } from "../components/QuickAdd";

const sections: Array<{ key: "planned" | "overdue" | "dueToday" | "dueSoon" | "shared"; label: string }> = [
  { key: "planned", label: strings.plannedToday },
  { key: "overdue", label: strings.overdue },
  { key: "dueToday", label: strings.dueToday },
  { key: "dueSoon", label: strings.dueSoon },
  { key: "shared", label: strings.shared },
];

export function TodayPage() {
  const { data: agenda, loading, error, reload } = useAsync(() => api.getAgenda(), []);
  const revisitTasks = agenda?.revisit ?? [];

  return (
    <div>
      <div className="page-header">
        <h1>{strings.today}</h1>
      </div>
      <p className="text-muted">{strings.todayExplanation}</p>
      {loading ? <LoadingState /> : null}
      {error ? <ErrorState message={error} onRetry={reload} /> : null}
      {agenda ? (
        (() => {
          const total = sections.reduce((sum, s) => sum + agenda[s.key].length, 0) + revisitTasks.length;
          if (total === 0) return <EmptyState message={strings.todayEmpty} />;
          return (
            <>
              {sections
                .filter((s) => agenda[s.key].length > 0)
                .map((s) => (
                  <div className="section" key={s.key}>
                    <div className="section-title">{s.label}</div>
                    <TaskOutline tasks={agenda[s.key]} emptyMessage={strings.noItems} />
                  </div>
                ))}
              {revisitTasks.length > 0 ? (
                <div className="section" key="revisit">
                  <div className="section-title">{strings.revisit}</div>
                  <p className="text-muted">{strings.revisitHint}</p>
                  <TaskOutline tasks={revisitTasks} emptyMessage={strings.noItems} />
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
