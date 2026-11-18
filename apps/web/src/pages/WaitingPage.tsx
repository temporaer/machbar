import { useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
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
import { useTaskActions } from "../lib/useTaskActions";
import { isReadAccessError } from "../lib/errorMessage";

function WaitingCompletionFeedback() {
  const strings = useStrings();
  const client = useQueryClient();
  const { registerCompletionFeedback } = useTaskActions();
  const [notice, setNotice] = useState<{ message: string; sequence: number } | null>(null);
  useLayoutEffect(() => {
    const unregister = registerCompletionFeedback({
      pendingMessage: strings.taskCompleting,
      onCommitted: task => setNotice(previous => ({
        message: task.repeatAfterDays === null
          ? strings.taskCompletionConfirmed(task.title)
          : strings.taskOccurrenceConfirmed(task.title),
        sequence: (previous?.sequence ?? 0) + 1,
      })),
    });
    // A detail/workflow denial can precede (or outlive) the view's own refresh.
    const unsubscribe = client.getQueryCache().subscribe(event => {
      if (event.type === "updated" && isReadAccessError(event.query.state.error)) {
        unregister();
        setNotice(null);
      }
    });
    return () => { unsubscribe(); unregister(); };
  }, [client, registerCompletionFeedback, strings]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(current => current === notice ? null : current), 3_000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  return createPortal(
    <div role="status" aria-live="polite" aria-atomic="true"
      className={notice ? "waiting-completion-feedback card" : "visually-hidden"}>
      {notice ? <span key={notice.sequence}>{notice.message}</span> : null}
    </div>,
    document.body,
  );
}

export function WaitingPage() {
  const strings = useStrings();
  const { currentMemberId } = useIdentity();
  const [scope, setScope] = useState<AgendaScope>(readTodayScope);
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
  );
  return (
    <InteractionScopeProvider>
      {!refreshError ? <WorkItemKeyboardNavMount /> : null}
      {entries ? <WaitingCompletionFeedback key={`${scope}:${currentMemberId}`} /> : null}
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
  );
}
