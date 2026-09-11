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
import { IconActionGlyph } from "./IconActionButton";

/**
 * Compact single-line Today attention row for a project, replacing the
 * taller `ProjectAgendaCard`. It communicates project-level attention only
 * (why this project needs a look + the one relevant date) — the project's
 * Next Action is never shown here, since it already appears as its own Task
 * row in Today when it qualifies for a bucket today; repeating it here
 * would duplicate the same information in a second place. The only
 * exception to the single line is a stuck project, which gets one
 * additional compact line explaining what needs a human decision.
 */
export function ProjectAgendaRow({
  entry,
  owner = null,
}: {
  entry: ProjectAgendaEntry;
  owner?: Member | null;
}) {
  const strings = useStrings();
  const { locale } = useLocale();
  const { project, attentionBucket, stuck } = entry;
  const now = new Date();
  const scheduled = attentionBucket === "planned";
  const date = scheduled ? project.scheduledDate : project.dueDate;
  const label = scheduled ? strings.projectRevisitDate : strings.due;
  const relative = date
    ? scheduled
      ? formatRelativeScheduleDate(date, now, locale)
      : formatRelativeDueDate(date, now, locale)
    : null;
  const exact = date ? formatExactLocalDate(date, locale) : null;
  const accessibleDate =
    relative && exact ? `${label}: ${relative} (${exact})` : null;

  return (
    <div className="project-agenda-row">
      <span className="project-agenda-row-icon" aria-hidden="true">
        <IconActionGlyph kind="project" />
      </span>
      <Link className="project-agenda-row-link" to={`/projects/${project.id}`}>
        {project.title}
      </Link>
      {accessibleDate ? (
        <span
          className="project-agenda-row-date"
          title={accessibleDate}
          aria-label={accessibleDate}
        >
          {relative}
        </span>
      ) : null}
      {owner ? (
        <span
          className="project-agenda-row-owner"
          aria-label={`${strings.owner}: ${owner.name}`}
          title={owner.name}
        >
          <MemberAvatar member={owner} size="sm" />
        </span>
      ) : null}
      {stuck ? (
        <p className="project-agenda-row-stuck">
          <span className="badge badge-stuck">
            {strings.stuckReasonLabels[stuck.reason]}
          </span>{" "}
          {strings.stuckRepairLabels[stuck.reason]}
        </p>
      ) : null}
    </div>
  );
}
