import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { strings } from "../lib/strings";
import { LoadingState, ErrorState, EmptyState } from "../components/AsyncStates";
import { TaskOutline } from "../components/TaskOutline";
import { QuickAdd } from "../components/QuickAdd";
import { useTaskDetail } from "../lib/taskDetailContext";

export function InboxPage() {
  const { data: tasks, loading, error, reload } = useAsync(() => api.getInbox(), []);
  const { openQueue } = useTaskDetail();

  return (
    <div>
      <div className="page-header">
        <h1>{strings.inbox}</h1>
        {tasks && tasks.length > 0 ? (
          <button type="button" className="btn btn-sm btn-primary" onClick={() => openQueue(tasks.map((t) => t.id))}>
            {strings.clarifyNow}
          </button>
        ) : null}
      </div>
      <p className="page-subtitle">{strings.refile}: {strings.changeParent} · {strings.moveProject}</p>
      {loading ? <LoadingState /> : null}
      {error ? <ErrorState message={error} onRetry={reload} /> : null}
      {tasks ? (
        tasks.length === 0 ? (
          <EmptyState message={strings.clarifyEmpty} />
        ) : (
          <TaskOutline tasks={tasks} emptyMessage={strings.clarifyEmpty} />
        )
      ) : null}
      <QuickAdd />
    </div>
  );
}
