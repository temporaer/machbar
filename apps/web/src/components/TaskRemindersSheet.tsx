import { useState } from "react";
import type { Task, TaskReminderInput } from "@machbar/shared";
import { useStrings } from "../lib/strings";
import { useLocale } from "../lib/locale";
import { useTaskActions } from "../lib/useTaskActions";
import { localizedErrorMessage } from "../lib/errorMessage";
import { browserTimezone } from "../lib/browserTimezone";
import {
  ABSOLUTE_REMINDER_PRESETS,
  DEADLINE_RELATIVE_REMINDER_PRESETS,
  absolutePresetReminderInput,
  relativePresetReminderInput,
  type AbsoluteReminderPreset,
  type DeadlineRelativeReminderPreset,
} from "../lib/reminderPresets";
import { formatReminderLabel, sortRemindersForDisplay } from "../lib/reminderLabels";
import { BottomSheet } from "./BottomSheet";
import { HumanDateInput } from "./HumanDateInput";
import { ClockTimePicker } from "./ClockTimePicker";

/** A draft reminder plus a stable React key that survives edits (unlike array index, which shifts on removal). */
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
  | { mode: "customAbsolute"; key: string | null; date: string; time: string }
  | { mode: "customRelative"; key: string | null; daysBefore: number; time: string; timezone: string };

/**
 * The canonical `task.reminders` workflow, reached via the detail sheet's
 * reminders meta-row entry. Follows the same local-draft-then-commit
 * pattern as `TaskPlanSheet`: every add/edit/remove only touches local
 * state, and `Fertig` commits the whole `reminders` array in one task
 * PATCH (see `taskCrud.ts`'s stable-id diff), never issuing separate
 * requests per reminder.
 */
export function TaskRemindersSheet({ task, onClose }: { task: Task; onClose: () => void }) {
  const strings = useStrings();
  const { locale } = useLocale();
  const taskActions = useTaskActions();
  const [draft, setDraft] = useState<DraftReminder[]>(() => toDraft(task.reminders));
  const [editor, setEditor] = useState<EditorState>(() =>
    task.reminders.length === 0 ? { mode: "choosing" } : { mode: "closed" },
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasDeadline = task.dueDate !== null;
  const sorted = sortRemindersForDisplay(
    draft.map((entry) => entry.reminder),
    task.dueDate,
  );
  const orderedDraft = sorted
    .map((reminder) => draft.find((entry) => entry.reminder === reminder))
    .filter((entry): entry is DraftReminder => entry !== undefined);

  const removeReminder = (key: string) => {
    setDraft((current) => current.filter((entry) => entry.key !== key));
  };

  const upsertReminder = (key: string | null, reminder: TaskReminderInput) => {
    setDraft((current) => {
      if (key === null) return [...current, { key: `new-${nextDraftKey++}`, reminder }];
      return current.map((entry) => {
        if (entry.key !== key) return entry;
        const existingId = entry.reminder.id;
        return { ...entry, reminder: existingId !== undefined ? { ...reminder, id: existingId } : reminder };
      });
    });
    setEditor({ mode: "closed" });
  };

  const addAbsolutePreset = (preset: AbsoluteReminderPreset) => {
    upsertReminder(null, absolutePresetReminderInput(preset));
  };

  const addRelativePreset = (preset: DeadlineRelativeReminderPreset) => {
    upsertReminder(null, relativePresetReminderInput(preset, browserTimezone() ?? "UTC"));
  };

  const openCustomAbsolute = (entry?: DraftReminder) => {
    const reminder = entry?.reminder;
    const at = reminder && reminder.kind === "absolute" ? reminder.at : null;
    const initial = at ? new Date(at) : new Date();
    setEditor({
      mode: "customAbsolute",
      key: entry?.key ?? null,
      date: at ? at.slice(0, 10) : toIsoCalendarDate(initial),
      time: at ? `${String(initial.getHours()).padStart(2, "0")}:${String(initial.getMinutes()).padStart(2, "0")}` : "19:00",
    });
  };

  const openCustomRelative = (entry?: DraftReminder) => {
    const reminder = entry?.reminder;
    const isRelative = reminder && reminder.kind === "deadline_relative";
    setEditor({
      mode: "customRelative",
      key: entry?.key ?? null,
      daysBefore: isRelative ? reminder.daysBefore : 2,
      time: isRelative ? reminder.time : "09:00",
      timezone: isRelative ? reminder.timezone : (browserTimezone() ?? "UTC"),
    });
  };

  const openEditorForRow = (entry: DraftReminder) => {
    if (entry.reminder.kind === "absolute") openCustomAbsolute(entry);
    else openCustomRelative(entry);
  };

  /** The draft key currently being edited inline as a row (`null` for a new, not-yet-appended reminder; `undefined` when no row is being edited). */
  const editingRowKey =
    editor.mode === "customAbsolute" || editor.mode === "customRelative" ? editor.key : undefined;

  const confirmEditor = () => {
    if (editor.mode === "customAbsolute") {
      const at = new Date(`${editor.date}T${editor.time}:00`).toISOString();
      upsertReminder(editor.key, { kind: "absolute", at });
    } else if (editor.mode === "customRelative") {
      upsertReminder(editor.key, {
        kind: "deadline_relative",
        daysBefore: editor.daysBefore,
        time: editor.time,
        timezone: editor.timezone,
      });
    }
  };

  /**
   * Renders the currently-open custom editor (date+time, or days-before+time)
   * as one compact row of the reminder list/table itself -- editing happens
   * in place rather than in a separate panel below. `HumanDateInput` and
   * `ClockTimePicker` are themselves the pop-up "tools" for picking a date
   * or time, so this row only needs one small confirm action; there is no
   * separate cancel for the row, only for the whole sheet (`Abbrechen`
   * below discards the entire draft, including an in-progress row).
   */
  const renderEditorRow = (rowKey: string) => {
    if (editor.mode !== "customAbsolute" && editor.mode !== "customRelative") return null;
    return (
      <li key={rowKey} className="reminder-row reminder-row-editing">
        {editor.mode === "customAbsolute" ? (
          <>
            <label htmlFor={`reminder-date-${rowKey}`} className="visually-hidden">
              {strings.due}
            </label>
            <HumanDateInput
              id={`reminder-date-${rowKey}`}
              value={editor.date}
              onChange={(date) => setEditor({ ...editor, date: date ?? editor.date })}
            />
            <ClockTimePicker
              id={`reminder-time-${rowKey}`}
              value={editor.time}
              onChange={(time) => setEditor({ ...editor, time })}
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
              onChange={(event) =>
                setEditor({ ...editor, daysBefore: Math.max(0, Number(event.target.value) || 0) })
              }
            />
            <span className="reminder-editor-unit">{strings.reminderDaysBeforeFieldLabel}</span>
            <ClockTimePicker
              id={`reminder-relative-time-${rowKey}`}
              value={editor.time}
              onChange={(time) => setEditor({ ...editor, time })}
            />
          </>
        )}
        <button
          type="button"
          className="btn btn-sm btn-primary reminder-row-confirm"
          aria-label={strings.reminderRowConfirm}
          onClick={confirmEditor}
        >
          ✓
        </button>
      </li>
    );
  };

  const commit = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const reminders = draft.map((entry) => entry.reminder);
      await taskActions.update(task, { reminders }, { reminders: task.reminders }, true);
      onClose();
    } catch (cause) {
      setError(localizedErrorMessage(cause, strings));
    } finally {
      setSaving(false);
    }
  };

  return (
    <BottomSheet
      title={`${strings.reminders}: ${task.title}`}
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      <div className="stack">
        <ul className="reminder-list">
          {orderedDraft.map((entry) =>
            entry.key === editingRowKey ? (
              renderEditorRow(entry.key)
            ) : (
              <li key={entry.key} className="reminder-row">
                <button
                  type="button"
                  className="detail-meta-button reminder-row-label"
                  onClick={() => openEditorForRow(entry)}
                >
                  {formatReminderLabel(entry.reminder, task.dueDate, strings, locale)}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost reminder-row-remove"
                  aria-label={strings.reminderRemove}
                  onClick={() => removeReminder(entry.key)}
                  disabled={saving}
                >
                  ×
                </button>
              </li>
            ),
          )}
          {editingRowKey === null ? renderEditorRow("new") : null}
        </ul>

        {editor.mode === "choosing" ? (
          <div className="choice-group" role="group" aria-label={strings.addReminder}>
            {ABSOLUTE_REMINDER_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                className="choice-chip"
                onClick={() => addAbsolutePreset(preset)}
              >
                {strings.reminderPresetLabels[preset]}
              </button>
            ))}
            <button type="button" className="choice-chip" onClick={() => openCustomAbsolute()}>
              {strings.reminderCustomAbsolute}
            </button>
            {hasDeadline
              ? DEADLINE_RELATIVE_REMINDER_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    className="choice-chip"
                    onClick={() => addRelativePreset(preset)}
                  >
                    {strings.reminderRelativePresetLabels[preset]}
                  </button>
                ))
              : null}
            {hasDeadline ? (
              <button type="button" className="choice-chip" onClick={() => openCustomRelative()}>
                {strings.reminderCustomRelative}
              </button>
            ) : null}
          </div>
        ) : editor.mode === "closed" ? (
          <button
            type="button"
            className="btn btn-sm btn-ghost task-detail-add-property"
            onClick={() => setEditor({ mode: "choosing" })}
          >
            {strings.addReminder}
          </button>
        ) : null}

        {error ? (
          <div className="task-row-error" role="alert">
            <span>{strings.error}</span>
            <span className="text-muted">{error}</span>
          </div>
        ) : null}

        <div className="row">
          <button type="button" className="btn" disabled={saving} onClick={onClose}>
            {strings.cancel}
          </button>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void commit()}>
            {strings.confirmDone}
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}

function toIsoCalendarDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
