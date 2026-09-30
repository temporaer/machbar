import { useState } from "react";
import type { IntakeDraftCalendarEvent, IntakeIssue } from "@machbar/shared";
import { transitionCalendarAllDay } from "../lib/intakeDraft";
import { useStrings } from "../lib/strings";
import { BottomSheet } from "../components/BottomSheet";
import {
  IntakeIssueText,
  IntakeLocalDateTimeField,
  type DateValidityChange,
} from "./IntakeReviewFields";

export function IntakeCalendarEditSheet({
  event,
  index,
  issues,
  onDateValidityChange,
  onChange,
  onClose,
}: {
  event: IntakeDraftCalendarEvent;
  index: number;
  issues: IntakeIssue[];
  onDateValidityChange: DateValidityChange;
  onChange: (event: IntakeDraftCalendarEvent) => void;
  onClose: () => void;
}) {
  const strings = useStrings();
  const [titleDraft, setTitleDraft] = useState(event.title);
  const [locationDraft, setLocationDraft] = useState(event.location ?? "");
  const [descriptionDraft, setDescriptionDraft] = useState(
    event.description ?? "",
  );
  const startKey = `calendar:${event.key}:start`;
  const endKey = `calendar:${event.key}:end`;
  const close = () => {
    onDateValidityChange(startKey, true);
    onDateValidityChange(endKey, true);
    onClose();
  };

  return (
    <BottomSheet
      title={`${strings.edit}: ${event.title}`}
      onClose={close}
    >
      <div className="stack intake-edit-sheet">
        <section className="intake-authored-field">
          <strong>{strings.intakeProposalTitle}</strong>
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
          <div className="field">
            <label className="field-label" htmlFor={`intake-event-${event.key}-description`}>
              {strings.intakeDescription}
            </label>
            <textarea
              id={`intake-event-${event.key}-description`}
              value={descriptionDraft}
              onChange={(input) => setDescriptionDraft(input.target.value)}
            />
          </div>
          <div className="row">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() =>
                onChange({
                  ...event,
                  title: titleDraft,
                  location: locationDraft || null,
                  description: descriptionDraft || null,
                })
              }
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
              }}
            >
              {strings.cancel}
            </button>
          </div>
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
              fieldKey={startKey}
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
              fieldKey={endKey}
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
  );
}
