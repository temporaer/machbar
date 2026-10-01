import type {
  IntakeDraft,
  IntakeDraftWorkItem,
  IntakeIssue,
  Member,
} from "@machbar/shared";
import { transitionWorkItemKind, workItemDepths } from "../lib/intakeDraft";
import { useStrings } from "../lib/strings";
import { IntakeCalendarCard } from "./IntakeCalendarCard";
import { IntakeIssueText, type DateValidityChange } from "./IntakeReviewFields";
import { IntakeWorkItemCard } from "./IntakeWorkItemCard";

export function IntakeProposalReview({
  draft,
  members,
  issues,
  invalidDateKeys,
  reminderRowIds,
  createReminderRowId,
  onDateValidityChange,
  onChange,
  onReminderChange,
}: {
  draft: IntakeDraft;
  members: Member[];
  issues: IntakeIssue[];
  invalidDateKeys: ReadonlySet<string>;
  reminderRowIds: ReadonlyMap<string, readonly string[]>;
  createReminderRowId: () => string;
  onDateValidityChange: DateValidityChange;
  onChange: (draft: IntakeDraft) => void;
  onReminderChange: (
    item: IntakeDraftWorkItem,
    reminderRowIds: readonly string[],
  ) => void;
}) {
  const strings = useStrings();
  const workItemDepth = workItemDepths(draft.workItems);
  const globalIssues = issues.filter(
    (issue) =>
      !(
        (issue.path[0] === "workItems" ||
          issue.path[0] === "calendarEvents") &&
        typeof issue.path[1] === "number"
      ),
  );

  const hasInvalidCalendarInput = (key: string) =>
    invalidDateKeys.has(`calendar:${key}:start`) ||
    invalidDateKeys.has(`calendar:${key}:end`);
  const hasInvalidWorkInput = (item: IntakeDraftWorkItem) =>
    invalidDateKeys.has(`work:${item.key}:due`) ||
    invalidDateKeys.has(`work:${item.key}:scheduled`) ||
    invalidDateKeys.has(`work:${item.key}:availability`) ||
    [...invalidDateKeys].some((key) =>
      key.startsWith(`work:${item.key}:reminder-date`));

  return (
    <>
      <header className="intake-review-header">
        <h1>{strings.intakeReady}</h1>
        {draft.summary.trim() ? (
          <p className="intake-review-summary">{draft.summary}</p>
        ) : null}
      </header>
      {draft.warnings.length ? (
        <section className="intake-global-warnings" role="status">
          <h2>{strings.intakeWarnings}</h2>
          <ul>
            {draft.warnings.map((warning, index) => (
              <li key={index}>{warning.message}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {draft.calendarEvents.length > 0 ? (
        <section className="stack intake-proposal-section">
          <h2>{strings.intakeCalendar}</h2>
          {draft.calendarEvents.map((event, index) => (
            <IntakeCalendarCard
              key={event.key}
              event={event}
              index={index}
              issues={issues}
              hasInvalidInput={hasInvalidCalendarInput(event.key)}
              onDateValidityChange={onDateValidityChange}
              onChange={(next) =>
                onChange({
                  ...draft,
                  calendarEvents: draft.calendarEvents.map(
                    (current, currentIndex) =>
                      currentIndex === index ? next : current,
                  ),
                })
              }
            />
          ))}
        </section>
      ) : null}
      {draft.workItems.length > 0 ? (
        <section className="stack intake-proposal-section">
          <h2>{strings.intakeMachbar}</h2>
          {draft.workItems.map((item, index) => {
            const parentTitle = item.parentKey
              ? draft.workItems.find(
                  (candidate) => candidate.key === item.parentKey,
                )?.title ?? null
              : null;
            return (
              <IntakeWorkItemCard
                key={item.key}
                item={item}
                index={index}
                depth={workItemDepth[index] ?? 0}
                parentTitle={parentTitle}
                hasInvalidInput={hasInvalidWorkInput(item)}
                onDateValidityChange={onDateValidityChange}
                onKindChange={(kind) =>
                  onChange({
                    ...draft,
                    workItems: transitionWorkItemKind(
                      draft.workItems,
                      item.key,
                      kind,
                    ),
                  })
                }
                members={members}
                issues={issues}
                reminderRowIds={reminderRowIds.get(item.key) ?? []}
                createReminderRowId={createReminderRowId}
                onChange={(next) => {
                  const items = draft.workItems.map((value, itemIndex) =>
                    itemIndex === index ? next : value,
                  );
                  if (!next.enabled) {
                    const disabled = new Set([next.key]);
                    let changed = true;
                    while (changed) {
                      changed = false;
                      for (const value of items) {
                        if (
                          value.parentKey &&
                          disabled.has(value.parentKey) &&
                          !disabled.has(value.key)
                        ) {
                          disabled.add(value.key);
                          changed = true;
                        }
                      }
                    }
                    onChange({
                      ...draft,
                      workItems: items.map((value) =>
                        disabled.has(value.key)
                          ? { ...value, enabled: false }
                          : value,
                      ),
                    });
                  } else {
                    onChange({ ...draft, workItems: items });
                  }
                }}
                onReminderChange={onReminderChange}
              />
            );
          })}
        </section>
      ) : null}
      {globalIssues.map((issue, index) => (
        <p role="alert" key={`${issue.code}-${index}`}>
          <IntakeIssueText issues={[issue]} path={issue.path} />
        </p>
      ))}
    </>
  );
}
