import { useState } from "react";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useStrings } from "../lib/strings";
import { LoadingState, ErrorState } from "../components/AsyncStates";
import { WaitingGroupList } from "../components/WaitingGroupList";
import { TagGroupingControl } from "../components/TagGroupingControl";
import { PageHeader } from "../components/PageHeader";
import type { GroupableTagKind } from "../lib/tagGrouping";

export function WaitingPage() {
  const strings = useStrings();
  const [groupBy, setGroupBy] = useState<GroupableTagKind | null>(null);
  const { data: tasks, loading, error, reload } = useAsync(
    () => api.getWaiting(),
    [],
  );
  return (
    <div className="waiting-page">
      <PageHeader
        title={strings.waiting}
        hints={[
          {
            label: strings.taskGestures,
            text: strings.taskGestureHint(strings.done),
          },
        ]}
      />
      <div className="projects-controls">
        <TagGroupingControl value={groupBy} onChange={setGroupBy} />
      </div>
      {loading ? <LoadingState /> : null}
      {error ? <ErrorState message={error} onRetry={reload} /> : null}
      {tasks ? <WaitingGroupList tasks={tasks} groupBy={groupBy} /> : null}
    </div>
  );
}
