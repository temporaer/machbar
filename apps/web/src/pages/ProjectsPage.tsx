import { useState } from "react";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useRefresh } from "../lib/refresh";
import { strings } from "../lib/strings";
import { useProjectWorkflowActions } from "../lib/useProjectWorkflowActions";
import { LoadingState, ErrorState, EmptyState } from "../components/AsyncStates";
import { ProjectStoryRow } from "../components/ProjectStoryRow";
import { BottomSheet } from "../components/BottomSheet";

/**
 * The Projekte tab: every project is a user story, and every row carries the
 * full Scrum-style workflow directly — right swipe (or the dedicated primary
 * button) performs the status-appropriate next step, left swipe or ⋯ reveals
 * the driver/criteria/dates/edit chips plus the remaining legal transitions.
 * See `components/ProjectStoryRow.tsx` for the gesture behaviour and
 * `lib/useProjectWorkflowActions.ts` for the optimistic retention.
 */
export function ProjectsPage() {
  const { data: projects, loading, error, reload } = useAsync(() => api.getProjects(), []);
  const { bump } = useRefresh();
  const actions = useProjectWorkflowActions();
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      await api.createProject({ title: trimmed });
      setTitle("");
      setCreating(false);
      bump();
      reload();
    } finally {
      setSaving(false);
    }
  };

  const listed = projects ?? [];
  // A story that just transitioned optimistically must keep rendering during
  // its retention window even if a refetch drops it from this list.
  const retainedOnly = [...actions.retained.values()]
    .map((entry) => entry.story)
    .filter((story) => !listed.some((p) => p.id === story.id));
  const visibleProjects = [...listed, ...retainedOnly];

  return (
    <div>
      <div className="page-header">
        <h1>{strings.projects}</h1>
        <button type="button" className="btn btn-sm btn-primary" onClick={() => setCreating(true)}>
          {strings.addProject}
        </button>
      </div>
      <p className="text-muted">{strings.projectsSwipeHint}</p>
      {loading ? <LoadingState /> : null}
      {error ? <ErrorState message={error} onRetry={reload} /> : null}
      {projects ? (
        visibleProjects.length === 0 ? (
          <EmptyState message={strings.noProjects} />
        ) : (
          <ul className="list story-row-list">
            {visibleProjects.map((p) => (
              <ProjectStoryRow key={p.id} story={p} actions={actions} variant="card" />
            ))}
          </ul>
        )
      ) : null}
      {creating ? (
        <BottomSheet title={strings.newProject} onClose={() => setCreating(false)} labelledBy="new-project-title">
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <div className="field">
              <label htmlFor="new-project-name">{strings.projectTitle}</label>
              <input id="new-project-name" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <p className="text-muted">{strings.titleEnough}</p>
            <div className="row">
              <button type="button" className="btn" onClick={() => setCreating(false)}>
                {strings.cancel}
              </button>
              <button type="submit" className="btn btn-primary btn-block" disabled={saving || !title.trim()}>
                {strings.save}
              </button>
            </div>
          </form>
        </BottomSheet>
      ) : null}
    </div>
  );
}
