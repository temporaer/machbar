import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, type AgendaScope } from "../lib/api";
import { useAsync, type ReadAccessResource } from "../lib/useAsync";
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

function WaitingCompletionFeedback({ scope }: { scope: AgendaScope }) {
  const strings = useStrings();
  const client = useQueryClient();
  const { currentMemberId } = useIdentity();
  const { registerCompletionFeedback, pendingIds } = useTaskActions();
  const [notice, setNotice] = useState<{ taskId: number; message: string; sequence: number } | null>(null);
  const noticeRef = useRef(notice);
  const pendingIdsRef = useRef(pendingIds);
  const deniedTaskIds = useRef(new Set<number>());
  noticeRef.current = notice;
  pendingIdsRef.current = pendingIds;
  useLayoutEffect(() => {
    const unregister = registerCompletionFeedback({
      pendingMessage: strings.taskCompleting,
      onCommitted: task => {
        if (deniedTaskIds.current.has(task.id)) return;
        const next = {
          taskId: task.id,
          message: task.repeatAfterDays === null
            ? strings.taskCompletionConfirmed(task.title)
            : strings.taskOccurrenceConfirmed(task.title),
          sequence: (noticeRef.current?.sequence ?? 0) + 1,
        };
        noticeRef.current = next;
        setNotice(next);
      },
    });
    const unsubscribe = client.getQueryCache().subscribe(event => {
      if (event.type !== "updated" || !isReadAccessError(event.query.state.error)) return;
      const resource = event.query.meta?.accessResource as ReadAccessResource | undefined;
      if (resource?.type === "waiting" &&
        resource.memberId === currentMemberId && resource.scope === scope) {
        unregister();
        noticeRef.current = null;
        setNotice(null);
        return;
      }
      if (resource?.type !== "task" ||
        (!pendingIdsRef.current.has(resource.taskId) && noticeRef.current?.taskId !== resource.taskId)) return;
      deniedTaskIds.current.add(resource.taskId);
      if (noticeRef.current?.taskId === resource.taskId) {
        noticeRef.current = null;
        setNotice(null);
      }
    });
    return () => { unsubscribe(); unregister(); };
  }, [client, currentMemberId, registerCompletionFeedback, scope, strings]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => {
      if (noticeRef.current === notice) {
        noticeRef.current = null;
        setNotice(null);
      }
    }, 3_000);
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
    { type: "waiting", memberId: currentMemberId, scope },
  );
  return (
    <InteractionScopeProvider>
      {!refreshError ? <WorkItemKeyboardNavMount /> : null}
      {entries ? <WaitingCompletionFeedback key={`${scope}:${currentMemberId}`} scope={scope} /> : null}
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
