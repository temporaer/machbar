import type { IntakeDraftWorkItem, IntakeIssue, Member, TaskReminderInput } from "@machbar/shared";
import {
  taskAvailabilityClock,
  taskAvailabilityForLocalDate,
} from "../lib/taskAvailability";
import { useStrings } from "../lib/strings";
import { BottomSheet } from "../components/BottomSheet";
import { HumanDateInput } from "../components/HumanDateInput";
import { MemberChoiceGroup } from "../components/MemberChoiceGroup";
import { ScheduleShortcuts } from "../components/ScheduleShortcuts";
import { browserTimezone } from "../lib/browserTimezone";
import { formatReminderLabel } from "../lib/reminderLabels";
import { useLocale } from "../lib/locale";
import {
  IntakeIssueText,
  IntakeLocalDateTimeField,
  type DateValidityChange,
  useDateValidityCallback,
} from "./IntakeReviewFields";

type PropertyEditorProps = {
  item: IntakeDraftWorkItem;
  index: number;
  issues: IntakeIssue[];
  onDateValidityChange: DateValidityChange;
  onChange: (item: IntakeDraftWorkItem) => void;
  onClose: () => void;
};

export function IntakeOwnerEditor({
  item,
  index,
  members,
  issues,
  onChange,
  onClose,
}: PropertyEditorProps & { members: Member[] }) {
  const strings = useStrings();
  return (
    <BottomSheet title={strings.owner} onClose={onClose}>
      <div className="stack intake-edit-sheet">
        <MemberChoiceGroup
          label={strings.owner}
          idPrefix={`intake-work-${item.key}-owner`}
          members={members}
          value={item.ownerMemberId}
          unassignedLabel={strings.sharedOwner}
          onChange={(ownerMemberId) => {
            onChange({ ...item, ownerMemberId });
            onClose();
          }}
        />
        <IntakeIssueText
          issues={issues}
          path={["workItems", index, "ownerMemberId"]}
        />
      </div>
    </BottomSheet>
  );
}

export function IntakeDueDateEditor({
  item,
  index,
  issues,
  onDateValidityChange,
  onChange,
  onClose,
}: PropertyEditorProps) {
  const strings = useStrings();
  const key = `work:${item.key}:due`;
  const onValidityChange = useDateValidityCallback(key, onDateValidityChange);
  return (
    <BottomSheet
      title={strings.due}
      onClose={() => {
        onDateValidityChange(key, true);
        onClose();
      }}
    >
      <div className="stack intake-edit-sheet">
        <label className="field-label" htmlFor={`intake-work-${item.key}-due`}>
          {strings.due}
        </label>
        <HumanDateInput
          id={`intake-work-${item.key}-due`}
          value={item.dueDate}
          onValidityChange={onValidityChange}
          onChange={(dueDate) => onChange({ ...item, dueDate })}
        />
        <IntakeIssueText
          issues={issues}
          path={["workItems", index, "dueDate"]}
        />
      </div>
    </BottomSheet>
  );
}

export function IntakePlanningEditor({
  item,
  onDateValidityChange,
  onChange,
  onClose,
}: PropertyEditorProps) {
  const strings = useStrings();
  const key = `work:${item.key}:scheduled`;
  const onValidityChange = useDateValidityCallback(key, onDateValidityChange);
  return (
    <BottomSheet
      title={strings.scheduled}
      onClose={() => {
        onDateValidityChange(key, true);
        onClose();
      }}
    >
      <div className="stack intake-edit-sheet">
        <label className="field-label" htmlFor={`intake-work-${item.key}-scheduled`}>
          {strings.scheduled}
        </label>
        <HumanDateInput
          id={`intake-work-${item.key}-scheduled`}
          value={item.scheduledDate}
          onValidityChange={onValidityChange}
          onChange={(scheduledDate) => onChange({ ...item, scheduledDate })}
        />
        <ScheduleShortcuts
          value={item.scheduledDate}
          onChange={(scheduledDate) => onChange({ ...item, scheduledDate })}
        />
      </div>
    </BottomSheet>
  );
}

export function IntakeAvailabilityEditor({
  item,
  onDateValidityChange,
  onChange,
  onClose,
}: PropertyEditorProps) {
  const strings = useStrings();
  const key = `work:${item.key}:availability`;
  const onValidityChange = useDateValidityCallback(key, onDateValidityChange);
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
      title={strings.notBefore}
      onClose={() => {
        onDateValidityChange(key, true);
        onClose();
      }}
    >
      <div className="stack intake-edit-sheet">
        <label className="field-label" htmlFor={`intake-work-${item.key}-availability`}>
          {strings.notBefore}
        </label>
        <HumanDateInput
          id={`intake-work-${item.key}-availability`}
          value={item.notBeforeDate}
          onValidityChange={onValidityChange}
          onChange={(date) =>
            updateAvailability(date ?? "", hasTime ? currentClock : null)
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
      </div>
    </BottomSheet>
  );
}

export function IntakeReminderEditor({
  item,
  index,
  issues,
  onDateValidityChange,
  onChange,
  onClose,
}: PropertyEditorProps) {
  const strings = useStrings();
  const { locale } = useLocale();
  const key = `work:${item.key}:reminder-date`;
  const addAbsolute = () => onChange({
    ...item,
    reminders: [...item.reminders, {
      kind: "absolute",
      at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }],
  });
  const addRelative = () => {
    if (!item.dueDate) return;
    onChange({
      ...item,
      reminders: [...item.reminders, {
        kind: "deadline_relative",
        daysBefore: 1,
        time: "09:00",
        timezone: browserTimezone() ?? "Europe/Berlin",
      }],
    });
  };
  const updateReminder = (index: number, reminder: TaskReminderInput) => {
    onChange({
      ...item,
      reminders: item.reminders.map((current, currentIndex) =>
        currentIndex === index ? reminder : current),
    });
  };
  return (
    <BottomSheet
      title={strings.reminder}
      onClose={() => {
        onDateValidityChange(key, true);
        onClose();
      }}
    >
      <div className="stack intake-edit-sheet">
        {!item.reminders.length ? (
          <IntakeLocalDateTimeField
            id={`intake-work-${item.key}-reminder`}
            fieldKey={key}
            onDateValidityChange={onDateValidityChange}
            label={strings.reminder}
            value={null}
            onChange={(at) => {
              if (at) onChange({
                ...item,
                reminders: [{ kind: "absolute", at }],
              });
            }}
          />
        ) : null}
        {item.reminders.map((reminder, reminderIndex) => (
          <div className="stack" key={`${item.key}-reminder-${reminderIndex}`}>
            {reminder.kind === "absolute" ? (
              <IntakeLocalDateTimeField
                id={`intake-work-${item.key}-reminder-${reminderIndex}`}
                fieldKey={`${key}-${reminderIndex}`}
                onDateValidityChange={onDateValidityChange}
                label={strings.reminder}
                value={reminder.at}
                onChange={(at) => onChange({
                  ...item,
                  reminders: at
                    ? item.reminders.map((current, currentIndex) =>
                      currentIndex === reminderIndex ? { kind: "absolute", at } : current)
                    : item.reminders.filter((_, currentIndex) => currentIndex !== reminderIndex),
                })}
              />
            ) : (
              <>
                <label>
                  {strings.reminderDaysBeforeFieldLabel}
                  <input
                    type="number"
                    min={0}
                    value={reminder.daysBefore}
                    onChange={(event) => updateReminder(reminderIndex, {
                      ...reminder,
                      daysBefore: Math.max(0, Number(event.target.value) || 0),
                    })}
                  />
                </label>
                <label>
                  {strings.reminderTimeFieldLabel}
                  <input
                    type="time"
                    value={reminder.time}
                    onChange={(event) => updateReminder(reminderIndex, {
                      ...reminder,
                      time: event.target.value,
                    })}
                  />
                </label>
              </>
            )}
            <span>{formatReminderLabel(reminder, item.dueDate, strings, locale)}</span>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => onChange({
                ...item,
                reminders: item.reminders.filter((_, index) => index !== reminderIndex),
              })}
            >
              {strings.reminderRemove}
            </button>
          </div>
        ))}
        <div className="cluster">
          <button type="button" className="btn btn-sm" onClick={addAbsolute}>
            + {strings.reminder}
          </button>
          {item.dueDate ? (
            <button type="button" className="btn btn-sm" onClick={addRelative}>
              + {strings.reminderDeadlineRelative}
            </button>
          ) : null}
        </div>
        <IntakeIssueText
          issues={issues}
          path={["workItems", index, "reminders"]}
        />
      </div>
    </BottomSheet>
  );
}
