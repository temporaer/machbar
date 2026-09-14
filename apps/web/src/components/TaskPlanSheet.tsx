import { useMemo, useState } from "react";
import type { Task } from "@machbar/shared";
import { useStrings } from "../lib/strings";
import { useLocale } from "../lib/locale";
import { useTaskActions } from "../lib/useTaskActions";
import { localizedErrorMessage } from "../lib/errorMessage";
import {
  extractCaptionHints,
  removeCaptionHintSpans,
  strongestCaptionHints,
  type TemporalCaptionHint,
} from "../lib/captionHints";
import { formatExactLocalDate } from "../lib/relativeDate";
import { BottomSheet } from "./BottomSheet";
import { CaptionHintSuggestions } from "./CaptionHintSuggestions";
import { ScheduleShortcuts } from "./ScheduleShortcuts";
import { HumanDateInput } from "./HumanDateInput";

/**
 * The one canonical `task.plan` workflow — reached identically from the
 * left-swipe rail, keyboard `s`, a click on the task detail's scheduled/
 * deadline value, and Review's plan repair. Scheduled date and deadline
 * are one small planning transaction: both fields are held as local draft
 * state and committed together on `Fertig`, not on every keystroke.
 */
export function TaskPlanSheet({ task, onClose }: { task: Task; onClose: () => void }) {
  const strings = useStrings();
  const { locale } = useLocale();
  const taskActions = useTaskActions();
  const [scheduledDate, setScheduledDate] = useState(task.scheduledDate ?? "");
  const [dueDate, setDueDate] = useState(task.dueDate ?? "");
  const [showDeadline, setShowDeadline] = useState(Boolean(task.dueDate));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dateValid, setDateValid] = useState(true);
  const [acceptedHints, setAcceptedHints] = useState<
    Partial<Record<"scheduledDate" | "dueDate", TemporalCaptionHint>>
  >({});

  const temporalHints = useMemo(
    () =>
      extractCaptionHints(task.title, {
        locale,
        referenceDate: new Date(task.createdAt),
      }).filter((hint): hint is TemporalCaptionHint => hint.kind === "temporal"),
    [locale, task.createdAt, task.title],
  );
  const scheduleHints = strongestCaptionHints(
    temporalHints.filter((hint) => hint.semantic === "scheduledDate"),
  );
  const deadlineHints = strongestCaptionHints(
    temporalHints.filter((hint) => hint.semantic === "dueDate"),
  );
  const cleanedTitle = removeCaptionHintSpans(
    task.title,
    Object.values(acceptedHints).flatMap((hint) =>
      hint ? [hint.removalSpan] : [],
    ),
  );
  const dirty =
    (scheduledDate || null) !== task.scheduledDate ||
    (dueDate || null) !== task.dueDate ||
    cleanedTitle !== task.title;

  const acceptHint = (
    field: "scheduledDate" | "dueDate",
    hints: readonly TemporalCaptionHint[],
    key: string,
  ) => {
    const hint = hints.find((candidate) => candidate.key === key);
    if (!hint) return;
    setAcceptedHints((current) => ({ ...current, [field]: hint }));
    if (field === "scheduledDate") setScheduledDate(hint.date);
    else {
      setDueDate(hint.date);
      setShowDeadline(true);
    }
  };

  const labelFor = (hint: TemporalCaptionHint, field: "scheduledDate" | "dueDate") => {
    const date = formatExactLocalDate(hint.date, locale) ?? hint.date;
    return field === "scheduledDate"
      ? strings.titleHintSchedule(date)
      : strings.titleHintDeadline(date);
  };

  const commit = async () => {
    if (saving || !dateValid) return;
    setSaving(true);
    setError(null);
    try {
      const patch = {
        scheduledDate: scheduledDate || null,
        dueDate: dueDate || null,
        ...(cleanedTitle !== task.title ? { title: cleanedTitle } : {}),
      };
      await taskActions.update(
        task,
        patch,
        patch,
        true,
      );
      onClose();
    } catch (cause) {
      setError(localizedErrorMessage(cause, strings));
    } finally {
      setSaving(false);
    }
  };

  return (
    <BottomSheet
      title={`${strings.plan}: ${task.title}`}
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          void commit();
        }}
      >
        <div className="field">
          <label htmlFor={`plan-scheduled-${task.id}`}>{strings.taskPlanQuestion}</label>
          <HumanDateInput
            id={`plan-scheduled-${task.id}`}
            value={scheduledDate}
            onChange={(date) => setScheduledDate(date ?? "")}
            onValidityChange={setDateValid}
            disabled={saving}
            autoFocus
          />
        </div>
        <ScheduleShortcuts
          value={scheduledDate}
          onChange={(date) => setScheduledDate(date ?? "")}
          disabled={saving}
        />
        <CaptionHintSuggestions
          hints={scheduleHints.map((hint) => ({
            key: hint.key,
            label: labelFor(hint, "scheduledDate"),
          }))}
          disabled={saving}
          onSelect={(key) => acceptHint("scheduledDate", scheduleHints, key)}
        />

        {showDeadline ? (
          <div className="field">
            <label htmlFor={`plan-due-${task.id}`}>{strings.due}</label>
            <HumanDateInput
              id={`plan-due-${task.id}`}
              value={dueDate}
              onChange={(date) => setDueDate(date ?? "")}
              onValidityChange={setDateValid}
              disabled={saving}
            />
            <CaptionHintSuggestions
              hints={deadlineHints.map((hint) => ({
                key: hint.key,
                label: labelFor(hint, "dueDate"),
              }))}
              disabled={saving}
              onSelect={(key) => acceptHint("dueDate", deadlineHints, key)}
            />
          </div>
        ) : (
          <>
            <button
              type="button"
              className="btn btn-sm btn-ghost task-detail-add-property"
              onClick={() => setShowDeadline(true)}
            >
              {strings.addDeadline}
            </button>
            <CaptionHintSuggestions
              hints={deadlineHints.map((hint) => ({
                key: hint.key,
                label: labelFor(hint, "dueDate"),
              }))}
              disabled={saving}
              onSelect={(key) => acceptHint("dueDate", deadlineHints, key)}
            />
          </>
        )}

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
          <button type="submit" className="btn btn-primary" disabled={saving || !dateValid || !dirty}>
            {strings.confirmDone}
          </button>
        </div>
      </form>
    </BottomSheet>
  );
}
