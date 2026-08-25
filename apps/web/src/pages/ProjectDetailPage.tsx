import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { strings, stuckReasonLabels, projectStatusLabels } from "../lib/strings";
import { LoadingState, ErrorState } from "../components/AsyncStates";
import { TaskOutline } from "../components/TaskOutline";
import { QuickAdd } from "../components/QuickAdd";
import { ProjectEditSheet } from "../components/ProjectEditSheet";
import { countTasks } from "../lib/taskHelpers";
import { useIdentity } from "../lib/identity";
import { formatDate } from "../lib/format";

export function ProjectDetailPage() {
  const params = useParams<{ id: string }>();
  const projectId = Number(params.id);
  const { members } = useIdentity();
  const [editing, setEditing] = useState(false);
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
              <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>
                {strings.edit}
              </button>
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
            {project.stuckReason ? (
              <div className="badge badge-stuck" style={{ marginTop: 6 }}>
                {stuckReasonLabels[project.stuckReason]}
              </div>
            ) : null}
          </div>
          <TaskOutline tasks={project.tasks} emptyMessage={strings.noTasks} />
        </>
      ) : null}
      <QuickAdd projectId={projectId} />
      {editing && project ? <ProjectEditSheet project={project} onClose={() => setEditing(false)} /> : null}
    </div>
  );
}
