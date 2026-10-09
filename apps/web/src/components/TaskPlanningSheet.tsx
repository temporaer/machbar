import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Task } from "@machbar/shared";
import { calendarDateForInstant } from "@machbar/shared";
import { useStrings } from "../lib/strings";
import { useLocale } from "../lib/locale";
import { useTaskActions } from "../lib/useTaskActions";
import { useHouseholdTimezone } from "../lib/householdTimezone";
import { localizedErrorMessage } from "../lib/errorMessage";
import {
  extractCaptionHints,
  removeCaptionHintSpans,
  strongestCaptionHints,
  type TemporalCaptionHint,
} from "../lib/captionHints";
import { formatExactLocalDate, formatRevisitAt } from "../lib/relativeDate";
import { addIsoCalendarDays, toIsoCalendarDate } from "../lib/naturalDate";
import {
  taskAvailabilityClock,
  taskAvailabilityForLocalDate,
} from "../lib/taskAvailability";
import {
  resolveAbsolutePreset,
  absolutePresetIsFuture,
} from "../lib/reminderPresets";
import type { TaskPlanningTarget } from "../lib/commands";
import { BottomSheet } from "./BottomSheet";
import { CaptionHintSuggestions } from "./CaptionHintSuggestions";
import { ScheduleShortcuts } from "./ScheduleShortcuts";
import { HumanDateInput } from "./HumanDateInput";

type DateField = "scheduled" | "availability" | "deadline";
type DateValidity = Record<DateField, boolean>;

function cardClass(active: boolean) {
  return `task-planning-card${active ? " task-planning-card-active" : ""}`;
}

/**
 * The canonical task planning workflow. All three date types are one local
 * draft and one revision-safe commit.
 */
export function TaskPlanningSheet({
  task,
  onClose,
  initialTarget,
}: {
  task: Task;
  onClose: () => void;
  initialTarget?: TaskPlanningTarget;
}) {
  const strings = useStrings();
  const { locale } = useLocale();
  const taskActions = useTaskActions();
  const { timezone: householdTimezone, loaded: timezoneLoaded } =
    useHouseholdTimezone();
  const scheduledCardRef = useRef<HTMLElement>(null);
  const availabilityCardRef = useRef<HTMLElement>(null);
  const deadlineCardRef = useRef<HTMLElement>(null);
  const planningFormRef = useRef<HTMLFormElement>(null);
  const initialAvailabilityDate = task.revisitAt
    ? calendarDateForInstant(task.revisitAt, householdTimezone) ?? ""
    : "";
  const [notBeforeDate, setNotBeforeDate] = useState(initialAvailabilityDate);
  const [notBeforeTime, setNotBeforeTime] = useState(
    taskAvailabilityClock(task.revisitAt, householdTimezone) ?? "06:00",
  );
  const [availabilityEdited, setAvailabilityEdited] = useState(false);
  const [scheduledDate, setScheduledDate] = useState(task.scheduledDate ?? "");
  const [dueDate, setDueDate] = useState(task.dueDate ?? "");
  const [deadlineOpen, setDeadlineOpen] = useState(
    Boolean(task.dueDate) || initialTarget === "deadline",
  );
  const [activeTarget, setActiveTarget] = useState<TaskPlanningTarget | undefined>(
    initialTarget,
  );
  const [validity, setValidity] = useState<DateValidity>({
    scheduled: true,
    availability: true,
    deadline: true,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scheduledNotice, setScheduledNotice] = useState<string | null>(null);
  const [availabilityNotice, setAvailabilityNotice] = useState<string | null>(null);
  const [acceptedHints, setAcceptedHints] = useState<
    Partial<Record<"scheduledDate" | "dueDate", TemporalCaptionHint>>
  >({});

  useLayoutEffect(() => {
    setActiveTarget(initialTarget);
    if (initialTarget === "deadline") {
      setDeadlineOpen(true);
    }
    const target =
      initialTarget === "scheduled"
        ? scheduledCardRef.current
        : initialTarget === "availability"
          ? availabilityCardRef.current
          : deadlineCardRef.current;
    const scrollTarget = target ?? planningFormRef.current;
    if (scrollTarget && typeof scrollTarget.scrollIntoView === "function") {
      if (!initialTarget) {
        scrollTarget.scrollIntoView({ block: "start", behavior: "auto" });
        return;
      }
      scrollTarget.scrollIntoView({ block: "nearest", behavior: "auto" });
    }
  }, [initialTarget]);

  useEffect(() => {
    if (availabilityEdited) return;
    setNotBeforeDate(
      task.revisitAt
        ? calendarDateForInstant(task.revisitAt, householdTimezone) ?? ""
        : "",
    );
    setNotBeforeTime(
      taskAvailabilityClock(task.revisitAt, householdTimezone) ?? "06:00",
    );
  }, [availabilityEdited, householdTimezone, task.revisitAt]);

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
  const invalidRevisitSelection =
    availabilityEdited && Boolean(notBeforeDate) && nextAvailability === null;
  const householdToday =
    calendarDateForInstant(new Date().toISOString(), householdTimezone) ??
    toIsoCalendarDate(new Date());
  const revisitAtForCommit = availabilityEdited
    ? nextAvailability?.notBeforeAt ?? null
    : task.revisitAt;
  const canMutuallyExclude = !task.externalWait && task.repeatAfterDays === null;
  const dirty =
    revisitAtForCommit !== task.revisitAt ||
    (scheduledDate || null) !== task.scheduledDate ||
    (dueDate || null) !== task.dueDate ||
    cleanedTitle !== task.title;
  const allValid =
    validity.scheduled && validity.availability && validity.deadline;
  const matchesAvailability = (instant: string | null) =>
    Boolean(
      timezoneLoaded &&
      instant &&
      nextAvailability?.notBeforeAt === instant,
    );
  const tomorrowAvailability = taskAvailabilityForLocalDate(
    addIsoCalendarDays(householdToday, 1),
    notBeforeTime || "06:00",
    householdTimezone,
  )?.notBeforeAt ?? null;
  const weekendDate = (() => {
    const day = new Date(`${householdToday}T00:00:00.000Z`).getUTCDay();
    return addIsoCalendarDays(householdToday, (6 - day + 7) % 7);
  })();
  const weekendAvailability = taskAvailabilityForLocalDate(
    weekendDate,
    notBeforeTime || "06:00",
    householdTimezone,
  )?.notBeforeAt ?? null;

  const setFieldValidity = useCallback((field: DateField, valid: boolean) => {
    setValidity((current) =>
      current[field] === valid ? current : { ...current, [field]: valid },
    );
  }, []);
  const setScheduledValidity = useCallback(
    (valid: boolean) => setFieldValidity("scheduled", valid),
    [setFieldValidity],
  );
  const setAvailabilityValidity = useCallback(
    (valid: boolean) => setFieldValidity("availability", valid),
    [setFieldValidity],
  );
  const setDeadlineValidity = useCallback(
    (valid: boolean) => setFieldValidity("deadline", valid),
    [setFieldValidity],
  );

  const acceptHint = (
    field: "scheduledDate" | "dueDate",
    hints: readonly TemporalCaptionHint[],
    key: string,
  ) => {
    const hint = hints.find((candidate) => candidate.key === key);
    if (!hint) return;
    setAcceptedHints((current) => ({ ...current, [field]: hint }));
    if (field === "scheduledDate") setPlannedDate(hint.date);
    else {
      setDueDate(hint.date);
      setDeadlineOpen(true);
    }
  };

  const labelFor = (
    hint: TemporalCaptionHint,
    field: "scheduledDate" | "dueDate",
  ) => {
    const date = formatExactLocalDate(hint.date, locale) ?? hint.date;
    return field === "scheduledDate"
      ? strings.titleHintSchedule(date)
      : strings.titleHintDeadline(date);
  };

  const setPlannedDate = (date: string) => {
    setScheduledDate(date);
    setValidity((current) => ({ ...current, scheduled: true }));
    setScheduledNotice(null);
    if (!date) {
      setAvailabilityNotice(null);
      return;
    }
    if (canMutuallyExclude && notBeforeDate) {
      const previous = formatRevisitAt(
        nextAvailability?.notBeforeAt ??
          taskAvailabilityForLocalDate(
            notBeforeDate,
            notBeforeTime,
            householdTimezone,
          )?.notBeforeAt ??
          "",
        locale,
        householdTimezone,
      ) ?? `${formatExactLocalDate(notBeforeDate, locale) ?? notBeforeDate} ${notBeforeTime}`;
      setAvailabilityNotice(
        strings.planningRevisitRemoved(previous),
      );
      setAvailabilityEdited(true);
      setNotBeforeDate("");
      setNotBeforeTime("06:00");
      setValidity((current) => ({ ...current, availability: true }));
    } else {
      setAvailabilityNotice(null);
    }
  };

  const setRevisitDate = (date: string) => {
    setAvailabilityEdited(true);
    setNotBeforeDate(date);
    setValidity((current) => ({ ...current, availability: true }));
    setAvailabilityNotice(null);
    if (!date) {
      setScheduledNotice(null);
      return;
    }
    if (canMutuallyExclude && scheduledDate) {
      const previous = formatExactLocalDate(scheduledDate, locale) ?? scheduledDate;
      setScheduledNotice(strings.planningScheduledRemoved(previous));
      setScheduledDate("");
      setValidity((current) => ({ ...current, scheduled: true }));
    }
  };

  const setRevisitTime = (time: string) => {
    setAvailabilityEdited(true);
    setNotBeforeTime(time);
  };

  const setRevisitDateTime = (date: string, time: string) => {
    setRevisitDate(date);
    setNotBeforeTime(time);
  };

  const removeScheduled = () => {
    setScheduledDate("");
    setValidity((current) => ({ ...current, scheduled: true }));
    setAvailabilityNotice(null);
  };

  const removeAvailability = () => {
    setRevisitDate("");
    setNotBeforeTime("06:00");
    setValidity((current) => ({ ...current, availability: true }));
    setAvailabilityNotice(null);
  };

  const removeDeadline = () => {
    setDueDate("");
    setDeadlineOpen(false);
    setValidity((current) => ({ ...current, deadline: true }));
  };

  const commit = async () => {
    if (saving || !allValid || invalidRevisitSelection) return;
    setSaving(true);
    setError(null);
    try {
      const patch = {
        revisitAt: revisitAtForCommit,
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

  const cardEvents = (target: TaskPlanningTarget) => ({
    onPointerDownCapture: () => setActiveTarget(target),
    onFocusCapture: () => setActiveTarget(target),
  });

  return (
    <BottomSheet
      title={strings.planning}
      initialFocus="dialog"
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      <p className="task-planning-title">{task.title}</p>
      <form
        ref={planningFormRef}
        className="stack task-planning-form"
        onSubmit={(event) => {
          event.preventDefault();
          void commit();
        }}
      >
        <section
          ref={scheduledCardRef}
          className={cardClass(activeTarget === "scheduled")}
          {...cardEvents("scheduled")}
        >
          <div className="task-planning-card-header">
            <div>
              <h3>{strings.planningScheduledFor}</h3>
              <p>{strings.planningScheduledExplanation}</p>
            </div>
            {scheduledDate ? (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                aria-label={strings.removePlanningDate}
                disabled={saving}
                onClick={removeScheduled}
              >
                {strings.remove}
              </button>
            ) : null}
          </div>
          <HumanDateInput
            id={`planning-scheduled-${task.id}`}
            value={scheduledDate}
            ariaLabel={strings.planningScheduledFor}
            onChange={(date) => setPlannedDate(date ?? "")}
            onValidityChange={setScheduledValidity}
            disabled={saving}
          />
          <ScheduleShortcuts
            value={scheduledDate}
            onChange={(date) => setPlannedDate(date ?? "")}
            disabled={saving}
            includeUnscheduled={false}
          />
          <CaptionHintSuggestions
            hints={scheduleHints.map((hint) => ({
              key: hint.key,
              label: labelFor(hint, "scheduledDate"),
            }))}
            disabled={saving}
            onSelect={(key) => acceptHint("scheduledDate", scheduleHints, key)}
          />
          {scheduledNotice ? (
            <p className="task-planning-replacement-note" role="status">
              {scheduledNotice}
            </p>
          ) : null}
        </section>

        <section
          ref={availabilityCardRef}
          className={cardClass(activeTarget === "availability")}
          {...cardEvents("availability")}
        >
          <div className="task-planning-card-header">
            <div>
              <h3>{strings.planningShowFrom}</h3>
              <p>
                {task.externalWait
                  ? strings.planningAvailabilityExternalExplanation
                  : strings.planningAvailabilityExplanation}
              </p>
            </div>
            {notBeforeDate ? (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                aria-label={strings.removeRevisitDate}
                disabled={saving || !timezoneLoaded}
                onClick={removeAvailability}
              >
                {strings.remove}
              </button>
            ) : null}
          </div>
          <div className="task-planning-datetime">
            <div className="task-planning-date">
              <label htmlFor={`planning-availability-date-${task.id}`}>
                {strings.date}
              </label>
              <HumanDateInput
                id={`planning-availability-date-${task.id}`}
                value={notBeforeDate}
                onChange={(date) => setRevisitDate(date ?? "")}
                onValidityChange={setAvailabilityValidity}
                disabled={saving || !timezoneLoaded}
              />
            </div>
            <div className="task-planning-time">
              <label htmlFor={`planning-availability-time-${task.id}`}>
                {strings.time}
              </label>
              <input
                id={`planning-availability-time-${task.id}`}
                type="time"
                value={notBeforeTime}
                onChange={(event) =>
                  setRevisitTime(event.target.value)
                }
                disabled={saving || !timezoneLoaded || !notBeforeDate}
              />
            </div>
          </div>
          {invalidRevisitSelection ? (
            <p className="human-date-error" role="alert">
              {strings.invalidRevisitTime}
            </p>
          ) : null}
          <div
            className="choice-group"
            role="group"
            aria-label={strings.availabilitySameDayGroup}
          >
            <button
              type="button"
              className="choice-chip"
              aria-pressed={matchesAvailability(
                resolveAbsolutePreset("in3Hours", new Date(), householdTimezone),
              )}
              disabled={saving || !timezoneLoaded}
              onClick={() => {
                const instant = resolveAbsolutePreset(
                  "in3Hours",
                  new Date(),
                  householdTimezone,
                );
                const date = instant
                  ? calendarDateForInstant(instant, householdTimezone)
                  : null;
                if (date) {
                  setRevisitDateTime(
                    date,
                    taskAvailabilityClock(instant, householdTimezone) ?? "06:00",
                  );
                }
              }}
            >
              {strings.availabilityInAWhile}
            </button>
            {absolutePresetIsFuture("tonight", new Date(), householdTimezone) ? (
              <button
                type="button"
                className="choice-chip"
                aria-pressed={matchesAvailability(
                  resolveAbsolutePreset("tonight", new Date(), householdTimezone),
                )}
                disabled={saving || !timezoneLoaded}
                onClick={() => {
                  const instant = resolveAbsolutePreset(
                    "tonight",
                    new Date(),
                    householdTimezone,
                  );
                  const date = instant
                    ? calendarDateForInstant(instant, householdTimezone)
                    : null;
                  if (date) {
                    setRevisitDateTime(
                      date,
                      taskAvailabilityClock(instant, householdTimezone) ?? "06:00",
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
              aria-pressed={matchesAvailability(tomorrowAvailability)}
              disabled={saving || !timezoneLoaded}
              onClick={() =>
                setRevisitDateTime(
                  addIsoCalendarDays(householdToday, 1),
                  notBeforeTime || "06:00",
                )
              }
            >
              {strings.scheduleShortcutLabels.tomorrow}
            </button>
            <button
              type="button"
              className="choice-chip"
              aria-pressed={matchesAvailability(weekendAvailability)}
              disabled={saving || !timezoneLoaded}
              onClick={() => {
                const day = new Date(`${householdToday}T00:00:00.000Z`).getUTCDay();
                const daysUntilSaturday = (6 - day + 7) % 7;
                setRevisitDateTime(
                  addIsoCalendarDays(householdToday, daysUntilSaturday),
                  notBeforeTime || "06:00",
                );
              }}
            >
              {strings.scheduleShortcutLabels.weekend}
            </button>
          </div>
          {availabilityNotice ? (
            <p className="task-planning-replacement-note" role="status">
              {availabilityNotice}
            </p>
          ) : null}
        </section>

        <section
          ref={deadlineCardRef}
          className={`${cardClass(activeTarget === "deadline")}${
            !deadlineOpen ? " task-planning-card-compact" : ""
          }`}
          {...cardEvents("deadline")}
        >
          <div className="task-planning-card-header">
            <div>
              <h3>{strings.planningDueBy}</h3>
              {deadlineOpen ? (
                <p>{strings.planningDeadlineExplanation}</p>
              ) : null}
            </div>
            {dueDate ? (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                aria-label={strings.removeDeadline}
                disabled={saving}
                onClick={removeDeadline}
              >
                {strings.remove}
              </button>
            ) : null}
          </div>
          {!deadlineOpen ? (
            <button
              type="button"
              className="btn btn-sm btn-ghost task-planning-add-deadline"
              disabled={saving}
              onClick={() => setDeadlineOpen(true)}
            >
              {strings.addDeadline}
            </button>
          ) : (
            <>
              <HumanDateInput
                id={`planning-due-${task.id}`}
                value={dueDate}
                ariaLabel={strings.planningDueBy}
                onChange={(date) => {
                  setDueDate(date ?? "");
                  setValidity((current) => ({ ...current, deadline: true }));
                }}
                onValidityChange={setDeadlineValidity}
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
            </>
          )}
        </section>

        {error ? (
          <div className="task-row-error" role="alert">
            <span>{strings.error}</span>
            <span className="text-muted">{error}</span>
          </div>
        ) : null}

        <div className="task-planning-actions">
          <button type="button" className="btn" disabled={saving} onClick={onClose}>
            {strings.cancel}
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={saving || !allValid || invalidRevisitSelection || !dirty}
          >
            {strings.save}
          </button>
        </div>
      </form>
    </BottomSheet>
  );
}
