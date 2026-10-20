import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useStrings } from "../lib/strings";
import { PageHeader } from "../components/PageHeader";
import { LoadingState, ErrorState, EmptyState } from "../components/AsyncStates";
import { TaskOutline } from "../components/TaskOutline";
import { ProjectStoryRow } from "../components/ProjectStoryRow";

/** A quiet, shared list of work nominated for a future household discussion. */
export function DiscussionPage() {
  const strings = useStrings();
  const { data, loading, error, reload } = useAsync(() => api.getDiscussion(), []);
  const empty = data !== null && data.tasks.length === 0 && data.projects.length === 0;

  return (
    <div className="discussion-page">
      <PageHeader title={strings.discussionTitle} />
      {loading ? <LoadingState /> : null}
      {error ? <ErrorState message={error} onRetry={reload} /> : null}
      {empty ? <EmptyState message={strings.discussionEmpty} /> : null}
      {data?.projects.length ? (
        <section className="section" aria-label={strings.projects}>
          <ul className="list" style={{ padding: 0, margin: 0 }}>
            {data.projects.map((project) => (
              <ProjectStoryRow key={project.id} story={project} variant="compact" />
            ))}
          </ul>
        </section>
      ) : null}
      {data?.tasks.length ? (
        <section className="section" aria-label={strings.inbox}>
          <TaskOutline tasks={data.tasks} emptyMessage={strings.discussionEmpty} preserveRootOrder showSwipeHint={false} />
        </section>
      ) : null}
    </div>
  );
}
