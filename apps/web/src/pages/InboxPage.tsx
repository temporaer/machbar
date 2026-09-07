import { useEffect } from "react";
import type { Task } from "@machbar/shared";
import { api } from "../lib/api";
import { useLocation } from "react-router-dom";
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

export function InboxPage() {
  const strings = useStrings();
  const {
    data: tasks,
    loading,
    error,
    reload,
  } = useAsync(() => api.getInbox(), []);
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
            tasks && tasks.length > 0 ? (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => openQueue(tasks.map((t) => t.id))}
              >
                {strings.clarifyNow}
              </button>
            ) : null
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
        <QuickAdd />
      </div>
    </InteractionScopeProvider>
  );
}

function InboxFocusRail({
  tasks,
  focusId,
}: {
  tasks: Task[] | null | undefined;
  focusId: string | null;
}) {
  const scope = useInteractionScope();
  useEffect(() => {
    const id = Number(focusId);
    if (!tasks || !Number.isFinite(id) || !tasks.some((task) => task.id === id)) return;
    scope.setActive(id, "task");
    scope.setOpenRail(id);
  }, [focusId, scope, tasks]);
  return null;
}
