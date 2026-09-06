import { Link } from "react-router-dom";
import type { Member, ProjectAgendaEntry } from "@machbar/shared";
import {
  formatExactLocalDate,
  formatRelativeDueDate,
  formatRelativeScheduleDate,
} from "../lib/relativeDate";
import { useStrings } from "../lib/strings";
import { useLocale } from "../lib/locale";
import { MemberAvatar } from "./MemberAvatar";
import { TaskCardTags } from "./TaskCardTags";

function DatePrompt({
  label,
  date,
  scheduled = false,
}: {
  label: string;
  date: string | null;
  scheduled?: boolean;
}) {
  const { locale } = useLocale();
  if (!date) return null;
  const relative = scheduled
    ? formatRelativeScheduleDate(date, new Date(), locale)
    : formatRelativeDueDate(date, new Date(), locale);
  const exact = formatExactLocalDate(date, locale);
  if (!relative || !exact) return null;
  const accessible = `${label}: ${relative} (${exact})`;
  return (
    <span className="project-agenda-date" title={accessible} aria-label={accessible}>
      {label}: {relative}
    </span>
  );
}

export function ProjectAgendaCard({
  entry,
  owner = null,
}: {
  entry: ProjectAgendaEntry;
  owner?: Member | null;
}) {
  const strings = useStrings();
  const {
    project,
    qualification,
    nextAction,
    nextActionContextAvailability,
    stuck,
  } = entry;
  const hasMeta = stuck || project.contexts.length > 0 || owner;

  return (
    <article className="card project-agenda-card">
      <Link className="project-agenda-link" to={`/projects/${project.id}`}>
        {project.title}
      </Link>
      {hasMeta ? (
        <div className="project-agenda-meta">
          {stuck ? <span className="badge badge-stuck">{strings.stuckReasonLabels[stuck.reason]}</span> : null}
          <TaskCardTags tags={[]} contexts={project.contexts} />
          {owner ? (
            <span
              className="project-agenda-owner"
              aria-label={`${strings.owner}: ${owner.name}`}
              title={owner.name}
            >
              <MemberAvatar member={owner} size="sm" />
            </span>
          ) : null}
        </div>
      ) : null}
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
          {nextActionContextAvailability?.status === "unavailable"
            ? ` · ${strings.contextUnavailableNow}`
            : ""}
        </p>
      ) : null}
      {stuck ? (
        <p className="project-agenda-context">
          <strong>{strings.stuck}:</strong>{" "}
          {strings.stuckRepairLabels[stuck.reason]}
        </p>
      ) : null}
    </article>
  );
}
