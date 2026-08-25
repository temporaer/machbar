import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useProjectWorkflowActions } from "../lib/useProjectWorkflowActions";
import { strings } from "../lib/strings";
import { LoadingState, ErrorState, EmptyState } from "../components/AsyncStates";
import { ProjectStoryRow } from "../components/ProjectStoryRow";
import "./BacklogReviewPage.css";

/**
 * "Backlog prüfen" (Mehr › Backlog prüfen): review stories still sitting in
 * the `backlog` status — their acceptance-criteria progress, optional
 * driver, dates and task summary — and act on them via swipe/kebab
 * (activate, assign a driver, plan dates, edit, archive) without leaving
 * this list. Rows are the same `ProjectStoryRow` the Projekte tab uses (in
 * its compact variant); see that component for the per-row gesture
 * behaviour and `lib/useProjectWorkflowActions.ts` for the optimistic
 * transition retention.
 */
export function BacklogReviewPage() {
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
      <div className="page-header">
        <h1>{strings.backlogReview}</h1>
      </div>
      <p className="text-muted">{strings.backlogReviewHint}</p>
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
