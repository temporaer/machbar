import { useParams, Link } from "react-router-dom";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { strings, stuckReasonLabels } from "../lib/strings";
import { LoadingState, ErrorState } from "../components/AsyncStates";
import { TaskOutline } from "../components/TaskOutline";
import { QuickAdd } from "../components/QuickAdd";
import { countTasks } from "../lib/taskHelpers";
import { useIdentity } from "../lib/identity";
import { formatDate } from "../lib/format";

export function ProjectDetailPage() {
  const params = useParams<{ id: string }>();
  const projectId = Number(params.id);
  const { members } = useIdentity();
  const {
    data: project,
    loading: projectLoading,
    error: projectError,
    reload: reloadProject,
  } = useAsync(() => api.getProject(projectId), [projectId]);

  const owner = project ? members.find((m) => m.id === project.ownerMemberId) : undefined;
  const counts = project ? countTasks(project.tasks) : { open: 0, done: 0 };

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
            <h1>{project.title}</h1>
            {project.description ? <p className="page-subtitle">{project.description}</p> : null}
            <div className="row text-muted" style={{ fontSize: "0.8rem" }}>
              <span>{owner ? owner.name : strings.unassigned}</span>
              {project.dueDate ? (
                <span>
                  {strings.due}: {formatDate(project.dueDate)}
                </span>
              ) : null}
              <span>
                {strings.openTasks}: {counts.open} · {strings.doneTasks}: {counts.done}
              </span>
            </div>
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
    </div>
  );
}
