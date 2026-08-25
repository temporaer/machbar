import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { strings } from "../lib/strings";
import { LoadingState, ErrorState } from "../components/AsyncStates";
import { StuckProjectList } from "../components/StuckProjectList";

export function StuckPage() {
  const { data: projects, loading, error, reload } = useAsync(() => api.getStuckProjects(), []);
  return (
    <div>
      <div className="page-header">
        <h1>{strings.stuckProjects}</h1>
      </div>
      {loading ? <LoadingState /> : null}
      {error ? <ErrorState message={error} onRetry={reload} /> : null}
      {projects ? <StuckProjectList projects={projects} /> : null}
    </div>
  );
}
