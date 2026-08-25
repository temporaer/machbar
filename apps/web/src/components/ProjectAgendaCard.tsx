import { Link } from "react-router-dom";
import type { ProjectAgendaEntry } from "@machbar/shared";
import {
  formatExactLocalDate,
  formatRelativeDueDate,
  formatRelativeScheduleDate,
} from "../lib/relativeDate";
import { strings, stuckReasonLabels } from "../lib/strings";

function DatePrompt({
  label,
  date,
  scheduled = false,
}: {
  label: string;
  date: string | null;
  scheduled?: boolean;
}) {
  if (!date) return null;
  const relative = scheduled
    ? formatRelativeScheduleDate(date)
    : formatRelativeDueDate(date);
  const exact = formatExactLocalDate(date);
  if (!relative || !exact) return null;
  const accessible = `${label}: ${relative} (${exact})`;
  return (
    <span className="project-agenda-date" title={accessible} aria-label={accessible}>
      {label}: {relative}
    </span>
  );
}

export function ProjectAgendaCard({ entry }: { entry: ProjectAgendaEntry }) {
  const { project, qualification, nextAction, stuck } = entry;
  const heading =
    qualification === "due"
      ? strings.projectDue
      : qualification === "scheduled"
        ? strings.projectReview
        : strings.projectReviewAndDue;

  return (
    <article className="card project-agenda-card">
      <div className="project-agenda-heading">
        <span className="badge">{heading}</span>
        {stuck ? <span className="badge badge-stuck">{stuckReasonLabels[stuck.reason]}</span> : null}
      </div>
      <Link className="project-agenda-link" to={`/projekte/${project.id}`}>
        {project.title}
      </Link>
      <div className="project-agenda-dates">
        {qualification !== "due" ? (
          <DatePrompt label={strings.review} date={project.scheduledDate} scheduled />
        ) : null}
        {qualification !== "scheduled" ? (
          <DatePrompt label={strings.due} date={project.dueDate} />
        ) : null}
      </div>
      {nextAction ? (
        <p className="project-agenda-context">
          <strong>{strings.nextAction}:</strong> {nextAction.title}
        </p>
      ) : null}
      {stuck ? (
        <p className="project-agenda-context">
          <strong>{strings.stuck}:</strong> {stuck.repairAction}
        </p>
      ) : null}
    </article>
  );
}
