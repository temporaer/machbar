import { InteractionScopeProvider } from "../lib/interactionScope";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useStrings } from "../lib/strings";
import { PageHeader } from "../components/PageHeader";
import { LoadingState, ErrorState, EmptyState } from "../components/AsyncStates";
import { TaskOutline } from "../components/TaskOutline";
import { ProjectStoryRow } from "../components/ProjectStoryRow";
import { useIdentity } from "../lib/identity";
import {
  TaskTransitionEmptyState,
  TaskTransitionPresentationProvider,
  TaskTransitionSection,
} from "../lib/taskTransitionPresentationContext";

/** A quiet, shared list of work nominated for a future household discussion. */
export function DiscussionPage() {
  const strings = useStrings();
  const { currentMemberId } = useIdentity();
  const { data, loading, refreshing, error, refreshError, reload } = useAsync(() => api.getDiscussion(), []);
  const readError = error ?? refreshError;
  const tasks = data?.tasks ?? [];
  const projects = data?.projects ?? [];
  const empty = data !== null && tasks.length === 0 && projects.length === 0;
  const transitionProjection = {
    "discussion-tasks": {
      tasks,
      readSettled: !loading && !refreshing && !readError,
      readFailed: Boolean(readError),
    },
  };

  return (
    <TaskTransitionPresentationProvider
      identityKey={`discussion:${currentMemberId ?? "none"}`}
      projection={transitionProjection}
    >
    <InteractionScopeProvider>
    <div className="discussion-page">
      <PageHeader title={strings.discussionTitle} />
      {loading ? <LoadingState /> : null}
      {readError ? <ErrorState message={readError} onRetry={reload} /> : null}
      {empty ? (
        <TaskTransitionEmptyState sectionIds={["discussion-tasks"]}>
          <EmptyState message={strings.discussionEmpty} />
        </TaskTransitionEmptyState>
      ) : null}
      {projects.length ? (
        <section className="section" aria-label={strings.projects}>
          <ul className="list" style={{ padding: 0, margin: 0 }}>
            {projects.map((project) => (
              <ProjectStoryRow key={project.id} story={project} variant="compact" />
            ))}
          </ul>
        </section>
      ) : null}
      <TaskTransitionSection sectionId="discussion-tasks" tasks={tasks}>
        <section className="section" aria-label={strings.inbox}>
          <TaskOutline
            tasks={tasks}
            emptyMessage={strings.discussionEmpty}
            preserveRootOrder
            showSwipeHint={false}
            transitionSectionId="discussion-tasks"
          />
        </section>
      </TaskTransitionSection>
    </div>
    </InteractionScopeProvider>
    </TaskTransitionPresentationProvider>
  );
}
