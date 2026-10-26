import { InteractionScopeProvider } from "../lib/interactionScope";
import { flattenTasks } from "../lib/taskHelpers";
import { useTaskActions } from "../lib/useTaskActions";
import { useProjectActions } from "../lib/useProjectActions";
import { useRetainedPlacement } from "../lib/useRetainedPlacement";
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
  const taskActions = useTaskActions(flattenTasks(data?.tasks ?? []));
  const projectActions = useProjectActions(data?.projects ?? []);
  const { rows: tasks } = useRetainedPlacement({ rows: data?.tasks ?? [] }, taskActions.holdingIds,
    taskActions.projectTask);
  const { rows: projects } = useRetainedPlacement({ rows: data?.projects ?? [] }, projectActions.holdingIds,
    projectActions.projectStory);
  const empty = data !== null && tasks.length === 0 && projects.length === 0;

  return (
    <InteractionScopeProvider>
    <div className="discussion-page">
      <PageHeader title={strings.discussionTitle} />
      {loading ? <LoadingState /> : null}
      {error ? <ErrorState message={error} onRetry={reload} /> : null}
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
          <TaskOutline tasks={tasks} emptyMessage={strings.discussionEmpty} preserveRootOrder showSwipeHint={false} />
        </section>
      ) : null}
    </div>
    </InteractionScopeProvider>
  );
}
