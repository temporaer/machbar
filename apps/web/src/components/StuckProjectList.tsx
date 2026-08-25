import type { StuckProject } from "@machbar/shared";
import { Link } from "react-router-dom";
import { strings, stuckReasonLabels } from "../lib/strings";
import { EmptyState } from "./AsyncStates";

export function StuckProjectList({ projects }: { projects: StuckProject[] }) {
  if (projects.length === 0) return <EmptyState message={strings.noProjects} />;
  return (
    <ul className="list" style={{ padding: 0, margin: 0 }}>
      {projects.map((project) => (
        <li key={project.id} className="card">
          <div className="row-between">
            <Link to={`/projekte/${project.id}`} className="link-plain">
              {project.title}
            </Link>
            <span className="badge badge-stuck">{stuckReasonLabels[project.stuckReason]}</span>
          </div>
          <p className="text-muted" style={{ margin: "6px 0 0" }}>
            {strings.repairAction}: {project.repairAction}
          </p>
        </li>
      ))}
    </ul>
  );
}
