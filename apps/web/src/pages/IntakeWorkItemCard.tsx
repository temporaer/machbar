import { useState } from "react";
import type { IntakeDraftWorkItem, IntakeIssue, Member } from "@machbar/shared";
import { useLocale } from "../lib/locale";
import { formatExactLocalDate } from "../lib/relativeDate";
import { taskAvailabilityClock } from "../lib/taskAvailability";
import { formatReminderLabel } from "../lib/reminderLabels";
import { formatInvalidIntakeValue } from "../lib/intakeDisplay";
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
  reminderRowIds,
  createReminderRowId,
  onDateValidityChange,
  onChange,
  onReminderChange,
  onKindChange,
}: {
  item: IntakeDraftWorkItem;
  index: number;
  depth: number;
  parentTitle: string | null;
  members: Member[];
  issues: IntakeIssue[];
  hasInvalidInput: boolean;
  reminderRowIds: readonly string[];
  createReminderRowId: () => string;
  onDateValidityChange: DateValidityChange;
  onChange: (item: IntakeDraftWorkItem) => void;
  onReminderChange: (
    item: IntakeDraftWorkItem,
    reminderRowIds: readonly string[],
  ) => void;
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
  const due = item.dueDate
    ? formatExactLocalDate(item.dueDate, locale) ??
      formatInvalidIntakeValue(item.dueDate, strings)
    : null;
  const scheduled = item.scheduledDate
    ? formatExactLocalDate(item.scheduledDate, locale) ??
      formatInvalidIntakeValue(item.scheduledDate, strings)
    : null;
  const notBefore = item.notBeforeDate
    ? formatExactLocalDate(item.notBeforeDate, locale) ??
      formatInvalidIntakeValue(item.notBeforeDate, strings)
    : null;
  const reminders = item.reminders.map((reminder) =>
    formatReminderLabel(reminder, item.dueDate, strings, locale));
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
          {item.kind !== "reference" && item.dueDate !== null ? (
            <DetailPropertyPill
              label={strings.due}
              ariaLabel={`${strings.due}: ${due}`}
              onClick={() => setEditor("due")}
            >
              {due}
            </DetailPropertyPill>
          ) : null}
          {item.kind !== "reference" && item.scheduledDate !== null ? (
            <DetailPropertyPill
              label={strings.scheduled}
              ariaLabel={`${strings.scheduled}: ${scheduled}`}
              onClick={() => setEditor("scheduled")}
            >
              {scheduled}
            </DetailPropertyPill>
          ) : null}
          {item.kind === "action" && item.notBeforeDate !== null ? (
            <DetailPropertyPill
              label={strings.notBefore}
              ariaLabel={`${strings.notBefore}: ${notBefore}`}
              onClick={() => setEditor("availability")}
            >
              {notBefore}{availabilityTime ? ` · ${availabilityTime}` : ""}
            </DetailPropertyPill>
          ) : null}
          {item.kind === "action" && reminders.length ? (
            <DetailPropertyPill
              label={strings.reminder}
              ariaLabel={`${strings.reminder}: ${reminders.join(", ")}`}
              onClick={() => setEditor("reminder")}
            >
              {reminders.join(", ")}
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
          {item.kind !== "reference" && item.dueDate === null ? (
            <DetailPropertyPill
              variant="unset"
              ariaLabel={`+ ${strings.due}`}
              onClick={() => setEditor("due")}
            >
              + {strings.due}
            </DetailPropertyPill>
          ) : null}
          {item.kind !== "reference" && item.scheduledDate === null ? (
            <DetailPropertyPill
              variant="unset"
              ariaLabel={`+ ${strings.scheduled}`}
              onClick={() => setEditor("scheduled")}
            >
              + {strings.scheduled}
            </DetailPropertyPill>
          ) : null}
          {item.kind === "action" && item.notBeforeDate === null ? (
            <DetailPropertyPill
              variant="unset"
              ariaLabel={`+ ${strings.notBefore}`}
              onClick={() => setEditor("availability")}
            >
              + {strings.notBefore}
            </DetailPropertyPill>
          ) : null}
          {item.kind === "action" && !item.reminders.length ? (
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
          reminderRowIds={reminderRowIds}
          createReminderRowId={createReminderRowId}
          onDateValidityChange={onDateValidityChange}
          onChange={onChange}
          onReminderChange={onReminderChange}
          onClose={closeEditor}
        />
      ) : null}
    </>
  );
}
