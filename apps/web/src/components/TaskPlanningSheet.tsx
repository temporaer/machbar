import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Task, TaskReminderInput } from "@machbar/shared";
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
import { formatReminderLabel } from "../lib/reminderLabels";
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
import { refreshTaskAfterConflict } from "../lib/taskMutations";
import { BottomSheet } from "./BottomSheet";
import { CaptionHintSuggestions } from "./CaptionHintSuggestions";
import { ScheduleShortcuts } from "./ScheduleShortcuts";
import { HumanDateInput } from "./HumanDateInput";
import { ProjectActivationDecisionFields } from "./ProjectActivationDecisionFields";
import { TaskRemindersEditor, type TaskRemindersEditorHandle } from "./TaskRemindersEditor";
import {
  refreshProjectActivationPrompt,
  projectActivationResolutionFromPrompt,
  type ProjectActivationPrompt,
} from "../lib/projectActivationResolution";

type DateField = "scheduled" | "availability" | "deadline";
type DateValidity = Record<DateField, boolean>;
type PendingScrollTarget = TaskPlanningTarget | "top" | null;
type PlanningConflictField = "scheduledDate" | "dueDate" | "revisitAt" | "recurrence" | "reminders" | "externalWait" | "title";
interface PlanningConflict {
  field: PlanningConflictField;
  label: string;
  currentValue: string;
  draftValue: string;
}

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
  const waitingCardRef = useRef<HTMLElement>(null);
  const deadlineCardRef = useRef<HTMLElement>(null);
  const reminderCardRef = useRef<HTMLElement>(null);
  const recurrenceCardRef = useRef<HTMLDivElement>(null);
  const planningFormRef = useRef<HTMLFormElement>(null);
  const reminderEditorRef = useRef<TaskRemindersEditorHandle>(null);
  const [baselineTask, setBaselineTask] = useState(task);
  const [planningConflicts, setPlanningConflicts] = useState<PlanningConflict[]>([]);
  const [reminderDraftPending, setReminderDraftPending] = useState(false);
  const [pendingScrollTarget, setPendingScrollTarget] =
    useState<PendingScrollTarget>(null);
  const initialAvailabilityDate = baselineTask.revisitAt
    ? calendarDateForInstant(baselineTask.revisitAt, householdTimezone) ?? ""
    : "";
  const [notBeforeDate, setNotBeforeDate] = useState(initialAvailabilityDate);
  const [notBeforeTime, setNotBeforeTime] = useState(
    taskAvailabilityClock(baselineTask.revisitAt, householdTimezone) ?? "06:00",
  );
  const [availabilityEdited, setAvailabilityEdited] = useState(false);
  const [scheduledDate, setScheduledDate] = useState(baselineTask.scheduledDate ?? "");
  const [dueDate, setDueDate] = useState(baselineTask.dueDate ?? "");
  const [repeatAfterDays, setRepeatAfterDays] = useState<number | null>(baselineTask.repeatAfterDays);
  const [allowedDeviationDays, setAllowedDeviationDays] = useState<number | null>(baselineTask.allowedDeviationDays);
  const [reminders, setReminders] = useState<TaskReminderInput[]>(() => baselineTask.reminders);
  const [activationState, setActivationState] = useState<{ fingerprint: string; prompt: ProjectActivationPrompt } | null>(null);
  const [expectedTaskRevision, setExpectedTaskRevision] = useState(baselineTask.revision);
  const hasExistingWait = baselineTask.externalWait !== null;
  const canAddWaiting =
    baselineTask.kind === "action" &&
    baselineTask.status === "actionable" &&
    repeatAfterDays === null;
  const initialWaitingFor = baselineTask.externalWait?.waitingFor ?? "";
  const [waitingOpen, setWaitingOpen] = useState(
    hasExistingWait ||
      (initialTarget === "waiting" &&
        baselineTask.kind === "action" &&
        baselineTask.status === "actionable" &&
        baselineTask.repeatAfterDays === null),
  );
  const [waitingFor, setWaitingFor] = useState(initialWaitingFor);
  const [waitingEnded, setWaitingEnded] = useState(false);
  const [endedWaitingSnapshot, setEndedWaitingSnapshot] = useState<{
    waitingFor: string;
    revisitAt: string | null;
    availabilityEdited: boolean;
  } | null>(null);
  const [deadlineOpen, setDeadlineOpen] = useState(
    Boolean(baselineTask.dueDate) || initialTarget === "deadline",
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
  const [waitingError, setWaitingError] = useState<string | null>(null);
  const [acceptedHints, setAcceptedHints] = useState<
    Partial<Record<"scheduledDate" | "dueDate", TemporalCaptionHint>>
  >({});

  useLayoutEffect(() => {
    setActiveTarget(initialTarget);
    if (initialTarget === "deadline") {
      setDeadlineOpen(true);
    }
    if (
      initialTarget === "waiting" &&
      (hasExistingWait ||
        (baselineTask.kind === "action" &&
          baselineTask.status === "actionable" &&
          baselineTask.repeatAfterDays === null))
    ) {
      setWaitingOpen(true);
    }
    setPendingScrollTarget(initialTarget ?? "top");
  }, [initialTarget]);

  useEffect(() => setExpectedTaskRevision(baselineTask.revision), [baselineTask.revision]);

  useLayoutEffect(() => {
    const pendingTarget = pendingScrollTarget;
    if (pendingTarget === null) return;
    if (pendingTarget === "deadline" && !deadlineOpen) return;
    if (pendingTarget === "waiting" && canAddWaiting && !waitingOpen) return;
    setPendingScrollTarget(null);

    if (pendingTarget === "top") {
      const sheet = planningFormRef.current?.closest<HTMLElement>(".sheet");
      if (sheet) sheet.scrollTop = 0;
      return;
    }

    const target =
      pendingTarget === "scheduled"
        ? scheduledCardRef.current
        : pendingTarget === "waiting"
          ? waitingCardRef.current
          : pendingTarget === "availability"
            ? availabilityCardRef.current
            : pendingTarget === "deadline"
              ? deadlineCardRef.current
              : pendingTarget === "reminders"
                ? reminderCardRef.current
                : recurrenceCardRef.current;
    if (target && typeof target.scrollIntoView === "function") {
      target.scrollIntoView({ block: "nearest", behavior: "auto" });
    }
  }, [
    activeTarget,
    canAddWaiting,
    deadlineOpen,
    hasExistingWait,
    initialTarget,
    pendingScrollTarget,
    baselineTask.kind,
    baselineTask.repeatAfterDays,
    baselineTask.status,
    waitingOpen,
  ]);

  useEffect(() => {
    if (availabilityEdited) return;
    setNotBeforeDate(
      baselineTask.revisitAt
        ? calendarDateForInstant(baselineTask.revisitAt, householdTimezone) ?? ""
        : "",
    );
    setNotBeforeTime(
      taskAvailabilityClock(baselineTask.revisitAt, householdTimezone) ?? "06:00",
    );
  }, [availabilityEdited, householdTimezone, baselineTask.revisitAt]);

  const temporalHints = useMemo(
    () =>
      extractCaptionHints(baselineTask.title, {
        locale,
        referenceDate: new Date(baselineTask.createdAt),
      }).filter((hint): hint is TemporalCaptionHint => hint.kind === "temporal"),
    [locale, baselineTask.createdAt, baselineTask.title],
  );
  const scheduleHints = strongestCaptionHints(
    temporalHints.filter((hint) => hint.semantic === "scheduledDate"),
  );
  const deadlineHints = strongestCaptionHints(
    temporalHints.filter((hint) => hint.semantic === "dueDate"),
  );
  const cleanedTitle = removeCaptionHintSpans(
    baselineTask.title,
    Object.values(acceptedHints).flatMap((hint) => (hint ? [hint.removalSpan] : [])),
  );
  const draftFingerprint = JSON.stringify({
    scheduledDate,
    dueDate,
    notBeforeDate,
    notBeforeTime,
    availabilityEdited,
    waitingFor,
    waitingEnded,
    repeatAfterDays,
    allowedDeviationDays,
    reminders,
    cleanedTitle,
  });
  const activationPrompt = activationState?.fingerprint === draftFingerprint
    ? activationState.prompt
    : null;
  const activationDecisionReady = activationPrompt === null ||
    projectActivationResolutionFromPrompt(activationPrompt) !== null;
  const nextAvailability = notBeforeDate
    ? taskAvailabilityForLocalDate(
        notBeforeDate,
        notBeforeTime,
        householdTimezone,
      )
    : null;
  const invalidRevisitSelection =
    availabilityEdited && Boolean(notBeforeDate) && nextAvailability === null;
  const newWaitingActive =
    !hasExistingWait && !waitingEnded && waitingFor.trim().length > 0;
  const waitingDraftActive =
    hasExistingWait && !waitingEnded ? true : newWaitingActive;
  const invalidClearedExistingReason =
    hasExistingWait &&
    !waitingEnded &&
    initialWaitingFor.trim().length > 0 &&
    waitingFor.trim().length === 0;
  const recurrenceEnabled = repeatAfterDays !== null && allowedDeviationDays !== null;
  const recurrenceChanged =
    repeatAfterDays !== baselineTask.repeatAfterDays ||
    allowedDeviationDays !== baselineTask.allowedDeviationDays;
  const remindersChanged = JSON.stringify(reminders) !== JSON.stringify(baselineTask.reminders);
  const recurrenceDeadline = recurrenceEnabled && scheduledDate
    ? addIsoCalendarDays(scheduledDate, allowedDeviationDays)
    : null;
  const recurrenceInvalid = recurrenceEnabled && (
    !scheduledDate ||
    !Number.isInteger(repeatAfterDays) || repeatAfterDays! < 1 ||
    !Number.isInteger(allowedDeviationDays) || allowedDeviationDays! < 0
  );
  const householdToday =
    calendarDateForInstant(new Date().toISOString(), householdTimezone) ??
    toIsoCalendarDate(new Date());
  const revisitAtForCommit = availabilityEdited
    ? nextAvailability?.notBeforeAt ?? null
    : baselineTask.revisitAt;
  const scheduledChanged = (scheduledDate || null) !== baselineTask.scheduledDate;
  const revisitChanged = revisitAtForCommit !== baselineTask.revisitAt;
  const deadlineChanged = !recurrenceEnabled && (dueDate || null) !== baselineTask.dueDate;
  const waitingChangedFromBaseline = waitingEnded ||
    (hasExistingWait
      ? waitingFor.trim() !== (baselineTask.externalWait?.waitingFor ?? "").trim()
      : newWaitingActive);
  const titleChanged = cleanedTitle !== baselineTask.title;
  const canMutuallyExclude = !waitingDraftActive && repeatAfterDays === null;
  const dateConflict =
    canMutuallyExclude && Boolean(scheduledDate) && Boolean(notBeforeDate);
  const dirty =
    waitingChangedFromBaseline ||
    revisitChanged ||
    scheduledChanged ||
    deadlineChanged ||
    recurrenceChanged ||
    remindersChanged ||
    reminderDraftPending ||
    titleChanged;
  const allValid =
    validity.scheduled && validity.availability && validity.deadline && !recurrenceInvalid;
  const matchesAvailability = (instant: string | null) =>
    Boolean(
      timezoneLoaded &&
      validity.availability &&
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

  const endWaitingLocally = () => {
    if (!hasExistingWait || waitingEnded) return;
    setEndedWaitingSnapshot({
      waitingFor,
      revisitAt: revisitAtForCommit,
      availabilityEdited,
    });
    setWaitingEnded(true);
    setWaitingError(null);
    setAvailabilityEdited(true);
    setNotBeforeDate("");
    setNotBeforeTime("06:00");
    setValidity((current) => ({ ...current, availability: true }));
  };

  const undoWaitingEnd = () => {
    if (!waitingEnded) return;
    setWaitingEnded(false);
    setWaitingFor(endedWaitingSnapshot?.waitingFor ?? initialWaitingFor);
    if (endedWaitingSnapshot?.revisitAt) {
      setNotBeforeDate(
        calendarDateForInstant(endedWaitingSnapshot.revisitAt, householdTimezone) ?? "",
      );
      setNotBeforeTime(
        taskAvailabilityClock(endedWaitingSnapshot.revisitAt, householdTimezone) ?? "06:00",
      );
    }
    setAvailabilityEdited(endedWaitingSnapshot?.availabilityEdited ?? false);
    setEndedWaitingSnapshot(null);
    setWaitingError(null);
  };

  const removeNewWaiting = () => {
    setWaitingFor("");
    setWaitingOpen(false);
    setWaitingError(null);
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
    if (
      saving ||
      !allValid ||
      invalidRevisitSelection ||
      dateConflict
    )
      return;
    if (invalidClearedExistingReason) {
      setWaitingError(strings.planningWaitingReasonRequired);
      return;
    }
    const plannedReminders = reminderEditorRef.current?.getCommitValue();
    if (plannedReminders === null || plannedReminders === undefined) {
      setError(strings.invalidDate);
      return;
    }
    const nextRemindersChanged = JSON.stringify(plannedReminders) !== JSON.stringify(baselineTask.reminders);
    const priorBaseline = baselineTask;
    setSaving(true);
    setError(null);
    try {
      const externalWait = waitingEnded
        ? null
        : waitingChangedFromBaseline
          ? newWaitingActive || hasExistingWait
            ? { waitingFor: waitingFor.trim() }
            : null
          : undefined;
      const patch = {
        ...(revisitChanged ? { revisitAt: revisitAtForCommit } : {}),
        ...(scheduledChanged ? { scheduledDate: scheduledDate || null } : {}),
        ...(!recurrenceEnabled && deadlineChanged ? { dueDate: dueDate || null } : {}),
        ...(recurrenceChanged ? { repeatAfterDays, allowedDeviationDays } : {}),
        ...(nextRemindersChanged ? { reminders: plannedReminders } : {}),
        ...(externalWait !== undefined ? { externalWait } : {}),
        ...(titleChanged ? { title: cleanedTitle } : {}),
      };
      const activationResolution = activationPrompt
        ? projectActivationResolutionFromPrompt(activationPrompt)
        : null;
      if (activationPrompt && !activationResolution) {
        setError(strings.commitmentResolutionHint);
        return;
      }
      const apiPatch = activationResolution ? { ...patch, activationResolution } : patch;
      const { reminders: _draftReminders, ...optimisticPatchBase } = patch;
      const optimisticPatch = {
        ...optimisticPatchBase,
        ...(nextRemindersChanged ? { reminders: baselineTask.reminders } : {}),
        ...(recurrenceEnabled && (recurrenceChanged || scheduledChanged) && recurrenceDeadline !== null ? { dueDate: recurrenceDeadline } : {}),
        ...(externalWait !== undefined
          ? {
              externalWait:
                externalWait === null
                  ? null
                  : { waitingFor: externalWait.waitingFor, revisitDate: null },
            }
          : {}),
      };
      await taskActions.update(
        { ...baselineTask, revision: expectedTaskRevision },
        apiPatch,
        optimisticPatch,
        true,
      );
      onClose();
    } catch (cause) {
      const latestTask = await refreshTaskAfterConflict(cause, baselineTask.id);
      if (latestTask !== null) {
        const conflicts: PlanningConflict[] = [];
        const addConflict = (
          field: PlanningConflictField,
          label: string,
          latestValue: string | null,
          proposedValue: string | null,
        ) => conflicts.push({
          field,
          label,
          currentValue: latestValue || "—",
          draftValue: proposedValue || "—",
        });
        const displayDate = (value: string | null) => value
          ? formatExactLocalDate(value, locale) ?? value
          : null;
        const displayRevisit = (value: string | null) => value
          ? formatRevisitAt(value, locale, householdTimezone) ?? value
          : null;
        const displayRecurrence = (interval: number | null, deviation: number | null) =>
          interval === null || deviation === null
            ? null
            : `${strings.repeatAfterDays}: ${interval}; ${strings.allowedDeviationDays}: ${deviation}`;
        const displayReminders = (items: TaskReminderInput[], deadline: string | null) =>
          items.length === 0
            ? null
            : items.map((item) => formatReminderLabel(item, deadline, strings, locale)).join(", ");
        const changedOnServer = (field: PlanningConflictField) => {
          switch (field) {
            case "scheduledDate": return latestTask.scheduledDate !== priorBaseline.scheduledDate;
            case "dueDate": return latestTask.dueDate !== priorBaseline.dueDate;
            case "revisitAt": return latestTask.revisitAt !== priorBaseline.revisitAt;
            case "recurrence":
              return latestTask.repeatAfterDays !== priorBaseline.repeatAfterDays ||
                latestTask.allowedDeviationDays !== priorBaseline.allowedDeviationDays;
            case "reminders": return JSON.stringify(latestTask.reminders) !== JSON.stringify(priorBaseline.reminders);
            case "externalWait": return JSON.stringify(latestTask.externalWait) !== JSON.stringify(priorBaseline.externalWait);
            case "title": return latestTask.title !== priorBaseline.title;
          }
        };
        if (scheduledChanged && changedOnServer("scheduledDate")) {
          addConflict("scheduledDate", strings.planningScheduledFor, displayDate(latestTask.scheduledDate), displayDate(scheduledDate || null));
        }
        if (deadlineChanged && changedOnServer("dueDate")) {
          addConflict("dueDate", strings.planningDueBy, displayDate(latestTask.dueDate), displayDate(dueDate || null));
        }
        if (revisitChanged && changedOnServer("revisitAt")) {
          addConflict("revisitAt", strings.planningShowFrom, displayRevisit(latestTask.revisitAt), displayRevisit(revisitAtForCommit));
        }
        if (recurrenceChanged && changedOnServer("recurrence")) {
          addConflict("recurrence", strings.recurrence,
            displayRecurrence(latestTask.repeatAfterDays, latestTask.allowedDeviationDays),
            displayRecurrence(repeatAfterDays, allowedDeviationDays));
        }
        if (nextRemindersChanged && changedOnServer("reminders")) {
          addConflict("reminders", strings.reminders,
            displayReminders(latestTask.reminders, latestTask.dueDate),
            displayReminders(plannedReminders, recurrenceEnabled ? recurrenceDeadline : dueDate || null));
        }
        if (waitingChangedFromBaseline && changedOnServer("externalWait")) {
          addConflict("externalWait", strings.planningWaitingTitle,
            latestTask.externalWait?.waitingFor ?? null,
            waitingEnded ? null : waitingFor.trim() || null);
        }
        if (titleChanged && changedOnServer("title")) {
          addConflict("title", strings.title, latestTask.title, cleanedTitle);
        }

        setExpectedTaskRevision(latestTask.revision);
        setBaselineTask(latestTask);
        if (!scheduledChanged) setScheduledDate(latestTask.scheduledDate ?? "");
        if (!deadlineChanged && !recurrenceEnabled) setDueDate(latestTask.dueDate ?? "");
        if (!recurrenceChanged) {
          setRepeatAfterDays(latestTask.repeatAfterDays);
          setAllowedDeviationDays(latestTask.allowedDeviationDays);
        }
        if (!revisitChanged) {
          setAvailabilityEdited(false);
          setNotBeforeDate(latestTask.revisitAt
            ? calendarDateForInstant(latestTask.revisitAt, householdTimezone) ?? ""
            : "");
          setNotBeforeTime(taskAvailabilityClock(latestTask.revisitAt, householdTimezone) ?? "06:00");
        }
        setReminders(nextRemindersChanged ? plannedReminders : latestTask.reminders);
        setReminderDraftPending(false);
        if (!waitingChangedFromBaseline) {
          setWaitingFor(latestTask.externalWait?.waitingFor ?? "");
          setWaitingEnded(false);
          setWaitingOpen(latestTask.externalWait !== null);
        }
        if (!titleChanged) setAcceptedHints({});
        setPlanningConflicts(conflicts);
        setActivationState(null);
      }
      const prompt = baselineTask.projectId === null
        ? null
        : await refreshProjectActivationPrompt(cause, baselineTask.projectId, activationPrompt);
      if (prompt) setActivationState({ fingerprint: draftFingerprint, prompt });
      setError(localizedErrorMessage(cause, strings));
    } finally {
      setSaving(false);
    }
  };

  const resolvePlanningConflict = (conflict: PlanningConflict, keepDraft: boolean) => {
    if (!keepDraft) {
      switch (conflict.field) {
        case "scheduledDate":
          setScheduledDate(baselineTask.scheduledDate ?? "");
          break;
        case "dueDate":
          setDueDate(baselineTask.dueDate ?? "");
          setDeadlineOpen(Boolean(baselineTask.dueDate));
          break;
        case "revisitAt":
          setAvailabilityEdited(false);
          setNotBeforeDate(baselineTask.revisitAt
            ? calendarDateForInstant(baselineTask.revisitAt, householdTimezone) ?? ""
            : "");
          setNotBeforeTime(taskAvailabilityClock(baselineTask.revisitAt, householdTimezone) ?? "06:00");
          break;
        case "recurrence":
          setRepeatAfterDays(baselineTask.repeatAfterDays);
          setAllowedDeviationDays(baselineTask.allowedDeviationDays);
          break;
        case "reminders":
          setReminders(baselineTask.reminders);
          setReminderDraftPending(false);
          break;
        case "externalWait":
          setWaitingFor(baselineTask.externalWait?.waitingFor ?? "");
          setWaitingEnded(false);
          setWaitingOpen(baselineTask.externalWait !== null);
          setWaitingError(null);
          break;
        case "title":
          setAcceptedHints({});
          break;
      }
    }
    setPlanningConflicts((current) => current.filter((entry) => entry.field !== conflict.field));
    setError(null);
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
      <p className="task-planning-title">{baselineTask.title}</p>
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
          className={cardClass(activeTarget === "scheduled" || activeTarget === "recurrence")}
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
            id={`planning-scheduled-${baselineTask.id}`}
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
          <div
            ref={recurrenceCardRef}
            className="task-planning-recurrence"
            onPointerDownCapture={() => setActiveTarget("recurrence")}
            onFocusCapture={() => setActiveTarget("recurrence")}
          >
            <label className="recurrence-toggle">
              <input
                type="checkbox"
                checked={recurrenceEnabled}
                disabled={saving || hasExistingWait || waitingDraftActive}
                onChange={(event) => {
                  setRepeatAfterDays(event.target.checked ? 7 : null);
                  setAllowedDeviationDays(event.target.checked ? 0 : null);
                }}
              />
              <span>{strings.recurrence}</span>
            </label>
            {recurrenceEnabled ? (
              <>
                <p className="text-muted">{strings.recurrenceHint}</p>
                <div className="recurrence-number-grid">
                  <label className="field">
                    <span>{strings.repeatAfterDays}</span>
                    <input
                      type="number"
                      inputMode="numeric"
                      min={1}
                      step={1}
                      value={repeatAfterDays}
                      disabled={saving}
                      onChange={(event) => setRepeatAfterDays(Number(event.target.value))}
                    />
                  </label>
                  <label className="field">
                    <span>{strings.allowedDeviationDays}</span>
                    <input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      step={1}
                      value={allowedDeviationDays}
                      disabled={saving}
                      onChange={(event) => setAllowedDeviationDays(Number(event.target.value))}
                    />
                  </label>
                </div>
                {recurrenceInvalid ? (
                  <p className="human-date-error" role="alert">{strings.recurrenceScheduleRequired}</p>
                ) : null}
                {recurrenceDeadline ? (
                  <p className="recurrence-preview">
                    {strings.recurrenceDeadlinePreview(
                      formatExactLocalDate(recurrenceDeadline, locale) ?? recurrenceDeadline,
                    )}
                  </p>
                ) : null}
              </>
            ) : null}
          </div>
          {scheduledNotice ? (
            <p className="task-planning-replacement-note" role="status">
              {scheduledNotice}
            </p>
          ) : null}
        </section>

        <section
          ref={waitingCardRef}
          className={cardClass(activeTarget === "waiting")}
          onPointerDownCapture={() => setActiveTarget("waiting")}
          onFocusCapture={() => setActiveTarget("waiting")}
        >
          <div className="task-planning-card-header">
            <div>
              <h3>{strings.planningWaitingTitle}</h3>
              {waitingOpen && !waitingEnded ? (
                <p>{strings.planningWaitingExplanation}</p>
              ) : null}
            </div>
          </div>
          {!waitingOpen ? (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={saving || !canAddWaiting}
              onClick={() => {
                setWaitingOpen(true);
                setActiveTarget("waiting");
              }}
            >
              {strings.planningAddWaiting}
            </button>
          ) : waitingEnded ? (
            <>
              <p className="text-muted">{strings.planningWaitingWillEnd}.</p>
              {baselineTask.revisitAt ? (
                <p className="text-muted">{strings.planningRevisitWillBeRemoved}</p>
              ) : null}
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={saving}
                onClick={undoWaitingEnd}
              >
                {strings.planningUndoWaiting}
              </button>
            </>
          ) : (
            <>
              <label htmlFor={`planning-waiting-${baselineTask.id}`}>
                {strings.waitingFor}
              </label>
              <input
                id={`planning-waiting-${baselineTask.id}`}
                type="text"
                value={waitingFor}
                placeholder={strings.waitingForPlaceholder}
                disabled={saving}
                onChange={(event) => {
                  setWaitingFor(event.target.value);
                  setWaitingError(null);
                }}
              />
              {waitingError ? (
                <div className="human-date-error" role="alert">
                  {waitingError}
                </div>
              ) : null}
              {hasExistingWait ? (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  disabled={saving}
                  onClick={endWaitingLocally}
                >
                  {strings.planningEndWaiting}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  disabled={saving}
                  onClick={removeNewWaiting}
                >
                  {strings.planningRemoveWaiting}
                </button>
              )}
              {waitingDraftActive && !notBeforeDate ? (
                <div className="task-planning-inline-hint">
                  <span>{strings.planningNoRevisit}</span>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    disabled={saving}
                    onPointerDownCapture={() => setActiveTarget("availability")}
                    onFocusCapture={() => setActiveTarget("availability")}
                    onClick={() => {
                      setActiveTarget("availability");
                      setPendingScrollTarget("availability");
                    }}
                  >
                    {strings.planningSetRevisit}
                  </button>
                </div>
              ) : null}
            </>
          )}
          {dateConflict ? (
            <p className="human-date-error" role="alert">
              {strings.planningWaitingConflictWithoutWait}
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
                {waitingDraftActive
                  ? strings.planningAvailabilityExternalExplanation
                  : strings.planningAvailabilityExplanation}
              </p>
            </div>
            {notBeforeDate ? (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                aria-label={strings.removeRevisitDate}
                disabled={saving || !timezoneLoaded || waitingEnded}
                onClick={removeAvailability}
              >
                {strings.remove}
              </button>
            ) : null}
          </div>
          <div className="task-planning-datetime">
            <div className="task-planning-date">
              <label htmlFor={`planning-availability-date-${baselineTask.id}`}>
                {strings.date}
              </label>
              <HumanDateInput
                id={`planning-availability-date-${baselineTask.id}`}
                value={notBeforeDate}
                onChange={(date) => setRevisitDate(date ?? "")}
                onValidityChange={setAvailabilityValidity}
                disabled={saving || !timezoneLoaded || waitingEnded}
              />
            </div>
            <div className="task-planning-time">
              <label htmlFor={`planning-availability-time-${baselineTask.id}`}>
                {strings.time}
              </label>
              <input
                id={`planning-availability-time-${baselineTask.id}`}
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
              disabled={saving || !timezoneLoaded || waitingEnded}
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
                disabled={saving || !timezoneLoaded || waitingEnded}
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
              disabled={saving || !timezoneLoaded || waitingEnded}
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
              disabled={saving || !timezoneLoaded || waitingEnded}
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
          {waitingEnded ? (
            <p className="text-muted">{strings.planningUndoWaitingToSetRevisit}</p>
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
            {dueDate && !recurrenceEnabled ? (
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
          {recurrenceEnabled ? (
            <p className="recurrence-derived-hint">
              {recurrenceDeadline
                ? strings.recurrenceDeadlinePreview(formatExactLocalDate(recurrenceDeadline, locale) ?? recurrenceDeadline)
                : strings.recurrenceScheduleRequired}
            </p>
          ) : !deadlineOpen ? (
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
                id={`planning-due-${baselineTask.id}`}
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

        {planningConflicts.length > 0 ? (
          <section className="card stack task-planning-conflicts" aria-label={strings.planningConcurrentChanges}>
            <p>{strings.planningConcurrentChanges}</p>
            {planningConflicts.map((conflict) => (
              <div key={conflict.field} className="task-planning-conflict">
                <h3>{conflict.label}</h3>
                <p><strong>{strings.planningConflictCurrent}:</strong> {conflict.currentValue}</p>
                <p><strong>{strings.planningConflictDraft}:</strong> {conflict.draftValue}</p>
                <div className="row">
                  <button type="button" className="btn btn-sm" onClick={() => resolvePlanningConflict(conflict, false)}>
                    {strings.planningConflictUseCurrent}
                  </button>
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => resolvePlanningConflict(conflict, true)}>
                    {strings.planningConflictKeepMine}
                  </button>
                </div>
              </div>
            ))}
          </section>
        ) : null}

        <section
          ref={reminderCardRef}
          className={cardClass(activeTarget === "reminders")}
          {...cardEvents("reminders")}
        >
          <div className="task-planning-card-header">
            <div><h3>{strings.reminders}</h3></div>
          </div>
          <TaskRemindersEditor
            key={baselineTask.revision}
            ref={reminderEditorRef}
            reminders={reminders}
            dueDate={recurrenceEnabled ? recurrenceDeadline : dueDate || null}
            onChange={setReminders}
            onPendingChange={setReminderDraftPending}
            disabled={saving}
            autoOpen={initialTarget === "reminders"}
          />
        </section>

        {activationPrompt ? (
          <ProjectActivationDecisionFields
            prompt={activationPrompt}
            disabled={saving}
            onChange={(prompt) => setActivationState({ fingerprint: draftFingerprint, prompt })}
          />
        ) : null}

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
            disabled={
              saving ||
              !allValid ||
              invalidRevisitSelection ||
              dateConflict ||
              recurrenceInvalid ||
              planningConflicts.length > 0 ||
              !activationDecisionReady ||
              !dirty
            }
          >
            {strings.save}
          </button>
        </div>
      </form>
    </BottomSheet>
  );
}
