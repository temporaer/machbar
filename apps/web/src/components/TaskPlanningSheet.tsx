import { useMemo, useState } from "react";
import type { Task } from "@machbar/shared";
import {
  calendarDateForInstant,
  DEFAULT_HOUSEHOLD_TIMEZONE,
} from "@machbar/shared";
import { useStrings } from "../lib/strings";
import { useLocale } from "../lib/locale";
import { useTaskActions } from "../lib/useTaskActions";
import { useAsync } from "../lib/useAsync";
import { api } from "../lib/api";
import { localizedErrorMessage } from "../lib/errorMessage";
import {
  extractCaptionHints,
  removeCaptionHintSpans,
  strongestCaptionHints,
  type TemporalCaptionHint,
} from "../lib/captionHints";
import { formatExactLocalDate } from "../lib/relativeDate";
import { taskAvailabilityClock, taskAvailabilityForLocalDate } from "../lib/taskAvailability";
import { resolveAbsolutePreset, absolutePresetIsFuture } from "../lib/reminderPresets";
import { resolveScheduleShortcut } from "./ScheduleShortcuts";
import { BottomSheet } from "./BottomSheet";
import { CaptionHintSuggestions } from "./CaptionHintSuggestions";
import { ScheduleShortcuts } from "./ScheduleShortcuts";
import { HumanDateInput } from "./HumanDateInput";

export type TaskPlanningFocus = "availability" | "scheduled";

/**
 * The canonical task planning workflow. Availability, scheduled work, and
 * deadlines are one local draft and one revision-safe commit.
 */
export function TaskPlanningSheet({
  task,
  onClose,
  focus = "scheduled",
}: {
  task: Task;
  onClose: () => void;
  focus?: TaskPlanningFocus;
}) {
  const strings = useStrings();
  const { locale } = useLocale();
  const taskActions = useTaskActions();
  const { data: timezoneData } = useAsync(
    () =>
      api.getHouseholdTimezone?.() ??
      Promise.resolve({ timezone: DEFAULT_HOUSEHOLD_TIMEZONE }),
    [],
  );
  const householdTimezone =
    timezoneData?.timezone ?? DEFAULT_HOUSEHOLD_TIMEZONE;
  const initialAvailabilityDate =
    task.revisitAt
      ? calendarDateForInstant(task.revisitAt, householdTimezone) ?? ""
      : "";
  const [notBeforeDate, setNotBeforeDate] = useState(initialAvailabilityDate);
  const [notBeforeTime, setNotBeforeTime] = useState(
    taskAvailabilityClock(task.revisitAt, householdTimezone) ?? "08:00",
  );
  const [scheduledDate, setScheduledDate] = useState(task.scheduledDate ?? "");
  const [dueDate, setDueDate] = useState(task.dueDate ?? "");
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
    Object.values(acceptedHints).flatMap((hint) => (hint ? [hint.removalSpan] : [])),
  );
  const nextAvailability = notBeforeDate
    ? taskAvailabilityForLocalDate(
        notBeforeDate,
        notBeforeTime,
        householdTimezone,
      )
    : null;
  const canMutuallyExclude = !task.externalWait && task.repeatAfterDays === null;
  const dirty =
    (nextAvailability?.notBeforeAt ?? null) !== task.revisitAt ||
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
    if (field === "scheduledDate") {
      setPlannedDate(hint.date);
    }
    else setDueDate(hint.date);
  };

  const labelFor = (hint: TemporalCaptionHint, field: "scheduledDate" | "dueDate") => {
    const date = formatExactLocalDate(hint.date, locale) ?? hint.date;
    return field === "scheduledDate"
      ? strings.titleHintSchedule(date)
      : strings.titleHintDeadline(date);
  };

  const setPlannedDate = (date: string) => {
    setScheduledDate(date);
    if (date && canMutuallyExclude) {
      setNotBeforeDate("");
      setNotBeforeTime("08:00");
    }
  };

  const setRevisitDateTime = (date: string, time: string) => {
    setNotBeforeDate(date);
    setNotBeforeTime(time);
    if (date && canMutuallyExclude) setScheduledDate("");
  };

  const commit = async () => {
    if (saving || !dateValid) return;
    setSaving(true);
    setError(null);
    try {
      const patch = {
        revisitAt: nextAvailability?.notBeforeAt ?? null,
        scheduledDate: scheduledDate || null,
        dueDate: dueDate || null,
        ...(cleanedTitle !== task.title ? { title: cleanedTitle } : {}),
      };
      await taskActions.update(task, patch, patch, true);
      onClose();
    } catch (cause) {
      setError(localizedErrorMessage(cause, strings));
    } finally {
      setSaving(false);
    }
  };

  return (
    <BottomSheet
      title={`${strings.planning}: ${task.title}`}
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
          <label htmlFor={`planning-availability-date-${task.id}`}>
            {strings.planningShowFrom}
          </label>
          <HumanDateInput
            id={`planning-availability-date-${task.id}`}
            value={notBeforeDate}
            onChange={(date) => setRevisitDateTime(date ?? "", notBeforeTime)}
            onValidityChange={setDateValid}
            disabled={saving}
            autoFocus={focus === "availability"}
          />
          <input
            id={`planning-availability-time-${task.id}`}
            type="time"
            value={notBeforeTime}
            onChange={(event) =>
              setRevisitDateTime(notBeforeDate, event.target.value)
            }
            disabled={saving || !notBeforeDate}
          />
          <label htmlFor={`planning-availability-time-${task.id}`}>
            {strings.availabilityCustomTime}
          </label>
          <div className="choice-group" role="group" aria-label={strings.availabilitySameDayGroup}>
            <button
              type="button"
              className="choice-chip"
              disabled={saving}
              onClick={() => {
                const instant = resolveAbsolutePreset("in3Hours");
                const date = calendarDateForInstant(instant, householdTimezone);
                if (date) {
                  setRevisitDateTime(
                    date,
                    taskAvailabilityClock(instant, householdTimezone) ?? "08:00",
                  );
                }
              }}
            >
              {strings.availabilityInAWhile}
            </button>
            {absolutePresetIsFuture("tonight") ? (
              <button
                type="button"
                className="choice-chip"
                disabled={saving}
                onClick={() => {
                  const instant = resolveAbsolutePreset("tonight");
                  const date = calendarDateForInstant(instant, householdTimezone);
                  if (date) {
                    setRevisitDateTime(
                      date,
                      taskAvailabilityClock(instant, householdTimezone) ?? "08:00",
                    );
                  }
                }}
              >
                {strings.availabilityTonight}
              </button>
            ) : null}
            <button
              type="button"
              className="choice-chip"
              disabled={saving}
              onClick={() => {
                const date = resolveScheduleShortcut("tomorrow");
                if (date) setRevisitDateTime(date, "00:00");
              }}
            >
              {strings.scheduleShortcutLabels.tomorrow}
            </button>
            <button
              type="button"
              className="choice-chip"
              disabled={saving}
              onClick={() => {
                const date = resolveScheduleShortcut("weekend");
                if (date) setRevisitDateTime(date, "00:00");
              }}
            >
              {strings.scheduleShortcutLabels.weekend}
            </button>
          </div>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={saving || (!notBeforeDate && !task.revisitAt)}
            onClick={() => {
              setRevisitDateTime("", "08:00");
            }}
          >
            {strings.clearNotBefore}
          </button>
        </div>

        <div className="field">
          <label htmlFor={`planning-scheduled-${task.id}`}>{strings.planningScheduledFor}</label>
          <HumanDateInput
            id={`planning-scheduled-${task.id}`}
            value={scheduledDate}
            onChange={(date) => setPlannedDate(date ?? "")}
            onValidityChange={setDateValid}
            disabled={saving}
            autoFocus={focus === "scheduled"}
          />
          <ScheduleShortcuts
            value={scheduledDate}
            onChange={(date) => {
              setPlannedDate(date ?? "");
            }}
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
        </div>

        <div className="field">
          <label htmlFor={`planning-due-${task.id}`}>{strings.planningDueBy}</label>
          <HumanDateInput
            id={`planning-due-${task.id}`}
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
          <button
            type="submit"
            className="btn btn-primary"
            disabled={saving || !dateValid || !dirty}
          >
            {strings.confirmDone}
          </button>
        </div>
      </form>
    </BottomSheet>
  );
}
