import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { strings } from "../lib/strings";
import { LoadingState, ErrorState } from "../components/AsyncStates";
import { WaitingGroupList } from "../components/WaitingGroupList";

export function WaitingPage() {
  const { data: groups, loading, error, reload } = useAsync(() => api.getWaiting(), []);
  return (
    <div>
      <div className="page-header">
        <h1>{strings.waiting}</h1>
      </div>
      {loading ? <LoadingState /> : null}
      {error ? <ErrorState message={error} onRetry={reload} /> : null}
      {groups ? <WaitingGroupList groups={groups} /> : null}
    </div>
  );
}
