import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useStrings } from "../lib/strings";
import { LoadingState, ErrorState } from "../components/AsyncStates";
import { WaitingGroupList } from "../components/WaitingGroupList";
import { PageHeader } from "../components/PageHeader";
import { useIdentity } from "../lib/identity";
import { InteractionScopeProvider } from "../lib/interactionScope";
import { WorkItemKeyboardNavMount } from "../components/WorkItemKeyboardNavMount";

export function WaitingPage() {
  const strings = useStrings();
  const { currentMemberId } = useIdentity();
  const {
    data: entries,
    loading,
    error,
    reload,
  } = useAsync(
    () => api.getWaiting(currentMemberId, "mine"),
    [currentMemberId],
  );
  return (
    <InteractionScopeProvider>
      <WorkItemKeyboardNavMount />
      <div className="waiting-page">
        <PageHeader
          title={strings.waiting}
          hints={[{ text: strings.waitingPageHint }]}
        />
        {loading ? <LoadingState /> : null}
        {error ? <ErrorState message={error} onRetry={reload} /> : null}
        {entries ? <WaitingGroupList entries={entries} /> : null}
      </div>
    </InteractionScopeProvider>
  );
}
