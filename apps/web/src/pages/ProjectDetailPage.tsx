import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { strings, projectStatusLabels } from "../lib/strings";
import { LoadingState, ErrorState } from "../components/AsyncStates";
import { TaskOutline } from "../components/TaskOutline";
import { QuickAdd } from "../components/QuickAdd";
import { ProjectEditSheet } from "../components/ProjectEditSheet";
import { countTasks } from "../lib/taskHelpers";
import { useIdentity } from "../lib/identity";
import { formatDate } from "../lib/format";
import { ProjectStuckNotice } from "../components/ProjectStuckNotice";
import { TaskSequenceSheet } from "../components/TaskSequenceSheet";
import { MarkdownEditor } from "../components/MarkdownEditor";
import { MarkdownNotes } from "../components/MarkdownNotes";
import { NativeShareButton } from "../components/NativeShareButton";
import { serializeProjectForShare } from "../lib/shareText";
import { buildProjectShareUrl } from "../lib/shareUrls";
import { useRefresh } from "../lib/refresh";

export function ProjectDetailPage() {
  const params = useParams<{ id: string }>();
  const projectId = Number(params.id);
  const { members } = useIdentity();
  const [editing, setEditing] = useState(false);
  const [addingSequence, setAddingSequence] = useState(false);
  const [notesEditing, setNotesEditing] = useState(false);
  const [notesDraft, setNotesDraft] = useState("");
  const [notesSaving, setNotesSaving] = useState(false);
  const [notesError, setNotesError] = useState<string | null>(null);
  const { bump } = useRefresh();
  const {
    data: project,
    loading: projectLoading,
    error: projectError,
    reload: reloadProject,
  } = useAsync(() => api.getProject(projectId), [projectId]);

  const owner = project ? members.find((m) => m.id === project.ownerMemberId) : undefined;
  const taskCounts = project ? countTasks(project.tasks) : { open: 0, done: 0 };
  const criteriaTotal = project?.acceptanceCriteria.length ?? 0;
  const criteriaDone = project?.acceptanceCriteria.filter((c) => c.checked).length ?? 0;
  const criteriaPct = criteriaTotal > 0 ? Math.round((criteriaDone / criteriaTotal) * 100) : 0;

  useEffect(() => {
    if (project && !notesEditing) setNotesDraft(project.notes);
  }, [project, notesEditing]);

  const saveNotes = async () => {
    if (!project || notesSaving) return;
    setNotesSaving(true);
    setNotesError(null);
    try {
      await api.updateProject(project.id, { notes: notesDraft });
      setNotesEditing(false);
      bump();
      reloadProject();
    } catch (cause) {
      setNotesError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setNotesSaving(false);
    }
  };

  return (
    <div>
      <Link to="/projekte" className="link-plain">
        ← {strings.projects}
      </Link>
      {projectLoading ? <LoadingState /> : null}
      {projectError ? <ErrorState message={projectError} onRetry={reloadProject} /> : null}
      {project ? (
        <>
          <div className="page-header" style={{ flexDirection: "column", alignItems: "stretch" }}>
            <div className="row-between">
              <h1>{project.title}</h1>
              <div className="row">
                <NativeShareButton
                  title={project.title}
                  text={serializeProjectForShare(project)}
                  url={buildProjectShareUrl(project.id)}
                />
                <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>
                  {strings.edit}
                </button>
              </div>
            </div>
            <div className="row text-muted" style={{ fontSize: "0.8rem" }}>
              <span className="badge">{projectStatusLabels[project.status]}</span>
              <span>
                {strings.driver}: {owner ? owner.name : strings.noDriver}
              </span>
              {project.dueDate ? (
                <span>
                  {strings.due}: {formatDate(project.dueDate)}
                </span>
              ) : null}
            </div>
            <div className="row text-muted" style={{ fontSize: "0.8rem" }}>
              <span>
                {strings.taskProgress}: {taskCounts.open} {strings.openTasks.toLowerCase()} · {taskCounts.done}{" "}
                {strings.doneTasks.toLowerCase()}
              </span>
            </div>
            {criteriaTotal > 0 ? (
              <div>
                <p className="text-muted" style={{ fontSize: "0.8rem", margin: "4px 0 0" }}>
                  {strings.criteria}: {criteriaDone}/{criteriaTotal}
                </p>
                <div className="criteria-progress">
                  <span style={{ width: `${criteriaPct}%` }} />
                </div>
              </div>
            ) : null}
          </div>
          {project.stuckReason ? <ProjectStuckNotice reason={project.stuckReason} /> : null}
          <section className="section project-notes-section">
            <div className="row-between">
              <h2 className="section-title">{strings.notes}</h2>
              {!notesEditing ? (
                <button type="button" className="btn btn-sm" onClick={() => setNotesEditing(true)}>
                  {strings.edit}
                </button>
              ) : null}
            </div>
            {notesEditing ? (
              <div className="stack">
                <MarkdownEditor
                  value={notesDraft}
                  onChange={setNotesDraft}
                  toolbarLabel={strings.markdownToolbar}
                  rows={7}
                  autoFocus
                />
                <div className="row">
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={notesSaving}
                    onClick={() => {
                      setNotesDraft(project.notes);
                      setNotesError(null);
                      setNotesEditing(false);
                    }}
                  >
                    {strings.cancel}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    disabled={notesSaving}
                    onClick={() => void saveNotes()}
                  >
                    {strings.saveNotes}
                  </button>
                </div>
                {notesError ? <p className="capture-error" role="alert">{notesError}</p> : null}
              </div>
            ) : notesDraft.trim() ? (
              <MarkdownNotes value={notesDraft} />
            ) : (
              <p className="text-muted">{strings.noNotes}</p>
            )}
          </section>
          <section className="section">
            <div className="row-between">
              <h2 className="section-title">{strings.taskSummary}</h2>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setAddingSequence(true)}
              >
                {strings.addSequence}
              </button>
            </div>
            <TaskOutline
              tasks={project.tasks}
              emptyMessage={strings.noTasks}
              organizable
            />
          </section>
        </>
      ) : null}
      <QuickAdd projectId={projectId} />
      {editing && project ? <ProjectEditSheet project={project} onClose={() => setEditing(false)} /> : null}
      {addingSequence ? (
        <TaskSequenceSheet
          projectId={projectId}
          onClose={() => setAddingSequence(false)}
        />
      ) : null}
    </div>
  );
}
