import { useState } from "react";
import type { IntakeDraftCalendarEvent, IntakeIssue } from "@machbar/shared";
import { useLocale } from "../lib/locale";
import { transitionCalendarAllDay } from "../lib/intakeDraft";
import { useStrings } from "../lib/strings";
import { BottomSheet } from "../components/BottomSheet";
import { MarkdownNotes } from "../components/MarkdownNotes";
import { IntakeIssueText, IntakeLocalDateTimeField, type DateValidityChange } from "./IntakeReviewFields";

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
  const [detailsEditing, setDetailsEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState(event.title);
  const [locationDraft, setLocationDraft] = useState(event.location ?? "");
  const [descriptionDraft, setDescriptionDraft] = useState(
    event.description ?? "",
  );
  const cardIssues = issues.filter(
    (issue) =>
      issue.path[0] === "calendarEvents" && issue.path[1] === index,
  );
  const date = event.allDay
    ? event.startDate
      ? formatDateOnly(event.startDate, locale)
      : null
    : event.startDateTime
      ? formatEventDate(event.startDateTime, locale)
      : null;
  const startTime =
    !event.allDay && event.startDateTime
      ? formatEventTime(event.startDateTime, locale)
      : null;
  const endTime =
    !event.allDay && event.endDateTime
      ? new Intl.DateTimeFormat(locale === "en" ? "en-US" : "de-DE", {
          hour: "2-digit",
          minute: "2-digit",
        }).format(new Date(event.endDateTime))
      : null;
  const eventWarning = !event.allDay && !event.endDateTime
    ? strings.intakeTimedWarning
    : null;
  const openEditor = () => {
    setTitleDraft(event.title);
    setLocationDraft(event.location ?? "");
    setDescriptionDraft(event.description ?? "");
    setDetailsEditing(false);
    setEditing(true);
  };

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
            {event.allDay && event.endDate && event.endDate !== event.startDate
              ? `${date}–${formatDateOnly(event.endDate, locale)}`
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
          <p className="intake-card-warning" role="status">{eventWarning}</p>
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
            className="btn btn-small"
            aria-label={`${strings.edit}: ${event.title}`}
            onClick={openEditor}
          >
            {strings.edit}
          </button>
        </div>
      </article>
      {editing ? (
        <BottomSheet
          title={`${strings.edit}: ${event.title}`}
          onClose={() => setEditing(false)}
        >
          <div className="stack intake-edit-sheet">
            <section className="intake-authored-field">
              <div className="intake-authored-heading">
                <strong>{strings.intakeProposalTitle}</strong>
                {!detailsEditing ? (
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={() => setDetailsEditing(true)}
                  >
                    {strings.edit}
                  </button>
                ) : null}
              </div>
              {detailsEditing ? (
                <>
                  <label>
                    {strings.intakeProposalTitle}
                    <input
                      value={titleDraft}
                      onChange={(input) => setTitleDraft(input.target.value)}
                    />
                  </label>
                  <label>
                    {strings.intakeLocation}
                    <input
                      value={locationDraft}
                      onChange={(input) => setLocationDraft(input.target.value)}
                    />
                  </label>
                  <label>
                    {strings.intakeDescription}
                    <textarea
                      value={descriptionDraft}
                      onChange={(input) =>
                        setDescriptionDraft(input.target.value)
                      }
                    />
                  </label>
                  <div className="row">
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => {
                        onChange({
                          ...event,
                          title: titleDraft,
                          location: locationDraft || null,
                          description: descriptionDraft || null,
                        });
                        setDetailsEditing(false);
                      }}
                    >
                      {strings.save}
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        setTitleDraft(event.title);
                        setLocationDraft(event.location ?? "");
                        setDescriptionDraft(event.description ?? "");
                        setDetailsEditing(false);
                      }}
                    >
                      {strings.cancel}
                    </button>
                  </div>
                </>
              ) : (
                <p>{event.title}</p>
              )}
            </section>
            <label>
              <input
                type="checkbox"
                checked={event.enabled}
                onChange={(input) =>
                  onChange({ ...event, enabled: input.target.checked })
                }
              />{" "}
              {strings.intakeInclude}
            </label>
            <label>
              <input
                type="checkbox"
                checked={event.allDay}
                onChange={(input) =>
                  onChange(transitionCalendarAllDay(event, input.target.checked))
                }
              />{" "}
              {strings.intakeAllDay}
            </label>
            {event.allDay ? (
              <>
                <label>
                  {strings.intakeStartDate}
                  <input
                    type="date"
                    aria-label={strings.intakeStartDate}
                    value={event.startDate ?? ""}
                    onChange={(input) =>
                      onChange({
                        ...event,
                        startDate: input.target.value || null,
                      })
                    }
                  />
                </label>
                <label>
                  {strings.intakeEndDate}
                  <input
                    type="date"
                    aria-label={strings.intakeEndDate}
                    value={event.endDate ?? ""}
                    onChange={(input) =>
                      onChange({
                        ...event,
                        endDate: input.target.value || null,
                      })
                    }
                  />
                </label>
              </>
            ) : (
              <>
                <IntakeLocalDateTimeField
                  key={`${event.key}-start`}
                  id={`intake-event-${event.key}-start`}
                  fieldKey={`calendar:${event.key}:start`}
                  onDateValidityChange={onDateValidityChange}
                  label={strings.intakeStartDate}
                  value={event.startDateTime}
                  onChange={(startDateTime) =>
                    onChange({ ...event, startDateTime })
                  }
                />
                <IntakeIssueText
                  issues={issues}
                  path={["calendarEvents", index, "startDateTime"]}
                />
                <IntakeLocalDateTimeField
                  key={`${event.key}-end`}
                  id={`intake-event-${event.key}-end`}
                  fieldKey={`calendar:${event.key}:end`}
                  onDateValidityChange={onDateValidityChange}
                  label={strings.intakeEndDate}
                  value={event.endDateTime}
                  onChange={(endDateTime) =>
                    onChange({
                      ...event,
                      endDateTime,
                      durationAssumed: false,
                    })
                  }
                />
                <IntakeIssueText
                  issues={issues}
                  path={["calendarEvents", index, "endDateTime"]}
                />
              </>
            )}
            <IntakeIssueText
              issues={issues}
              path={["calendarEvents", index]}
            />
            {event.durationAssumed ? (
              <span className="badge">{strings.intakeAssumedDuration}</span>
            ) : null}
            {!event.allDay && !event.endDateTime ? (
              <small className="text-muted">{strings.intakeTimedWarning}</small>
            ) : null}
          </div>
        </BottomSheet>
      ) : null}
    </>
  );
}

function formatDateOnly(value: string, locale: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
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
