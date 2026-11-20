import { useMemo, useState } from "react";
import { api, type AgendaScope } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useStrings } from "../lib/strings";
import { LoadingState, ErrorState } from "../components/AsyncStates";
import { WaitingGroupList } from "../components/WaitingGroupList";
import { PageHeader } from "../components/PageHeader";
import { useIdentity } from "../lib/identity";
import { InteractionScopeProvider } from "../lib/interactionScope";
import { WorkItemKeyboardNavMount } from "../components/WorkItemKeyboardNavMount";
import { IconActionGlyph } from "../components/IconActionButton";
import { readTodayScope, writeTodayScope, nextAgendaScope } from "../lib/todayScope";
import { ViewCompletionNotice } from "../components/ViewCompletionNotice";

export function WaitingPage() {
  const strings = useStrings();
  const { currentMemberId } = useIdentity();
  const [scope, setScope] = useState<AgendaScope>(readTodayScope);
  const accessResource = useMemo(
    () => ({ type: "waiting" as const, memberId: currentMemberId, scope }),
    [currentMemberId, scope],
  );
  const selectScope = (nextScope: AgendaScope) => {
    setScope(nextScope);
    writeTodayScope(nextScope);
  };
  const {
    data: entries,
    loading,
    error,
    refreshError,
    reload,
  } = useAsync(
    () => api.getWaiting(currentMemberId, scope),
    [currentMemberId, scope],
    accessResource,
  );
  return (
    <ViewCompletionNotice
      accessResource={accessResource}
      enabled={entries !== null}
      readUnavailable={error !== null || refreshError !== null}
    >
    <InteractionScopeProvider>
      {!refreshError ? <WorkItemKeyboardNavMount /> : null}
      <div className="waiting-page">
        <PageHeader
          title={strings.waiting}
          actions={
            <button
              type="button"
              className="page-header-button waiting-scope-toggle"
              aria-label={
                scope === "mine"
                  ? strings.waitingHouseholdScope
                  : scope === "all"
                    ? strings.waitingWorkScope
                    : strings.waitingMineScope
              }
              aria-pressed={scope !== "mine"}
              title={
                scope === "mine"
                  ? strings.waitingHouseholdScope
                  : scope === "all"
                    ? strings.waitingWorkScope
                    : strings.waitingMineScope
              }
              onClick={() => selectScope(nextAgendaScope(scope))}
            >
              <IconActionGlyph
                kind={scope === "mine" ? "owner" : scope === "all" ? "household" : "work"}
              />
            </button>
          }
        />
        {loading ? <LoadingState /> : null}
        {error ? <ErrorState message={error} onRetry={reload} /> : null}
        {refreshError ? <ErrorState message={refreshError} onRetry={reload} /> : null}
        <div {...(refreshError ? { inert: "" } : {})}>
          {entries ? <WaitingGroupList key={`${scope}:${currentMemberId}`} entries={entries} /> : null}
        </div>
      </div>
    </InteractionScopeProvider>
    </ViewCompletionNotice>
  );
}
