import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useProjectWorkflowActions } from "../lib/useProjectWorkflowActions";
import { useStrings } from "../lib/strings";
import { LoadingState, ErrorState, EmptyState } from "../components/AsyncStates";
import { ProjectStoryRow } from "../components/ProjectStoryRow";
import { PageHeader } from "../components/PageHeader";
import "./BacklogReviewPage.css";

/**
 * "Backlog prüfen" answers whether a backlog project should start, remain
 * parked, be prepared further, or be archived. Existing task/criteria
 * summaries are planning context, not clarification defects; activation
 * opens the shared readiness preflight in `ProjectStoryRow`.
 */
export function BacklogReviewPage() {
  const strings = useStrings();
  const { data: projects, loading, error, reload } = useAsync(() => api.getProjects(), []);
  const actions = useProjectWorkflowActions();

  const backlogStories = (projects ?? []).filter((p) => p.status === "backlog");
  // A story that just got optimistically activated/archived (and is still
  // within its retention window) must keep rendering here even though the
  // freshly refetched `projects` list no longer includes it as `backlog`.
  const retainedOnly = [...actions.retained.values()]
    .map((entry) => entry.story)
    .filter((story) => !backlogStories.some((s) => s.id === story.id));
  const visibleStories = [...backlogStories, ...retainedOnly];

  return (
    <div>
      <PageHeader
        title={strings.backlogReview}
        hints={[{ text: strings.backlogReviewHint }]}
      />
      {loading ? <LoadingState /> : null}
      {error ? <ErrorState message={error} onRetry={reload} /> : null}
      {projects ? (
        visibleStories.length === 0 ? (
          <EmptyState message={strings.backlogReviewEmpty} />
        ) : (
          <ul className="list backlog-review-list story-row-list">
            {visibleStories.map((story) => (
              <ProjectStoryRow key={story.id} story={story} actions={actions} />
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}
