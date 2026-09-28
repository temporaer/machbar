import { useState } from "react";
import type { IntakeDraftWorkItem, IntakeIssue, Member } from "@machbar/shared";
import { useLocale } from "../lib/locale";
import { formatExactLocalDate } from "../lib/relativeDate";
import { taskAvailabilityClock, taskAvailabilityForLocalDate } from "../lib/taskAvailability";
import { useStrings } from "../lib/strings";
import { BottomSheet } from "../components/BottomSheet";
import { DetailPropertyPill } from "../components/DetailPropertyPill";
import { HumanDateInput } from "../components/HumanDateInput";
import { MarkdownEditor } from "../components/MarkdownEditor";
import { MarkdownNotes } from "../components/MarkdownNotes";
import { MemberChoiceGroup } from "../components/MemberChoiceGroup";
import { MemberLabel } from "../components/MemberAvatar";
import { ScheduleShortcuts } from "../components/ScheduleShortcuts";
import {
  IntakeIssueText,
  IntakeLocalDateTimeField,
  type DateValidityChange,
  useDateValidityCallback,
} from "./IntakeReviewFields";

export function IntakeWorkItemCard({
  item,
  index,
  depth,
  parentTitle,
  members,
  issues,
  hasInvalidInput,
  onDateValidityChange,
  onChange,
  onKindChange,
}: {
  item: IntakeDraftWorkItem;
  index: number;
  depth: number;
  parentTitle: string | null;
  members: Member[];
  issues: IntakeIssue[];
  hasInvalidInput: boolean;
  onDateValidityChange: DateValidityChange;
  onChange: (item: IntakeDraftWorkItem) => void;
  onKindChange: (kind: IntakeDraftWorkItem["kind"]) => void;
}) {
  const strings = useStrings();
  const { locale } = useLocale();
  const [editing, setEditing] = useState(false);
  const owner = members.find((member) => member.id === item.ownerMemberId);
  const kindLabel =
    item.kind === "project"
      ? strings.project
      : item.kind === "reference"
        ? strings.materialLabel
        : strings.task;
  const cardIssues = issues.filter(
    (issue) =>
      issue.path[0] === "workItems" && issue.path[1] === index,
  );
  const due = item.dueDate
    ? formatExactLocalDate(item.dueDate, locale)
    : null;
  const scheduled = item.scheduledDate
    ? formatExactLocalDate(item.scheduledDate, locale)
    : null;
  const notBefore = item.notBeforeDate
    ? formatExactLocalDate(item.notBeforeDate, locale)
    : null;
  const reminder = item.reminderAt
    ? new Intl.DateTimeFormat(locale === "en" ? "en-US" : "de-DE", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(item.reminderAt))
    : null;

  return (
    <>
      <article
        className={[
          "card",
          "intake-proposal-card",
          depth > 0 ? "intake-proposal-nested" : "",
          item.enabled ? "" : "intake-proposal-disabled",
        ]
          .filter(Boolean)
          .join(" ")}
        aria-disabled={!item.enabled}
      >
        <div className="intake-proposal-heading">
          <input
            type="checkbox"
            checked={item.enabled}
            aria-label={`${strings.intakeInclude}: ${item.title}`}
            onChange={(event) =>
              onChange({ ...item, enabled: event.target.checked })
            }
          />
          <h3>{item.title}</h3>
        </div>
        <div className="detail-meta-row intake-proposal-meta">
          <span className="detail-meta-static">{kindLabel}</span>
          {owner ? (
            <span className="detail-meta-static">
              <MemberLabel member={owner} />
            </span>
          ) : null}
          {due ? (
            <span className="detail-meta-static">
              {strings.due} {due}
            </span>
          ) : null}
          {scheduled ? (
            <span className="detail-meta-static">
              {strings.scheduled} {scheduled}
            </span>
          ) : null}
          {notBefore ? (
            <span className="detail-meta-static">
              {strings.notBefore} {notBefore}
              {item.notBeforeAt && taskAvailabilityClock(item.notBeforeAt) !== "00:00"
                ? ` · ${taskAvailabilityClock(item.notBeforeAt)}`
                : ""}
            </span>
          ) : null}
          {reminder ? (
            <span className="detail-meta-static">
              {strings.reminder} {reminder}
            </span>
          ) : null}
        </div>
        {depth > 0 && parentTitle ? (
          <p className="intake-parent-context">
            {strings.intakeChildOf(parentTitle)}
          </p>
        ) : null}
        {item.notes?.trim() ? (
          <MarkdownNotes
            value={item.notes}
            className="intake-proposal-notes"
          />
        ) : null}
        {item.needsClarification ? (
          <span className="badge">{strings.intakeNeedsClarification}</span>
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
          {item.kind !== "reference" && !item.ownerMemberId ? (
            <DetailPropertyPill
              variant="unset"
              ariaLabel={`+ ${strings.owner}`}
              onClick={() => setEditing(true)}
            >
              + {strings.owner}
            </DetailPropertyPill>
          ) : null}
          {item.kind !== "reference" && !item.dueDate ? (
            <DetailPropertyPill
              variant="unset"
              ariaLabel={`+ ${strings.due}`}
              onClick={() => setEditing(true)}
            >
              + {strings.due}
            </DetailPropertyPill>
          ) : null}
          {item.kind === "action" && !item.scheduledDate ? (
            <DetailPropertyPill
              variant="unset"
              ariaLabel={`+ ${strings.scheduled}`}
              onClick={() => setEditing(true)}
            >
              + {strings.scheduled}
            </DetailPropertyPill>
          ) : null}
          {item.kind === "action" && !item.notBeforeDate ? (
            <DetailPropertyPill
              variant="unset"
              ariaLabel={`+ ${strings.notBefore}`}
              onClick={() => setEditing(true)}
            >
              + {strings.notBefore}
            </DetailPropertyPill>
          ) : null}
          {item.kind === "action" && !item.reminderAt ? (
            <DetailPropertyPill
              variant="unset"
              ariaLabel={`+ ${strings.reminder}`}
              onClick={() => setEditing(true)}
            >
              + {strings.reminder}
            </DetailPropertyPill>
          ) : null}
          <button
            type="button"
            className="btn btn-small"
            aria-label={`${strings.edit}: ${item.title}`}
            onClick={() => setEditing(true)}
          >
            {strings.edit}
          </button>
        </div>
      </article>
      {editing ? (
        <IntakeWorkItemEditSheet
          item={item}
          index={index}
          members={members}
          issues={issues}
          onDateValidityChange={onDateValidityChange}
          onChange={onChange}
          onKindChange={onKindChange}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </>
  );
}

function IntakeWorkItemEditSheet({
  item,
  index,
  members,
  issues,
  onDateValidityChange,
  onChange,
  onKindChange,
  onClose,
}: {
  item: IntakeDraftWorkItem;
  index: number;
  members: Member[];
  issues: IntakeIssue[];
  onDateValidityChange: DateValidityChange;
  onChange: (item: IntakeDraftWorkItem) => void;
  onKindChange: (kind: IntakeDraftWorkItem["kind"]) => void;
  onClose: () => void;
}) {
  const strings = useStrings();
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState(item.title);
  const [notesEditing, setNotesEditing] = useState(false);
  const [notesDraft, setNotesDraft] = useState(item.notes ?? "");
  const path = ["workItems", index];
  const dueValidity = useDateValidityCallback(
    `work:${item.key}:due`,
    onDateValidityChange,
  );
  const scheduledValidity = useDateValidityCallback(
    `work:${item.key}:scheduled`,
    onDateValidityChange,
  );
  const availabilityValidity = useDateValidityCallback(
    `work:${item.key}:availability`,
    onDateValidityChange,
  );
  const currentClock = taskAvailabilityClock(item.notBeforeAt);
  const hasTime = currentClock !== null && currentClock !== "00:00";
  const updateAvailability = (date: string, time: string | null) => {
    if (!date) {
      onChange({ ...item, notBeforeDate: null, notBeforeAt: null });
      return;
    }
    const availability = taskAvailabilityForLocalDate(date, time);
    if (availability) onChange({ ...item, ...availability });
  };

  return (
    <BottomSheet
      title={`${strings.edit}: ${item.title}`}
      onClose={onClose}
    >
      <div className="stack intake-edit-sheet">
        <section className="intake-authored-field">
          <div className="intake-authored-heading">
            <strong>{strings.intakeProposalTitle}</strong>
            {!titleEditing ? (
              <button
                type="button"
                className="btn btn-small"
                onClick={() => {
                  setTitleDraft(item.title);
                  setTitleEditing(true);
                }}
              >
                {strings.edit}
              </button>
            ) : null}
          </div>
          {titleEditing ? (
            <>
              <input
                aria-label={strings.intakeProposalTitle}
                value={titleDraft}
                onChange={(event) => setTitleDraft(event.target.value)}
              />
              <div className="row">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    onChange({ ...item, title: titleDraft });
                    setTitleEditing(false);
                  }}
                >
                  {strings.save}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setTitleDraft(item.title);
                    setTitleEditing(false);
                  }}
                >
                  {strings.cancel}
                </button>
              </div>
            </>
          ) : (
            <p>{item.title}</p>
          )}
        </section>

        <label className="field">
          <span className="field-label">{strings.intakeType}</span>
          <select
            value={item.kind}
            onChange={(event) =>
              onKindChange(
                event.target.value as IntakeDraftWorkItem["kind"],
              )
            }
          >
            <option value="action">{strings.task}</option>
            <option value="project">{strings.project}</option>
            <option value="reference">{strings.materialLabel}</option>
          </select>
        </label>

        {item.kind !== "reference" ? (
          <div className="field">
            <MemberChoiceGroup
              label={strings.owner}
              idPrefix={`intake-work-${item.key}-owner`}
              members={members}
              value={item.ownerMemberId}
              unassignedLabel={strings.sharedOwner}
              onChange={(ownerMemberId) =>
                onChange({ ...item, ownerMemberId })
              }
            />
            <IntakeIssueText
              issues={issues}
              path={[...path, "ownerMemberId"]}
            />
          </div>
        ) : null}

        <section className="intake-authored-field">
          <div className="intake-authored-heading">
            <strong>{strings.notes}</strong>
            {!notesEditing ? (
              <button
                type="button"
                className="btn btn-small"
                onClick={() => {
                  setNotesDraft(item.notes ?? "");
                  setNotesEditing(true);
                }}
              >
                {strings.edit}
              </button>
            ) : null}
          </div>
          {notesEditing ? (
            <>
              <MarkdownEditor
                aria-label={strings.notes}
                value={notesDraft}
                onChange={setNotesDraft}
              />
              <div className="row">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    onChange({ ...item, notes: notesDraft || null });
                    setNotesEditing(false);
                  }}
                >
                  {strings.save}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setNotesDraft(item.notes ?? "");
                    setNotesEditing(false);
                  }}
                >
                  {strings.cancel}
                </button>
              </div>
            </>
          ) : item.notes?.trim() ? (
            <MarkdownNotes value={item.notes} />
          ) : (
            <p className="text-muted">{strings.intakeNoNotes}</p>
          )}
        </section>

        {item.kind !== "reference" ? (
          <div className="field">
            <label className="field-label" htmlFor={`intake-work-${item.key}-due`}>
              {strings.due}
            </label>
            <HumanDateInput
              id={`intake-work-${item.key}-due`}
              value={item.dueDate}
              onValidityChange={dueValidity}
              onChange={(dueDate) => onChange({ ...item, dueDate })}
            />
            <IntakeIssueText
              issues={issues}
              path={[...path, "dueDate"]}
            />
          </div>
        ) : null}

        {item.kind === "action" ? (
          <>
            <div className="field">
              <label
                className="field-label"
                htmlFor={`intake-work-${item.key}-scheduled`}
              >
                {strings.scheduled}
              </label>
              <HumanDateInput
                id={`intake-work-${item.key}-scheduled`}
                value={item.scheduledDate}
                onValidityChange={scheduledValidity}
                onChange={(scheduledDate) =>
                  onChange({ ...item, scheduledDate })
                }
              />
              <ScheduleShortcuts
                value={item.scheduledDate}
                onChange={(scheduledDate) =>
                  onChange({ ...item, scheduledDate })
                }
              />
              <IntakeIssueText
                issues={issues}
                path={[...path, "scheduledDate"]}
              />
            </div>

            <div className="field">
              <label
                className="field-label"
                htmlFor={`intake-work-${item.key}-availability`}
              >
                {strings.notBefore}
              </label>
              <HumanDateInput
                id={`intake-work-${item.key}-availability`}
                value={item.notBeforeDate}
                onValidityChange={availabilityValidity}
                onChange={(date) =>
                  updateAvailability(
                    date ?? "",
                    hasTime ? currentClock : null,
                  )
                }
              />
              <label>
                <input
                  type="checkbox"
                  checked={hasTime}
                  disabled={!item.notBeforeDate}
                  onChange={(event) =>
                    updateAvailability(
                      item.notBeforeDate ?? "",
                      event.target.checked
                        ? currentClock && currentClock !== "00:00"
                          ? currentClock
                          : "08:00"
                        : null,
                    )
                  }
                />{" "}
                {strings.availabilityCustomTime}
              </label>
              {hasTime ? (
                <label>
                  {strings.availabilityCustomTime}
                  <input
                    type="time"
                    value={currentClock ?? ""}
                    onChange={(event) =>
                      updateAvailability(
                        item.notBeforeDate ?? "",
                        event.target.value || null,
                      )
                    }
                  />
                </label>
              ) : null}
              <IntakeIssueText issues={issues} path={path} />
            </div>

            <div className="field">
              <IntakeLocalDateTimeField
                id={`intake-work-${item.key}-reminder`}
                fieldKey={`work:${item.key}:reminder-date`}
                onDateValidityChange={onDateValidityChange}
                label={strings.reminder}
                value={item.reminderAt}
                onChange={(reminderAt) =>
                  onChange({ ...item, reminderAt })
                }
              />
              <IntakeIssueText
                issues={issues}
                path={[...path, "reminderAt"]}
              />
            </div>

            <label>
              <input
                type="checkbox"
                checked={item.needsClarification}
                onChange={(event) =>
                  onChange({
                    ...item,
                    needsClarification: event.target.checked,
                    reminderAt: event.target.checked
                      ? null
                      : item.reminderAt,
                  })
                }
              />{" "}
              {strings.intakeNeedsClarification}
            </label>
          </>
        ) : null}
        <IntakeIssueText issues={issues} path={path} />
      </div>
    </BottomSheet>
  );
}
