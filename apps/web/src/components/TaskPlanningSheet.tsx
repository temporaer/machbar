import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Task } from "@machbar/shared";
import { useStrings } from "../lib/strings";
import { useLocale } from "../lib/locale";
import { useTaskActions } from "../lib/useTaskActions";
import { localizedErrorMessage } from "../lib/errorMessage";
import type { TaskPlanningTarget } from "../lib/commands";
import {
  extractCaptionHints,
  removeCaptionHintSpans,
  strongestCaptionHints,
  type TemporalCaptionHint,
} from "../lib/captionHints";
import { formatExactLocalDate } from "../lib/relativeDate";
import { localDateForInstant } from "../lib/localDateTime";
import {
  taskAvailabilityClock,
  taskAvailabilityForLocalDate,
} from "../lib/taskAvailability";
import {
  resolveAbsolutePreset,
  absolutePresetIsFuture,
} from "../lib/reminderPresets";
import { resolveScheduleShortcut } from "./ScheduleShortcuts";
import { BottomSheet } from "./BottomSheet";
import { CaptionHintSuggestions } from "./CaptionHintSuggestions";
import { ScheduleShortcuts } from "./ScheduleShortcuts";
import { HumanDateInput } from "./HumanDateInput";

export type TaskPlanningFocus = "availability" | "scheduled";

type DateField = "scheduled" | "availability" | "deadline";
type DateValidity = Record<DateField, boolean>;

/**
 * The canonical task planning workflow. Scheduling, external waiting,
 * availability, and deadlines are one local draft and one revision-safe
 * commit.
 */
export function TaskPlanningSheet({
  task,
  onClose,
  initialTarget,
  focus,
}: {
  task: Task;
  onClose: () => void;
  initialTarget?: TaskPlanningTarget;
  /** Compatibility for the two delegating planning-sheet exports. */
  focus?: TaskPlanningFocus;
}) {
  const strings = useStrings();
  const { locale } = useLocale();
  const taskActions = useTaskActions();
  const formRef = useRef<HTMLFormElement>(null);
  const cardRefs = {
    scheduled: useRef<HTMLDivElement>(null),
    waiting: useRef<HTMLDivElement>(null),
    availability: useRef<HTMLDivElement>(null),
    deadline: useRef<HTMLDivElement>(null),
  };
  const initialAvailabilityDate =
    task.revisitAt
      ? localDateForInstant(task.revisitAt)
      : task.notBeforeAt
        ? localDateForInstant(task.notBeforeAt)
        : "";
  const [notBeforeDate, setNotBeforeDate] = useState(initialAvailabilityDate);
  const [notBeforeTime, setNotBeforeTime] = useState(
    taskAvailabilityClock(task.revisitAt ?? task.notBeforeAt ?? null) ?? "08:00",
  );
  const [scheduledDate, setScheduledDate] = useState(task.scheduledDate ?? "");
  const [dueDate, setDueDate] = useState(task.dueDate ?? "");
  const [waitingFor, setWaitingFor] = useState(
    task.externalWait?.waitingFor?.trim() ?? "",
  );
  const [waitingOpen, setWaitingOpen] = useState(task.externalWait !== null);
  const [waitingEnded, setWaitingEnded] = useState(false);
  const [activeTarget, setActiveTarget] = useState<TaskPlanningTarget | undefined>(
    initialTarget ?? (focus === "availability" ? "availability" : undefined),
  );
  const [pendingScroll, setPendingScroll] = useState<TaskPlanningTarget | null>(null);
  const [deadlineOpen, setDeadlineOpen] = useState(Boolean(task.dueDate));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [waitingError, setWaitingError] = useState<string | null>(null);
  const [validity, setValidity] = useState<DateValidity>({
    scheduled: true,
    availability: true,
    deadline: true,
  });
  const [acceptedHints, setAcceptedHints] = useState<
    Partial<Record<"scheduledDate" | "dueDate", TemporalCaptionHint>>
  >({});
  const [scheduledNotice, setScheduledNotice] = useState<string | null>(null);
  const [availabilityNotice, setAvailabilityNotice] = useState<string | null>(null);

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
    ? taskAvailabilityForLocalDate(notBeforeDate, notBeforeTime)
    : null;
  const draftWaiting = waitingOpen && !waitingEnded
    ? { waitingFor: waitingFor.trim() }
    : null;
  const waitingChanged =
    (draftWaiting?.waitingFor ?? null) !==
    (task.externalWait?.waitingFor?.trim() ?? null);
  const datesCanCoexist = draftWaiting !== null || task.repeatAfterDays !== null;
  const dateConflict =
    !datesCanCoexist && Boolean(scheduledDate) && Boolean(notBeforeDate);
  const dateFieldsValid = Object.values(validity).every(Boolean);
  const dirty =
    waitingChanged ||
    (nextAvailability?.notBeforeAt ?? null) !== (task.revisitAt ?? task.notBeforeAt) ||
    (scheduledDate || null) !== task.scheduledDate ||
    (dueDate || null) !== task.dueDate ||
    cleanedTitle !== task.title;

  const setFieldValidity = useCallback(
    (field: DateField) => (isValid: boolean) =>
      setValidity((current) =>
        current[field] === isValid ? current : { ...current, [field]: isValid },
      ),
    [],
  );
  const scheduledValidity = useMemo(() => setFieldValidity("scheduled"), [setFieldValidity]);
  const availabilityValidity = useMemo(
    () => setFieldValidity("availability"),
    [setFieldValidity],
  );
  const deadlineValidity = useMemo(() => setFieldValidity("deadline"), [setFieldValidity]);

  const setScheduled = useCallback(
    (date: string) => {
      setScheduledDate(date);
      setScheduledNotice(null);
      if (date && !datesCanCoexist && notBeforeDate) {
        setNotBeforeDate("");
        setNotBeforeTime("08:00");
        setAvailabilityNotice(strings.planningReplacedAvailability);
      } else if (date && !notBeforeDate) {
        setAvailabilityNotice(null);
      }
    },
    [datesCanCoexist, notBeforeDate, strings.planningReplacedAvailability],
  );
  const setAvailability = useCallback(
    (date: string, time = "00:00") => {
      setNotBeforeDate(date);
      setNotBeforeTime(time);
      setAvailabilityNotice(null);
      if (date && !datesCanCoexist && scheduledDate) {
        setScheduledDate("");
        setScheduledNotice(strings.planningReplacedScheduled);
      } else if (date && !scheduledDate) {
        setScheduledNotice(null);
      }
    },
    [datesCanCoexist, scheduledDate, strings.planningReplacedScheduled],
  );

  useLayoutEffect(() => {
    if (initialTarget === undefined) {
      setActiveTarget(undefined);
      const sheet = formRef.current?.closest<HTMLElement>(".sheet");
      if (sheet) sheet.scrollTop = 0;
      return;
    }
    setActiveTarget(initialTarget);
    if (initialTarget === "deadline") setDeadlineOpen(true);
    if (initialTarget === "waiting") setWaitingOpen(true);
    setPendingScroll(initialTarget);
  }, [initialTarget]);

  useLayoutEffect(() => {
    if (pendingScroll === null) return;
    const target = cardRefs[pendingScroll].current;
    if (!target || typeof target.scrollIntoView !== "function") {
      setPendingScroll(null);
      return;
    }
    target.scrollIntoView({ block: "nearest", behavior: "auto" });
    setPendingScroll(null);
  }, [pendingScroll, deadlineOpen, waitingOpen]);

  const acceptHint = (
    field: "scheduledDate" | "dueDate",
    hints: readonly TemporalCaptionHint[],
    key: string,
  ) => {
    const hint = hints.find((candidate) => candidate.key === key);
    if (!hint) return;
    setAcceptedHints((current) => ({ ...current, [field]: hint }));
    if (field === "scheduledDate") setScheduled(hint.date);
    else {
      setDueDate(hint.date);
      setValidity((current) => ({ ...current, deadline: true }));
    }
  };

  const labelFor = (hint: TemporalCaptionHint, field: "scheduledDate" | "dueDate") => {
    const date = formatExactLocalDate(hint.date, locale) ?? hint.date;
    return field === "scheduledDate"
      ? strings.titleHintSchedule(date)
      : strings.titleHintDeadline(date);
  };

  const commit = async () => {
    if (saving || !dateFieldsValid || !dirty) return;
    if (waitingChanged && draftWaiting !== null && !draftWaiting.waitingFor) {
      setWaitingError(strings.planningWaitingReasonRequired);
      return;
    }
    if (dateConflict) {
      setError(strings.planningWaitingConflict);
      return;
    }
    setSaving(true);
    setError(null);
    setWaitingError(null);
    try {
      const revisitAt =
        waitingChanged && draftWaiting === null && task.externalWait
          ? null
          : nextAvailability?.notBeforeAt ?? null;
      const externalWait = waitingChanged
        ? draftWaiting === null
          ? null
          : { waitingFor: draftWaiting.waitingFor }
        : undefined;
      const patch = {
        revisitAt,
        scheduledDate: scheduledDate || null,
        dueDate: dueDate || null,
        ...(externalWait !== undefined ? { externalWait } : {}),
        ...(cleanedTitle !== task.title ? { title: cleanedTitle } : {}),
      };
      const optimisticPatch = {
        ...patch,
        externalWait:
          externalWait === undefined
            ? task.externalWait
            : externalWait === null
              ? null
              : { waitingFor: externalWait.waitingFor, revisitDate: null },
      };
      await taskActions.update(task, patch, optimisticPatch, true);
      onClose();
    } catch (cause) {
      setError(localizedErrorMessage(cause, strings));
    } finally {
      setSaving(false);
    }
  };

  const waitingCardAction = () => {
    if (task.externalWait && !waitingEnded) {
      setWaitingEnded(true);
      setWaitingError(null);
      return;
    }
    if (task.externalWait && waitingEnded) {
      setWaitingEnded(false);
      setWaitingOpen(true);
      return;
    }
    setWaitingOpen(false);
    setWaitingFor("");
    setWaitingEnded(false);
    setWaitingError(null);
  };

  const cardClass = (target: TaskPlanningTarget) =>
    `task-planning-card${activeTarget === target ? " task-planning-card-active" : ""}`;

  return (
    <BottomSheet
      title={`${strings.planning}: ${task.title}`}
      initialFocus="dialog"
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      <form
        ref={formRef}
        className="stack task-planning-form"
        onSubmit={(event) => {
          event.preventDefault();
          void commit();
        }}
      >
        <div
          ref={cardRefs.scheduled}
          className={cardClass("scheduled")}
          onClick={() => setActiveTarget("scheduled")}
        >
          <h3>{strings.planningScheduledFor}</h3>
          <label htmlFor={`planning-scheduled-${task.id}`}>{strings.planningScheduledFor}</label>
          <HumanDateInput
            id={`planning-scheduled-${task.id}`}
            value={scheduledDate}
            onChange={(date) => setScheduled(date ?? "")}
            onValidityChange={scheduledValidity}
            disabled={saving}
          />
          <ScheduleShortcuts
            value={scheduledDate}
            onChange={(date) => setScheduled(date ?? "")}
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
          {scheduledNotice ? <p className="text-muted">{scheduledNotice}</p> : null}
        </div>

        <div
          ref={cardRefs.waiting}
          className={cardClass("waiting")}
          onClick={() => setActiveTarget("waiting")}
        >
          <h3>{strings.planningWaitingTitle}</h3>
          {!waitingOpen ? (
            <button
              type="button"
              className="btn btn-ghost"
              disabled={saving}
              onClick={() => {
                setWaitingOpen(true);
                setActiveTarget("waiting");
              }}
            >
              {strings.planningAddWaiting}
            </button>
          ) : waitingEnded ? (
            <>
              <p className="text-muted">{strings.planningWaitingWillEnd}</p>
              <button type="button" className="btn btn-sm" disabled={saving} onClick={waitingCardAction}>
                {strings.planningUndoWaiting}
              </button>
            </>
          ) : (
            <>
              <p className="text-muted">{strings.planningWaitingExplanation}</p>
              <label htmlFor={`planning-waiting-${task.id}`}>{strings.waitingFor}</label>
              <input
                id={`planning-waiting-${task.id}`}
                type="text"
                value={waitingFor}
                placeholder={strings.waitingForPlaceholder}
                disabled={saving}
                onChange={(event) => {
                  setWaitingFor(event.target.value);
                  setWaitingError(null);
                }}
              />
              {waitingError ? <div className="human-date-error" role="alert">{waitingError}</div> : null}
              <button type="button" className="btn btn-sm btn-ghost" disabled={saving} onClick={waitingCardAction}>
                {task.externalWait ? strings.planningEndWaiting : strings.planningRemoveWaiting}
              </button>
              {task.externalWait && !notBeforeDate ? (
                <div className="task-planning-inline-hint">
                  <span>{strings.planningNoRevisit}</span>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    disabled={saving}
                    onClick={() => {
                      setActiveTarget("availability");
                      setPendingScroll("availability");
                    }}
                  >
                    {strings.planningSetRevisit}
                  </button>
                </div>
              ) : null}
            </>
          )}
        </div>

        <div
          ref={cardRefs.availability}
          className={cardClass("availability")}
          onClick={() => setActiveTarget("availability")}
        >
          <h3>{strings.revisit}</h3>
          <p className="text-muted">
            {draftWaiting
              ? strings.planningAvailabilityExplanationWaiting
              : strings.planningAvailabilityExplanation}
          </p>
          <label htmlFor={`planning-availability-date-${task.id}`}>
            {strings.planningShowFrom}
          </label>
          <HumanDateInput
            id={`planning-availability-date-${task.id}`}
            value={notBeforeDate}
            onChange={(date) => setAvailability(date ?? "", notBeforeTime)}
            onValidityChange={availabilityValidity}
            disabled={saving}
          />
          <input
            id={`planning-availability-time-${task.id}`}
            type="time"
            value={notBeforeTime}
            onChange={(event) => setNotBeforeTime(event.target.value)}
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
                const date = localDateForInstant(instant);
                if (date) setAvailability(date, taskAvailabilityClock(instant) ?? "08:00");
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
                  const date = localDateForInstant(instant);
                  if (date) setAvailability(date, taskAvailabilityClock(instant) ?? "08:00");
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
                if (date) setAvailability(date, "00:00");
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
                if (date) setAvailability(date, "00:00");
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
              setNotBeforeDate("");
              setNotBeforeTime("08:00");
              setAvailabilityNotice(null);
              setScheduledNotice(null);
            }}
          >
            {strings.clearNotBefore}
          </button>
        </div>

        <div
          ref={cardRefs.deadline}
          className={cardClass("deadline")}
          onClick={() => setActiveTarget("deadline")}
        >
          <button
            type="button"
            className="task-planning-card-heading"
            onClick={() => setDeadlineOpen((current) => !current)}
          >
            <h3>{strings.planningDueBy}</h3>
            <span aria-hidden="true">{deadlineOpen ? "−" : "+"}</span>
          </button>
          {deadlineOpen ? (
            <>
              <label htmlFor={`planning-due-${task.id}`}>{strings.planningDueBy}</label>
              <HumanDateInput
                id={`planning-due-${task.id}`}
                value={dueDate}
                onChange={(date) => setDueDate(date ?? "")}
                onValidityChange={deadlineValidity}
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
          ) : null}
        </div>

        {error ? (
          <div className="task-row-error" role="alert">
            <span>{strings.error}</span>
            <span className="text-muted">{error}</span>
          </div>
        ) : null}

        <div className="row task-planning-actions">
          <button type="button" className="btn" disabled={saving} onClick={onClose}>
            {strings.cancel}
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={saving || !dateFieldsValid || !dirty}
          >
            {strings.save}
          </button>
        </div>
      </form>
    </BottomSheet>
  );
}
