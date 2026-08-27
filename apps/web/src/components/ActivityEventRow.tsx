import type { ActivityEvent } from "@machbar/shared";
import { Link } from "react-router-dom";
import {
  formatActivityDescription,
  formatActivityExactTime,
  formatActivityRelativeTime,
} from "../lib/activityFormatting";
import { fallbackColor, initials } from "../lib/format";

export function ActivityEventRow({
  event,
  now,
}: {
  event: ActivityEvent;
  now?: Date;
}) {
  const actorName = event.actor?.name || "Unbekannt";
  const entityPath =
    event.entity.type === "task" && event.entity.taskId !== null
      ? `/aufgaben/${event.entity.taskId}`
      : event.entity.type === "project" && event.entity.projectId !== null
        ? `/projekte/${event.entity.projectId}`
        : null;
  const exactTime = formatActivityExactTime(event.createdAt);
  const relativeTime = formatActivityRelativeTime(event.createdAt, now);

  return (
    <li className="activity-event-row">
      <span
        className="avatar activity-event-avatar"
        style={{
          background: event.actor?.color || fallbackColor(event.actor?.id ?? 0),
        }}
        aria-hidden="true"
      >
        {event.actor ? initials(actorName) : "?"}
      </span>
      <div className="activity-event-content">
        <div className="activity-event-heading">
          <strong>{actorName}</strong>{" "}
          <span>{formatActivityDescription(event)}</span>
        </div>
        <div className="activity-event-meta">
          {entityPath ? (
            <Link to={entityPath} className="activity-entity-link">
              {event.entity.title}
            </Link>
          ) : (
            <span className="activity-entity-deleted">{event.entity.title}</span>
          )}
          <span aria-hidden="true">·</span>
          <time
            dateTime={event.createdAt}
            title={exactTime}
            aria-label={`${relativeTime}; ${exactTime}`}
          >
            {relativeTime}
          </time>
        </div>
      </div>
    </li>
  );
}
