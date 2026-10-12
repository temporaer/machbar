import { forwardRef, useCallback, useImperativeHandle, useState } from "react";
import type { TaskReminderInput } from "@machbar/shared";
import { calendarDateForInstant, householdCalendarDateTimeToRevisitAt, localTimeForInstant } from "@machbar/shared";
import { useStrings } from "../lib/strings";
import { useLocale } from "../lib/locale";
import { useHouseholdTimezone } from "../lib/householdTimezone";
import { toIsoCalendarDate } from "../lib/naturalDate";
import {
  ABSOLUTE_REMINDER_PRESETS,
  DEADLINE_RELATIVE_REMINDER_PRESETS,
  absolutePresetIsFuture,
  absolutePresetReminderInput,
  relativePresetReminderInput,
  type AbsoluteReminderPreset,
  type DeadlineRelativeReminderPreset,
} from "../lib/reminderPresets";
import { formatReminderLabel, sortRemindersForDisplay } from "../lib/reminderLabels";
import { HumanDateInput } from "./HumanDateInput";
import { ClockTimePicker } from "./ClockTimePicker";

interface DraftReminder {
  key: string;
  reminder: TaskReminderInput;
}

let nextDraftKey = 0;

function toDraft(reminders: TaskReminderInput[]): DraftReminder[] {
  return reminders.map((reminder) => ({
    key: reminder.id !== undefined ? `id-${reminder.id}` : `new-${nextDraftKey++}`,
    reminder,
  }));
}

type EditorState =
  | { mode: "closed" }
  | { mode: "choosing" }
  | { mode: "customAbsolute"; key: string | null; date: string; time: string; dateValid: boolean }
  | { mode: "customRelative"; key: string | null; daysBefore: number; time: string; timezone: string };

export interface TaskRemindersEditorHandle {
  getCommitValue(): TaskReminderInput[] | null;
}

interface TaskRemindersEditorProps {
  reminders: TaskReminderInput[];
  dueDate: string | null;
  onChange: (reminders: TaskReminderInput[]) => void;
  onPendingChange?: (pending: boolean) => void;
  disabled?: boolean;
  autoOpen?: boolean;
}

/** Draft-only reminder controls used by the single task-planning workflow. */
export const TaskRemindersEditor = forwardRef<TaskRemindersEditorHandle, TaskRemindersEditorProps>(({
  reminders,
  dueDate,
  onChange,
  onPendingChange,
  disabled = false,
  autoOpen = false,
}, ref) => {
  const strings = useStrings();
  const { locale } = useLocale();
  const { timezone: householdTimezone } = useHouseholdTimezone();
  const [draft, setDraft] = useState<DraftReminder[]>(() => toDraft(reminders));
  const [editor, setEditor] = useState<EditorState>(() =>
    autoOpen && reminders.length === 0 ? { mode: "choosing" } : { mode: "closed" },
  );

  const updateEditor = (next: EditorState) => {
    setEditor(next);
    onPendingChange?.(next.mode === "customAbsolute" || next.mode === "customRelative");
  };
  const setAbsoluteDateValidity = useCallback((dateValid: boolean) => {
    setEditor((current) => current.mode === "customAbsolute"
      ? { ...current, dateValid }
      : current);
  }, []);

  const replaceDraft = (next: DraftReminder[]) => {
    setDraft(next);
    onChange(next.map((entry) => entry.reminder));
  };

  const removeReminder = (key: string) => {
    replaceDraft(draft.filter((entry) => entry.key !== key));
  };

  const withReminder = (key: string | null, reminder: TaskReminderInput) => {
    const next = key === null
      ? [...draft, { key: `new-${nextDraftKey++}`, reminder }]
      : draft.map((entry) => {
          if (entry.key !== key) return entry;
          const existingId = entry.reminder.id;
          return { ...entry, reminder: existingId !== undefined ? { ...reminder, id: existingId } : reminder };
        });
    return next;
  };

  const upsertReminder = (key: string | null, reminder: TaskReminderInput) => {
    replaceDraft(withReminder(key, reminder));
    updateEditor({ mode: "closed" });
  };

  const addAbsolutePreset = (preset: AbsoluteReminderPreset) => {
    upsertReminder(null, absolutePresetReminderInput(preset, new Date(), householdTimezone));
  };

  const addRelativePreset = (preset: DeadlineRelativeReminderPreset) => {
    upsertReminder(null, relativePresetReminderInput(preset, householdTimezone));
  };

  const pendingReminder = (): { key: string | null; reminder: TaskReminderInput } | null => {
    if (editor.mode === "customAbsolute") {
      if (!editor.date.trim() || !editor.dateValid) return null;
      const at = householdCalendarDateTimeToRevisitAt(editor.date, editor.time, householdTimezone);
      return at ? { key: editor.key, reminder: { kind: "absolute", at } } : null;
    }
    if (editor.mode === "customRelative") {
      if (!Number.isInteger(editor.daysBefore) || editor.daysBefore < 0) return null;
      return {
        key: editor.key,
        reminder: {
          kind: "deadline_relative",
          daysBefore: editor.daysBefore,
          time: editor.time,
          timezone: editor.timezone,
        },
      };
    }
    return null;
  };

  const getCommitValue = (): TaskReminderInput[] | null => {
    const pending = pendingReminder();
    if (editor.mode === "customAbsolute" || editor.mode === "customRelative") {
      return pending ? withReminder(pending.key, pending.reminder).map((entry) => entry.reminder) : null;
    }
    return draft.map((entry) => entry.reminder);
  };

  useImperativeHandle(ref, () => ({ getCommitValue }), [editor, draft, householdTimezone]);

  const openCustomAbsolute = (entry?: DraftReminder) => {
    const reminder = entry?.reminder;
    const at = reminder && reminder.kind === "absolute" ? reminder.at : null;
    const initial = at ? new Date(at) : new Date();
    updateEditor({
      mode: "customAbsolute",
      key: entry?.key ?? null,
      date: at
        ? calendarDateForInstant(at, householdTimezone) ?? toIsoCalendarDate(initial)
        : calendarDateForInstant(initial.toISOString(), householdTimezone) ?? toIsoCalendarDate(initial),
      time: at ? localTimeForInstant(at, householdTimezone) ?? "19:00" : "19:00",
      dateValid: true,
    });
  };

  const openCustomRelative = (entry?: DraftReminder) => {
    const reminder = entry?.reminder;
    const isRelative = reminder?.kind === "deadline_relative";
    updateEditor({
      mode: "customRelative",
      key: entry?.key ?? null,
      daysBefore: isRelative ? reminder.daysBefore : 2,
      time: isRelative ? reminder.time : "09:00",
      timezone: isRelative ? reminder.timezone : householdTimezone,
    });
  };

  const confirmEditor = () => {
    const pending = pendingReminder();
    if (pending) upsertReminder(pending.key, pending.reminder);
  };

  const orderedDraft = sortRemindersForDisplay(draft.map((entry) => entry.reminder), dueDate)
    .map((reminder) => draft.find((entry) => entry.reminder === reminder))
    .filter((entry): entry is DraftReminder => entry !== undefined);
  const editingRowKey = editor.mode === "customAbsolute" || editor.mode === "customRelative"
    ? editor.key
    : undefined;

  const renderEditorRow = (rowKey: string) => {
    if (editor.mode !== "customAbsolute" && editor.mode !== "customRelative") return null;
    return (
      <li key={rowKey} className="reminder-row reminder-row-editing">
        {editor.mode === "customAbsolute" ? (
          <>
            <label htmlFor={`reminder-date-${rowKey}`} className="visually-hidden">{strings.due}</label>
            <HumanDateInput
              id={`reminder-date-${rowKey}`}
              value={editor.date}
              onChange={(date) => updateEditor({ ...editor, date: date ?? "" })}
              onValidityChange={setAbsoluteDateValidity}
              disabled={disabled}
            />
            <ClockTimePicker
              id={`reminder-time-${rowKey}`}
              value={editor.time}
              onChange={(time) => updateEditor({ ...editor, time })}
              disabled={disabled}
            />
          </>
        ) : (
          <>
            <label htmlFor={`reminder-days-${rowKey}`} className="visually-hidden">
              {strings.reminderDaysBeforeFieldLabel}
            </label>
            <input
              id={`reminder-days-${rowKey}`}
              type="number"
              min={0}
              className="reminder-days-before-input"
              value={editor.daysBefore}
              disabled={disabled}
              onChange={(event) => updateEditor({ ...editor, daysBefore: Math.max(0, Number(event.target.value) || 0) })}
            />
            <span className="reminder-editor-unit">{strings.reminderDaysBeforeFieldLabel}</span>
            <ClockTimePicker
              id={`reminder-relative-time-${rowKey}`}
              value={editor.time}
              onChange={(time) => updateEditor({ ...editor, time })}
              disabled={disabled}
            />
          </>
        )}
        <button
          type="button"
          className="btn btn-sm btn-primary reminder-row-confirm"
          aria-label={strings.reminderRowConfirm}
          disabled={disabled || pendingReminder() === null}
          onClick={confirmEditor}
        >✓</button>
      </li>
    );
  };

  return (
    <div className="stack">
      <ul className="reminder-list">
        {orderedDraft.map((entry) => entry.key === editingRowKey ? renderEditorRow(entry.key) : (
          <li key={entry.key} className="reminder-row">
            <button
              type="button"
              className="detail-meta-button reminder-row-label"
              disabled={disabled}
              onClick={() => entry.reminder.kind === "absolute" ? openCustomAbsolute(entry) : openCustomRelative(entry)}
            >{formatReminderLabel(entry.reminder, dueDate, strings, locale)}</button>
            <button
              type="button"
              className="btn btn-sm btn-ghost reminder-row-remove"
              aria-label={strings.reminderRemove}
              disabled={disabled}
              onClick={() => removeReminder(entry.key)}
            >×</button>
          </li>
        ))}
        {editingRowKey === null ? renderEditorRow("new") : null}
      </ul>

      {editor.mode === "choosing" ? (
        <div className="choice-group" role="group" aria-label={strings.addReminder}>
          {ABSOLUTE_REMINDER_PRESETS.filter((preset) =>
            preset !== "tonight" || absolutePresetIsFuture("tonight", new Date(), householdTimezone),
          ).map((preset) => (
            <button key={preset} type="button" className="choice-chip" disabled={disabled} onClick={() => addAbsolutePreset(preset)}>
              {strings.reminderPresetLabels[preset]}
            </button>
          ))}
          <button type="button" className="choice-chip" disabled={disabled} onClick={() => openCustomAbsolute()}>
            {strings.reminderCustomAbsolute}
          </button>
          {dueDate !== null ? DEADLINE_RELATIVE_REMINDER_PRESETS.map((preset) => (
            <button key={preset} type="button" className="choice-chip" disabled={disabled} onClick={() => addRelativePreset(preset)}>
              {strings.reminderRelativePresetLabels[preset]}
            </button>
          )) : null}
          {dueDate !== null ? (
            <button type="button" className="choice-chip" disabled={disabled} onClick={() => openCustomRelative()}>
              {strings.reminderCustomRelative}
            </button>
          ) : null}
        </div>
      ) : editor.mode === "closed" ? (
        <button type="button" className="btn btn-sm btn-ghost task-detail-add-property" disabled={disabled} onClick={() => updateEditor({ mode: "choosing" })}>
          {strings.addReminder}
        </button>
      ) : null}
    </div>
  );
});

TaskRemindersEditor.displayName = "TaskRemindersEditor";
