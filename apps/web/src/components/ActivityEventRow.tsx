import type { ActivityEvent } from "@machbar/shared";
import { Link } from "react-router-dom";
import {
  formatActivityDescription,
  formatActivityExactTime,
  formatActivityRelativeTime,
} from "../lib/activityFormatting";
import { MemberAvatar } from "./MemberAvatar";
import { useLocale } from "../lib/locale";

export function ActivityEventRow({
  event,
  now,
}: {
  event: ActivityEvent;
  now?: Date;
}) {
  const { locale, strings } = useLocale();
  const actorName = event.actor?.name || strings.activityText.unknownActor;
  const entityPath =
    event.entity.type === "task" && event.entity.taskId !== null
      ? `/tasks/${event.entity.taskId}`
      : event.entity.type === "project" && event.entity.projectId !== null
        ? `/projects/${event.entity.projectId}`
        : null;
  const exactTime = formatActivityExactTime(event.createdAt, locale);
  const relativeTime = formatActivityRelativeTime(
    event.createdAt,
    now,
    locale,
  );

  return (
    <li className="activity-event-row">
      {event.actor ? (
        <MemberAvatar
          member={event.actor}
          size="md"
          className="activity-event-avatar"
        />
      ) : (
        <span className="avatar avatar-md activity-event-avatar" aria-hidden="true">
          ?
        </span>
      )}
      <div className="activity-event-content">
        <div className="activity-event-heading">
          <strong>{actorName}</strong>{" "}
          <span>{formatActivityDescription(event, locale)}</span>
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
