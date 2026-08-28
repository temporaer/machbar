import type {
  DebugMetrics,
  ProjectStatus,
  TaskStatus,
} from "@machbar/shared";
import { ErrorState, LoadingState } from "../components/AsyncStates";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useStrings } from "../lib/strings";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatDuration(value: number | null): string {
  return value === null ? "–" : `${value.toFixed(2)} ms`;
}

function Metric({
  label,
  value,
}: {
  label: string;
  value: string | number;
}) {
  return (
    <div className="debug-metric">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function MetricsContent({ metrics }: { metrics: DebugMetrics }) {
  const strings = useStrings();
  const database = metrics.database;
  const graph = metrics.graphLoads;
  return (
    <div className="stack">
      <section className="card">
        <h2>{strings.debugDatabase}</h2>
        <dl className="debug-metrics-grid">
          <Metric label={strings.debugDatabaseSize} value={formatBytes(database.usedBytes)} />
          <Metric label={strings.debugAllocatedSize} value={formatBytes(database.allocatedBytes)} />
          <Metric label={strings.projects} value={database.counts.projects} />
          <Metric label={strings.debugTasks} value={database.counts.tasks} />
          <Metric label={strings.debugDependencies} value={database.counts.dependencies} />
          <Metric label={strings.debugActivityEvents} value={database.counts.activityEvents} />
          <Metric label={strings.debugMaxTaskDepth} value={database.maxTaskDepth} />
          <Metric label={strings.debugTasksToday} value={database.tasksCreatedToday} />
          <Metric label={strings.debugTasksLast7Days} value={database.tasksCreatedLast7Days} />
        </dl>
      </section>

      <section className="card">
        <h2>{strings.debugGraphLoads}</h2>
        <p className="text-muted">{strings.debugGraphLoadsHint}</p>
        <dl className="debug-metrics-grid">
          <Metric label={strings.debugTotalLoads} value={graph.totalLoads} />
          <Metric label={strings.debugRecentSamples} value={graph.recentSamples} />
          <Metric label={strings.debugLastDuration} value={formatDuration(graph.lastMs)} />
          <Metric label={strings.debugAverageDuration} value={formatDuration(graph.averageMs)} />
          <Metric label="p50" value={formatDuration(graph.p50Ms)} />
          <Metric label="p95" value={formatDuration(graph.p95Ms)} />
          <Metric label={strings.debugMaximumDuration} value={formatDuration(graph.maxMs)} />
          <Metric
            label={strings.debugLastGraphSize}
            value={
              graph.lastTaskCount === null
                ? "–"
                : `${graph.lastTaskCount} / ${graph.lastProjectCount ?? 0}`
            }
          />
        </dl>
      </section>

      <section className="card">
        <h2>{strings.debugStatuses}</h2>
        <dl className="debug-metrics-grid">
          {(
            Object.entries(database.taskStatusCounts) as Array<
              [TaskStatus, number]
            >
          ).map(([status, count]) => (
            <Metric
              key={`task-${status}`}
              label={`${strings.debugTasks}: ${strings.taskStatusLabels[status]}`}
              value={count}
            />
          ))}
          {(
            Object.entries(database.projectStatusCounts) as Array<
              [ProjectStatus, number]
            >
          ).map(([status, count]) => (
            <Metric
              key={`project-${status}`}
              label={`${strings.projects}: ${strings.projectStatusLabels[status]}`}
              value={count}
            />
          ))}
        </dl>
      </section>

      <p className="text-muted debug-generated-at">
        {strings.debugGeneratedAt(new Date(metrics.generatedAt).toLocaleString())}
      </p>
    </div>
  );
}

export function DebugPage() {
  const strings = useStrings();
  const { data, loading, error, reload } = useAsync(() => api.getDebugMetrics(), []);
  return (
    <div>
      <div className="page-header">
        <h1>{strings.debugTitle}</h1>
        <button type="button" className="btn btn-sm" onClick={reload} disabled={loading}>
          {strings.debugRefresh}
        </button>
      </div>
      <p className="page-subtitle">{strings.debugHint}</p>
      {loading && !data ? <LoadingState /> : null}
      {error && !data ? <ErrorState message={error} onRetry={reload} /> : null}
      {data ? <MetricsContent metrics={data} /> : null}
    </div>
  );
}
