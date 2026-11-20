import { useLayoutEffect, useMemo, useRef } from "react";
import { InteractionScopeProvider } from "../lib/interactionScope";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useStrings } from "../lib/strings";
import { useIdentity } from "../lib/identity";
import { PageHeader } from "../components/PageHeader";
import { LoadingState, ErrorState, EmptyState } from "../components/AsyncStates";
import { TaskOutline } from "../components/TaskOutline";
import { ProjectStoryRow } from "../components/ProjectStoryRow";
import { ViewCompletionNotice } from "../components/ViewCompletionNotice";

/** A quiet, shared list of work nominated for a future household discussion. */
export function DiscussionPage() {
  const strings = useStrings();
  const { currentMemberId } = useIdentity();
  const accessResource = useMemo(
    () => ({ type: "view" as const, key: `discussion:${currentMemberId}` }),
    [currentMemberId],
  );
  const { data, loading, error, refreshError, reload } = useAsync(
    () => api.getDiscussion(),
    [currentMemberId],
    accessResource,
  );
  const readError = error;
  const tasks = data?.tasks ?? [];
  const projects = data?.projects ?? [];
  const empty = data !== null && tasks.length === 0 && projects.length === 0;
  const pageRef = useRef<HTMLDivElement>(null);
  const focusedTaskElement = useRef<HTMLElement | null>(null);
  const restoreTaskFocus = useRef(false);

  useLayoutEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    if (refreshError) {
      if (!focusedTaskElement.current) return;
      restoreTaskFocus.current = true;
      page.querySelector<HTMLButtonElement>(".error-state button")?.focus();
      return;
    }
    if (!restoreTaskFocus.current) return;
    restoreTaskFocus.current = false;
    const target = focusedTaskElement.current;
    focusedTaskElement.current = null;
    if (target?.isConnected) target.focus();
  }, [data, refreshError]);

  return (
    <ViewCompletionNotice accessResource={accessResource} enabled={data !== null}>
    <InteractionScopeProvider>
    <div
      className="discussion-page"
      ref={pageRef}
      onFocusCapture={event => {
        const row = (event.target as HTMLElement).closest("[data-workitem-id][data-workitem-role='task']");
        if (row) focusedTaskElement.current = event.target as HTMLElement;
      }}
    >
      <PageHeader title={strings.discussionTitle} />
      {loading ? <LoadingState /> : null}
      {readError ? <ErrorState message={readError} onRetry={reload} /> : null}
      {refreshError ? <ErrorState message={refreshError} onRetry={reload} /> : null}
      {empty ? <EmptyState message={strings.discussionEmpty} /> : null}
      {projects.length ? (
        <section className="section" aria-label={strings.projects}>
          <ul className="list" style={{ padding: 0, margin: 0 }}>
            {projects.map((project) => (
              <ProjectStoryRow key={project.id} story={project} variant="compact" />
            ))}
          </ul>
        </section>
      ) : null}
      {tasks.length ? (
        <section className="section" aria-label={strings.inbox}>
          <div {...(refreshError ? { inert: "" } : {})}>
            <TaskOutline tasks={tasks} emptyMessage={strings.discussionEmpty} preserveRootOrder showSwipeHint={false} />
          </div>
        </section>
      ) : null}
    </div>
    </InteractionScopeProvider>
    </ViewCompletionNotice>
  );
}
