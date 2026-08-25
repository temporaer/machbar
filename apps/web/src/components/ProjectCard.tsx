import { Link } from "react-router-dom";
import type { Project } from "@machbar/shared";
import { strings, stuckReasonLabels } from "../lib/strings";
import { formatDate } from "../lib/format";
import { useIdentity } from "../lib/identity";

export function ProjectCard({ project }: { project: Project }) {
  const { members } = useIdentity();
  const owner = members.find((m) => m.id === project.ownerMemberId);
  const total = (project.openCount ?? 0) + (project.doneCount ?? 0);
  const pct = total > 0 ? Math.round(((project.doneCount ?? 0) / total) * 100) : 0;
  const criteriaTotal = project.acceptanceCriteria.length;
  const criteriaDone = project.acceptanceCriteria.filter((c) => c.checked).length;
  const criteriaPct = criteriaTotal > 0 ? Math.round((criteriaDone / criteriaTotal) * 100) : 0;
  const due = formatDate(project.dueDate);

  return (
    <Link to={`/projekte/${project.id}`} className="list-link">
      <div className="card">
        <div className="row-between">
          <h3 style={{ margin: 0, fontSize: "1rem" }}>{project.title}</h3>
          {project.stuckReason ? (
            <span className="badge badge-stuck">{stuckReasonLabels[project.stuckReason]}</span>
          ) : null}
        </div>
        <div className="row-between text-muted" style={{ fontSize: "0.78rem" }}>
          <span>{owner ? owner.name : strings.unassigned}</span>
          {due ? <span>{strings.due}: {due}</span> : null}
        </div>
        <p className="text-muted" style={{ fontSize: "0.8rem", margin: "8px 0 0" }}>
          {project.nextAction ? `${strings.nextAction}: ${project.nextAction.title}` : strings.noNextAction}
        </p>
        {total > 0 ? (
          <div className="project-card-progress">
            <span style={{ width: `${pct}%` }} />
          </div>
        ) : null}
        {criteriaTotal > 0 ? (
          <>
            <p className="text-muted" style={{ fontSize: "0.78rem", margin: "6px 0 0" }}>
              {strings.criteria}: {criteriaDone}/{criteriaTotal}
            </p>
            <div className="criteria-progress">
              <span style={{ width: `${criteriaPct}%` }} />
            </div>
          </>
        ) : null}
      </div>
    </Link>
  );
}
