import { useState } from "react";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { strings } from "../lib/strings";
import { LoadingState, ErrorState } from "../components/AsyncStates";
import { WaitingGroupList } from "../components/WaitingGroupList";
import { TagGroupingControl } from "../components/TagGroupingControl";
import type { GroupableTagKind } from "../lib/tagGrouping";

export function WaitingPage() {
  const [groupBy, setGroupBy] = useState<GroupableTagKind | null>(null);
  const { data: groups, loading, error, reload } = useAsync(
    () => api.getWaiting(),
    [],
  );
  return (
    <div>
      <div className="page-header">
        <h1>{strings.waiting}</h1>
      </div>
      <TagGroupingControl value={groupBy} onChange={setGroupBy} />
      {loading ? <LoadingState /> : null}
      {error ? <ErrorState message={error} onRetry={reload} /> : null}
      {groups ? <WaitingGroupList groups={groups} groupBy={groupBy} /> : null}
    </div>
  );
}
