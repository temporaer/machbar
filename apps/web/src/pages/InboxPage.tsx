import { useEffect, useRef, useState } from "react";
import type { Task } from "@machbar/shared";
import { api, type AgendaScope } from "../lib/api";
import { useLocation, useNavigate } from "react-router-dom";
import { useAsync } from "../lib/useAsync";
import { useStrings } from "../lib/strings";
import {
  LoadingState,
  ErrorState,
  EmptyState,
} from "../components/AsyncStates";
import { TaskOutline } from "../components/TaskOutline";
import { QuickAdd } from "../components/QuickAdd";
import { useTaskDetail } from "../lib/taskDetailContext";
import { PageHeader } from "../components/PageHeader";
import { InteractionScopeProvider, useInteractionScope } from "../lib/interactionScope";
import { WorkItemKeyboardNavMount } from "../components/WorkItemKeyboardNavMount";
import { useIdentity } from "../lib/identity";
import { IconActionGlyph } from "../components/IconActionButton";
import { readTodayScope, writeTodayScope, nextAgendaScope } from "../lib/todayScope";

export function InboxPage() {
  const strings = useStrings();
  const { currentMemberId } = useIdentity();
  const [scope, setScope] = useState<AgendaScope>(readTodayScope);
  const selectScope = (nextScope: AgendaScope) => {
    setScope(nextScope);
    writeTodayScope(nextScope);
  };
  const {
    data: tasks,
    loading,
    error,
    reload,
  } = useAsync(
    () => api.getInbox(currentMemberId, scope),
    [currentMemberId, scope],
  );
  const { openQueue } = useTaskDetail();
  const location = useLocation();

  return (
    <InteractionScopeProvider>
      <InboxFocusRail tasks={tasks} focusId={new URLSearchParams(location.search).get("focus")} />
      <WorkItemKeyboardNavMount />
      <div className="inbox-page">
        <PageHeader
          title={strings.inbox}
          actions={
            <>
              <button
                type="button"
                className="page-header-button inbox-scope-toggle"
                aria-label={
                  scope === "mine"
                    ? strings.inboxHouseholdScope
                    : scope === "all"
                      ? strings.inboxWorkScope
                      : strings.inboxMineScope
                }
                aria-pressed={scope !== "mine"}
                title={
                  scope === "mine"
                    ? strings.inboxHouseholdScope
                    : scope === "all"
                      ? strings.inboxWorkScope
                      : strings.inboxMineScope
                }
                onClick={() => selectScope(nextAgendaScope(scope))}
              >
                <IconActionGlyph
                  kind={scope === "mine" ? "owner" : scope === "all" ? "household" : "work"}
                />
              </button>
              {tasks && tasks.length > 0 ? (
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={() => openQueue(tasks.map((t) => t.id))}
                >
                  {strings.clarifyNow}
                </button>
              ) : null}
            </>
          }
          hints={[{ text: strings.inboxHint }]}
        />
        {loading ? <LoadingState /> : null}
        {error ? <ErrorState message={error} onRetry={reload} /> : null}
        {tasks ? (
          tasks.length === 0 ? (
            <EmptyState message={strings.clarifyEmpty} />
          ) : (
            <TaskOutline
              tasks={tasks}
              emptyMessage={strings.clarifyEmpty}
              preserveRootOrder
              showSwipeHint={false}
            />
          )
        ) : null}
        <QuickAdd {...(scope === "work" ? { defaultScope: "work" as const } : {})} />
      </div>
    </InteractionScopeProvider>
  );
}

export function InboxFocusRail({
  tasks,
  focusId,
}: {
  tasks: Task[] | null | undefined;
  focusId: string | null;
}) {
  const { setActive, setOpenRail } = useInteractionScope();
  const location = useLocation();
  const navigate = useNavigate();
  const consumedFocusIdRef = useRef<string | null>(null);

  useEffect(() => {
    const id = Number(focusId);
    if (
      !focusId ||
      consumedFocusIdRef.current === focusId ||
      !tasks ||
      !Number.isFinite(id) ||
      !tasks.some((task) => task.id === id)
    ) {
      return;
    }

    consumedFocusIdRef.current = focusId;
    setActive(id, "task");
    setOpenRail(id);

    const params = new URLSearchParams(location.search);
    params.delete("focus");
    const search = params.toString();
    navigate(
      {
        pathname: location.pathname,
        search: search ? `?${search}` : "",
      },
      { replace: true },
    );
  }, [focusId, location.pathname, location.search, navigate, setActive, setOpenRail, tasks]);
  return null;
}
