import { useState } from "react";
import type { IntakeDraftWorkItem, IntakeIssue, Member } from "@machbar/shared";
import { useLocale } from "../lib/locale";
import { formatExactLocalDate } from "../lib/relativeDate";
import { taskAvailabilityClock } from "../lib/taskAvailability";
import { useStrings } from "../lib/strings";
import { DetailPropertyPill } from "../components/DetailPropertyPill";
import { MarkdownNotes } from "../components/MarkdownNotes";
import { MemberLabel } from "../components/MemberAvatar";
import type { DateValidityChange } from "./IntakeReviewFields";
import { IntakeWorkItemContentEditor } from "./IntakeWorkItemContentEditor";
import {
  IntakeAvailabilityEditor,
  IntakeDueDateEditor,
  IntakeOwnerEditor,
  IntakePlanningEditor,
  IntakeReminderEditor,
} from "./IntakeWorkItemPropertyEditors";

type Editor = "content" | "owner" | "due" | "scheduled" | "availability" | "reminder";

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
  const [editor, setEditor] = useState<Editor | null>(null);
  const closeEditor = () => setEditor(null);
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
  const due = item.dueDate ? formatExactLocalDate(item.dueDate, locale) : null;
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
  const availabilityTime =
    item.notBeforeAt && taskAvailabilityClock(item.notBeforeAt) !== "00:00"
      ? taskAvailabilityClock(item.notBeforeAt)
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
          {item.kind !== "reference" && owner ? (
            <DetailPropertyPill
              ariaLabel={`${strings.owner}: ${owner.name}`}
              onClick={() => setEditor("owner")}
            >
              <MemberLabel member={owner} />
            </DetailPropertyPill>
          ) : null}
          {item.kind !== "reference" && due ? (
            <DetailPropertyPill
              label={strings.due}
              ariaLabel={`${strings.due}: ${due}`}
              onClick={() => setEditor("due")}
            >
              {due}
            </DetailPropertyPill>
          ) : null}
          {item.kind === "action" && scheduled ? (
            <DetailPropertyPill
              label={strings.scheduled}
              ariaLabel={`${strings.scheduled}: ${scheduled}`}
              onClick={() => setEditor("scheduled")}
            >
              {scheduled}
            </DetailPropertyPill>
          ) : null}
          {item.kind === "action" && notBefore ? (
            <DetailPropertyPill
              label={strings.notBefore}
              ariaLabel={`${strings.notBefore}: ${notBefore}`}
              onClick={() => setEditor("availability")}
            >
              {notBefore}{availabilityTime ? ` · ${availabilityTime}` : ""}
            </DetailPropertyPill>
          ) : null}
          {item.kind === "action" && reminder ? (
            <DetailPropertyPill
              label={strings.reminder}
              ariaLabel={`${strings.reminder}: ${reminder}`}
              onClick={() => setEditor("reminder")}
            >
              {reminder}
            </DetailPropertyPill>
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
              onClick={() => setEditor("owner")}
            >
              + {strings.owner}
            </DetailPropertyPill>
          ) : null}
          {item.kind !== "reference" && !item.dueDate ? (
            <DetailPropertyPill
              variant="unset"
              ariaLabel={`+ ${strings.due}`}
              onClick={() => setEditor("due")}
            >
              + {strings.due}
            </DetailPropertyPill>
          ) : null}
          {item.kind === "action" && !item.scheduledDate ? (
            <DetailPropertyPill
              variant="unset"
              ariaLabel={`+ ${strings.scheduled}`}
              onClick={() => setEditor("scheduled")}
            >
              + {strings.scheduled}
            </DetailPropertyPill>
          ) : null}
          {item.kind === "action" && !item.notBeforeDate ? (
            <DetailPropertyPill
              variant="unset"
              ariaLabel={`+ ${strings.notBefore}`}
              onClick={() => setEditor("availability")}
            >
              + {strings.notBefore}
            </DetailPropertyPill>
          ) : null}
          {item.kind === "action" && !item.reminderAt ? (
            <DetailPropertyPill
              variant="unset"
              ariaLabel={`+ ${strings.reminder}`}
              onClick={() => setEditor("reminder")}
            >
              + {strings.reminder}
            </DetailPropertyPill>
          ) : null}
          <button
            type="button"
            className="btn btn-sm"
            aria-label={`${strings.edit}: ${item.title}`}
            onClick={() => setEditor("content")}
          >
            {strings.edit}
          </button>
        </div>
      </article>
      {editor === "content" ? (
        <IntakeWorkItemContentEditor
          item={item}
          index={index}
          issues={issues}
          onChange={onChange}
          onKindChange={onKindChange}
          onClose={closeEditor}
        />
      ) : null}
      {editor === "owner" ? (
        <IntakeOwnerEditor
          item={item}
          index={index}
          members={members}
          issues={issues}
          onDateValidityChange={onDateValidityChange}
          onChange={onChange}
          onClose={closeEditor}
        />
      ) : null}
      {editor === "due" ? (
        <IntakeDueDateEditor
          item={item}
          index={index}
          issues={issues}
          onDateValidityChange={onDateValidityChange}
          onChange={onChange}
          onClose={closeEditor}
        />
      ) : null}
      {editor === "scheduled" ? (
        <IntakePlanningEditor
          item={item}
          index={index}
          issues={issues}
          onDateValidityChange={onDateValidityChange}
          onChange={onChange}
          onClose={closeEditor}
        />
      ) : null}
      {editor === "availability" ? (
        <IntakeAvailabilityEditor
          item={item}
          index={index}
          issues={issues}
          onDateValidityChange={onDateValidityChange}
          onChange={onChange}
          onClose={closeEditor}
        />
      ) : null}
      {editor === "reminder" ? (
        <IntakeReminderEditor
          item={item}
          index={index}
          issues={issues}
          onDateValidityChange={onDateValidityChange}
          onChange={onChange}
          onClose={closeEditor}
        />
      ) : null}
    </>
  );
}
