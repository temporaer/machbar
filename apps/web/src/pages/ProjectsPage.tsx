import { useState } from "react";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useRefresh } from "../lib/refresh";
import { strings } from "../lib/strings";
import { LoadingState, ErrorState, EmptyState } from "../components/AsyncStates";
import { ProjectCard } from "../components/ProjectCard";
import { BottomSheet } from "../components/BottomSheet";

export function ProjectsPage() {
  const { data: projects, loading, error, reload } = useAsync(() => api.getProjects(), []);
  const { bump } = useRefresh();
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

  return (
    <div>
      <div className="page-header">
        <h1>{strings.projects}</h1>
        <button type="button" className="btn btn-sm btn-primary" onClick={() => setCreating(true)}>
          {strings.addProject}
        </button>
      </div>
      {loading ? <LoadingState /> : null}
      {error ? <ErrorState message={error} onRetry={reload} /> : null}
      {projects ? (
        projects.length === 0 ? (
          <EmptyState message={strings.noProjects} />
        ) : (
          <div className="stack">
            {projects.map((p) => (
              <ProjectCard key={p.id} project={p} />
            ))}
          </div>
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
