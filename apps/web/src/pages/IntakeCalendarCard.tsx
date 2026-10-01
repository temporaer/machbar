import { useState } from "react";
import type { IntakeDraftCalendarEvent, IntakeIssue } from "@machbar/shared";
import { useLocale } from "../lib/locale";
import { useStrings } from "../lib/strings";
import { formatInvalidIntakeValue } from "../lib/intakeDisplay";
import { MarkdownNotes } from "../components/MarkdownNotes";
import type { DateValidityChange } from "./IntakeReviewFields";
import { IntakeCalendarEditSheet } from "./IntakeCalendarEditSheet";

export function IntakeCalendarCard({
  event,
  index,
  issues,
  hasInvalidInput,
  onDateValidityChange,
  onChange,
}: {
  event: IntakeDraftCalendarEvent;
  index: number;
  issues: IntakeIssue[];
  hasInvalidInput: boolean;
  onDateValidityChange: DateValidityChange;
  onChange: (event: IntakeDraftCalendarEvent) => void;
}) {
  const strings = useStrings();
  const { locale } = useLocale();
  const [editing, setEditing] = useState(false);
  const cardIssues = issues.filter(
    (issue) =>
      issue.path[0] === "calendarEvents" && issue.path[1] === index,
  );
  const date = event.allDay
    ? event.startDate
      ? formatDateOnly(event.startDate, locale) ??
        formatInvalidIntakeValue(event.startDate, strings)
      : null
    : event.startDateTime
      ? formatEventDate(event.startDateTime, locale) ??
        formatInvalidIntakeValue(event.startDateTime, strings)
      : null;
  const startTime =
    !event.allDay && event.startDateTime
      ? formatEventTime(event.startDateTime, locale)
      : null;
  const endTime =
    !event.allDay && event.endDateTime
      ? formatEventTime(event.endDateTime, locale) ??
        formatInvalidIntakeValue(event.endDateTime, strings)
      : null;
  const endDate =
    event.allDay && event.endDate
      ? formatDateOnly(event.endDate, locale) ??
        formatInvalidIntakeValue(event.endDate, strings)
      : null;
  const eventWarning =
    !event.allDay && !event.endDateTime ? strings.intakeTimedWarning : null;

  return (
    <>
      <article
        className={[
          "card",
          "intake-proposal-card",
          event.enabled ? "" : "intake-proposal-disabled",
        ]
          .filter(Boolean)
          .join(" ")}
        aria-disabled={!event.enabled}
      >
        <div className="intake-proposal-heading">
          <input
            type="checkbox"
            checked={event.enabled}
            aria-label={`${strings.intakeInclude}: ${event.title}`}
            onChange={(input) =>
              onChange({ ...event, enabled: input.target.checked })
            }
          />
          <h3>{event.title}</h3>
        </div>
        {date || endTime ? (
          <p className="intake-event-time">
            {event.allDay && endDate && event.endDate !== event.startDate
              ? `${date}–${endDate}`
              : date}
            {startTime ? ` · ${startTime}${endTime ? `–${endTime}` : ""}` : ""}
          </p>
        ) : null}
        {event.location?.trim() ? (
          <p className="intake-event-location">{event.location}</p>
        ) : null}
        {event.description?.trim() ? (
          <MarkdownNotes
            value={event.description}
            className="intake-event-description"
          />
        ) : null}
        {event.durationAssumed ? (
          <span className="badge">{strings.intakeAssumedDuration}</span>
        ) : null}
        {eventWarning ? (
          <p className="intake-card-warning" role="status">
            {eventWarning}
          </p>
        ) : null}
        {cardIssues.length ? (
          <div className="intake-card-issues" role="alert">
            {cardIssues.map((issue, issueIndex) => (
              <p key={`${issue.code}-${issueIndex}`}>{issue.message}</p>
            ))}
          </div>
        ) : null}
        {hasInvalidInput ? (
          <p className="intake-card-issues" role="alert">
            {strings.intakeInvalidInput}
          </p>
        ) : null}
        <div className="intake-card-actions">
          <button
            type="button"
            className="btn btn-sm"
            aria-label={`${strings.edit}: ${event.title}`}
            onClick={() => setEditing(true)}
          >
            {strings.edit}
          </button>
        </div>
      </article>
      {editing ? (
        <IntakeCalendarEditSheet
          event={event}
          index={index}
          issues={issues}
          onDateValidityChange={onDateValidityChange}
          onChange={onChange}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </>
  );
}

function formatDateOnly(value: string, locale: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (
    date.getFullYear() !== Number(match[1]) ||
    date.getMonth() !== Number(match[2]) - 1 ||
    date.getDate() !== Number(match[3])
  ) {
    return null;
  }
  return new Intl.DateTimeFormat(locale === "en" ? "en-US" : "de-DE", {
    day: "numeric",
    month: "short",
  }).format(date);
}

function formatEventTime(value: string, locale: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale === "en" ? "en-US" : "de-DE", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatEventDate(value: string, locale: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale === "en" ? "en-US" : "de-DE", {
    day: "numeric",
    month: "short",
  }).format(date);
}
