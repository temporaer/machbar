import type { TaskReminderInput } from "./index.js";
import type { CleanupRoundAiResponse, CleanupRoundAnalyzePayload } from "./cleanupRound.js";
import {
  isAbsentOwnerSuggestion,
  normalizeIntakeNullableAbsenceFields,
  resolveOwnerSuggestion,
} from "./inputNormalization.js";

import { Temporal } from "@js-temporal/polyfill";

export const INTAKE_TIMEZONE = "Europe/Berlin" as const;
export const INTAKE_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const INTAKE_MAX_CALENDAR_EVENTS = 20;
export const INTAKE_MAX_WORK_ITEMS = 50;
export const INTAKE_MAX_WARNINGS = 20;

export type IntakeWorkItemKind = "action" | "project" | "reference";

export interface IntakeCalendarEvent {
  key: string;
  title: string;
  description: string | null;
  location: string | null;
  allDay: boolean;
  startDate: string | null;
  endDate: string | null;
  startDateTime: string | null;
  endDateTime: string | null;
  relatedWorkKeys: string[];
}

interface TimestampParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  fraction: string;
}

const timestampPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(\.\d+)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/;

function timestampParts(value: string): {
  parts: TimestampParts;
  zone: string | null;
} | null {
  const match = timestampPattern.exec(value);
  if (!match) return null;
  const parts: TimestampParts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? "0"),
    fraction: match[7] ?? "",
  };
  if (
    !validDate(`${match[1]}-${match[2]}-${match[3]}`) ||
    parts.hour > 23 ||
    parts.minute > 59 ||
    parts.second > 59
  ) return null;
  return { parts, zone: match[8] ?? null };
}

/**
 * Normalize the timestamp shapes commonly emitted by imperfect providers.
 * Local wall-clock values use Temporal's timezone database and reject DST
 * gaps/overlaps instead of silently choosing an instant.
 */
export function normalizeIntakeTimestamp(
  value: string,
  timezone: string = INTAKE_TIMEZONE,
): IntakeTimestampNormalization {
  const parsed = timestampParts(value);
  if (!parsed) return { value, status: "invalid", timezoneInferred: false };
  const { parts, zone } = parsed;
  const seconds = `:${String(parts.second).padStart(2, "0")}${parts.fraction}`;
  const localPrefix = `${value.slice(0, 16)}${seconds}`;
  if (zone !== null) {
    const normalized = `${localPrefix}${zone}`;
    return !Number.isNaN(Date.parse(normalized))
      ? { value: normalized, status: normalized === value ? "unchanged" : "normalized", timezoneInferred: false }
      : { value, status: "invalid", timezoneInferred: false };
  }
  if (!validTimezone(timezone)) return { value, status: "invalid", timezoneInferred: false };
  const fractionDigits = parts.fraction.slice(1);
  const localFields = {
    timeZone: timezone,
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
    millisecond: Number(fractionDigits.padEnd(3, "0").slice(0, 3) || "0"),
    microsecond: Number(fractionDigits.padEnd(6, "0").slice(3, 6) || "0"),
    nanosecond: Number(fractionDigits.padEnd(9, "0").slice(6, 9) || "0"),
  };
  try {
    const candidate = Temporal.ZonedDateTime.from(localFields, {
      disambiguation: "reject",
    });
    return {
      value: `${localPrefix}${candidate.offset}`,
      status: "normalized",
      timezoneInferred: true,
    };
  } catch {
    const localDateTime = Temporal.PlainDateTime.from(localFields);
    const earlier = Temporal.ZonedDateTime.from(localFields, { disambiguation: "earlier" });
    const later = Temporal.ZonedDateTime.from(localFields, { disambiguation: "later" });
    const isAmbiguous =
      earlier.toPlainDateTime().equals(localDateTime) &&
      later.toPlainDateTime().equals(localDateTime);
    return {
      value,
      status: isAmbiguous ? "ambiguous" : "nonexistent",
      timezoneInferred: true,
    };
  }
}

export interface IntakeWorkItem {
  key: string;
  kind: IntakeWorkItemKind;
  title: string;
  notes: string | null;
  parentKey: string | null;
  ownerName: string | null;
  dueDate: string | null;
  scheduledDate: string | null;
  notBeforeDate: string | null;
  notBeforeAt: string | null;
  reminders: TaskReminderInput[];
  needsClarification: boolean;
  relatedCalendarKeys: string[];
}

export interface IntakeWarning {
  message: string;
}

export interface IntakePlan {
  summary: string;
  calendarEvents: IntakeCalendarEvent[];
  workItems: IntakeWorkItem[];
  warnings: IntakeWarning[];
}

export { isAbsentOwnerSuggestion, normalizeIntakeNullableAbsenceFields, resolveOwnerSuggestion };

export interface IntakeDraftCalendarEvent extends IntakeCalendarEvent {
  enabled: boolean;
  durationAssumed: boolean;
}

export interface IntakeDraftWorkItem
  extends Omit<IntakeWorkItem, "ownerName"> {
  enabled: boolean;
  ownerMemberId: number | null;
}

export interface IntakeDraft {
  summary: string;
  calendarEvents: IntakeDraftCalendarEvent[];
  workItems: IntakeDraftWorkItem[];
  warnings: IntakeWarning[];
  retainSourceInPaperless: boolean;
}

export type IntakeIssueCode =
  | "key_invalid"
  | "duplicate_key"
  | "invalid_date"
  | "invalid_datetime"
  | "invalid_reminder_time"
  | "invalid_reminder_timezone"
  | "calendar_date_conflict"
  | "calendar_datetime_conflict"
  | "calendar_start_required"
  | "calendar_end_before_start"
  | "timed_end_before_start"
  | "not_before_pair"
  | "not_before_date_mismatch"
  | "project_field_not_allowed"
  | "reference_field_not_allowed"
  | "invalid_parent"
  | "self_parent"
  | "parent_cycle"
  | "dangling_parent"
  | "dangling_related_key"
  | "duplicate_related_key"
  | "scheduling_order"
  | "deadline_relative_without_due"
  | "captured_reminder"
  | "timed_end_required"
  | "parent_disabled"
  | "owner_not_member"
  | "reference_owner"
  | "paperless_unavailable"
  | "nothing_selected"
  | "schema_invalid";

const intakeIssueCodes = new Set<IntakeIssueCode>([
  "key_invalid",
  "duplicate_key",
  "invalid_date",
  "invalid_datetime",
  "invalid_reminder_time",
  "invalid_reminder_timezone",
  "calendar_date_conflict",
  "calendar_datetime_conflict",
  "calendar_start_required",
  "calendar_end_before_start",
  "timed_end_before_start",
  "not_before_pair",
  "not_before_date_mismatch",
  "project_field_not_allowed",
  "reference_field_not_allowed",
  "invalid_parent",
  "self_parent",
  "parent_cycle",
  "dangling_parent",
  "dangling_related_key",
  "duplicate_related_key",
  "scheduling_order",
  "deadline_relative_without_due",
  "captured_reminder",
  "timed_end_required",
  "parent_disabled",
  "owner_not_member",
  "reference_owner",
  "paperless_unavailable",
  "nothing_selected",
  "schema_invalid",
]);

export function isIntakeIssueCode(value: unknown): value is IntakeIssueCode {
  return typeof value === "string" && intakeIssueCodes.has(value as IntakeIssueCode);
}

export interface IntakeIssue {
  path: (string | number)[];
  code: IntakeIssueCode;
  message: string;
}

export type IntakeOmissionCode =
  | "invalid_date"
  | "invalid_datetime"
  | "ambiguous_datetime"
  | "nonexistent_datetime"
  | "invalid_reminder_time"
  | "invalid_reminder_timezone"
  | "deadline_relative_without_due"
  | "not_before_pair"
  | "not_before_date_mismatch"
  | "owner_not_member";

export interface IntakeOmission {
  path: (string | number)[];
  code: IntakeOmissionCode;
  originalValue: unknown;
}

export interface IntakeDraftValidationOptions {
  memberIds: readonly number[];
  paperlessAvailable: boolean;
  hasFiles: boolean;
  timezone?: string;
}

export interface IntakeNormalizationResult {
  plan: IntakePlan;
  warnings: IntakeWarning[];
}

export type IntakeTimestampNormalizationStatus =
  | "unchanged"
  | "normalized"
  | "invalid"
  | "ambiguous"
  | "nonexistent";

export interface IntakeTimestampNormalization {
  value: string;
  status: IntakeTimestampNormalizationStatus;
  timezoneInferred: boolean;
}

export interface IntakeTimestampInference {
  path: (string | number)[];
  originalValue: string;
  value: string;
  secondsAdded: boolean;
  timezone: string | null;
}

function issue(
  path: (string | number)[],
  code: IntakeIssueCode,
  message: string,
): IntakeIssue {
  return { path, code, message };
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
  );
}

function validDateTime(value: string): boolean {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  ) return false;
  return !Number.isNaN(Date.parse(value));
}

function validReminderTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function validTimezone(value: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function utcDate(value: string): string {
  return new Date(value).toISOString().slice(0, 10);
}

function dateDistance(left: string, right: string): number {
  return Math.abs(
    (Date.parse(`${left}T00:00:00Z`) -
      Date.parse(`${right}T00:00:00Z`)) /
      86_400_000,
  );
}

function addIssueForDate(
  issues: IntakeIssue[],
  path: (string | number)[],
  value: string | null,
): void {
  if (value !== null && !validDate(value)) {
    issues.push(issue(
      path,
      "invalid_date",
      `Invalid date ${previewContractValue(value)}; expected YYYY-MM-DD.`,
    ));
  }
}

function addIssueForDateTime(
  issues: IntakeIssue[],
  path: (string | number)[],
  value: string | null,
): void {
  if (value !== null && !validDateTime(value)) {
    issues.push(issue(
      path,
      "invalid_datetime",
      `Invalid date-time ${previewContractValue(value)}; expected RFC 3339 with seconds and an explicit timezone offset.`,
    ));
  }
}

function previewContractValue(value: string): string {
  const bounded = value.slice(0, 80);
  const suffix = value.length > bounded.length ? "..." : "";
  return `"${bounded.replace(/[\r\n\t]/g, " ")}${suffix}"`;
}

export function intakePlanIssues(plan: IntakePlan): IntakeIssue[] {
  const issues: IntakeIssue[] = [];
  const calendarKeys = new Set<string>();
  const workKeys = new Set<string>();
  const allKeys = new Map<string, (string | number)[]>();

  if (plan.calendarEvents.length > INTAKE_MAX_CALENDAR_EVENTS) {
    issues.push(issue(["calendarEvents"], "key_invalid", "Too many calendar events."));
  }

  if (plan.workItems.length > INTAKE_MAX_WORK_ITEMS) {
    issues.push(issue(["workItems"], "key_invalid", "Too many work items."));
  }
  if (plan.warnings.length > INTAKE_MAX_WARNINGS) {
    issues.push(issue(["warnings"], "key_invalid", "Too many warnings."));
  }

  plan.calendarEvents.forEach((event, index) => {
    const path = ["calendarEvents", index] as (string | number)[];
    if (!INTAKE_KEY_PATTERN.test(event.key)) {
      issues.push(issue(
        [...path, "key"],
        "key_invalid",
        `Invalid plan key ${previewContractValue(event.key)}; expected 1-40 characters starting with a lowercase letter or digit and containing only lowercase letters, digits, "_" or "-".`,
      ));
    }
    if (allKeys.has(event.key)) {
      issues.push(issue([...path, "key"], "duplicate_key", "Keys must be unique across the plan."));
    }
    allKeys.set(event.key, [...path, "key"]);
    calendarKeys.add(event.key);
    addIssueForDate(issues, [...path, "startDate"], event.startDate);
    addIssueForDate(issues, [...path, "endDate"], event.endDate);
    addIssueForDateTime(issues, [...path, "startDateTime"], event.startDateTime);
    addIssueForDateTime(issues, [...path, "endDateTime"], event.endDateTime);
    if (event.allDay) {
      if (event.startDate === null || event.endDate === null) {
        issues.push(issue(path, "calendar_start_required", "All-day events require start and end dates."));
      } else if (validDate(event.startDate) && validDate(event.endDate) && event.endDate < event.startDate) {
        issues.push(issue([...path, "endDate"], "calendar_end_before_start", "End date must not precede start date."));
      }
      if (event.startDateTime !== null || event.endDateTime !== null) {
        issues.push(issue(path, "calendar_datetime_conflict", "All-day events cannot have date-times."));
      }
    } else {
      if (event.startDateTime === null) {
        issues.push(issue([...path, "startDateTime"], "calendar_start_required", "Timed events require a start date-time."));
      }
      if (event.startDate !== null || event.endDate !== null) {
        issues.push(issue(path, "calendar_date_conflict", "Timed events cannot have dates."));
      }
      if (
        event.startDateTime !== null &&
        event.endDateTime !== null &&
        validDateTime(event.startDateTime) &&
        validDateTime(event.endDateTime) &&
        Date.parse(event.endDateTime) <= Date.parse(event.startDateTime)
      ) {
        issues.push(issue([...path, "endDateTime"], "timed_end_before_start", "End must be after start."));
      }
    }
    for (const [keyIndex, relatedKey] of event.relatedWorkKeys.entries()) {
      if (event.relatedWorkKeys.indexOf(relatedKey) !== keyIndex) {
        issues.push(issue([...path, "relatedWorkKeys", keyIndex], "duplicate_related_key", "Related keys must be unique."));
      } else if (!workKeys.has(relatedKey) && !plan.workItems.some((item) => item.key === relatedKey)) {
        issues.push(issue([...path, "relatedWorkKeys", keyIndex], "dangling_related_key", "Related work item does not exist."));
      }
    }
  });

  plan.workItems.forEach((item, index) => {
    const path = ["workItems", index] as (string | number)[];
    if (!INTAKE_KEY_PATTERN.test(item.key)) {
      issues.push(issue(
        [...path, "key"],
        "key_invalid",
        `Invalid plan key ${previewContractValue(item.key)}; expected 1-40 characters starting with a lowercase letter or digit and containing only lowercase letters, digits, "_" or "-".`,
      ));
    }
    if (allKeys.has(item.key)) {
      issues.push(issue([...path, "key"], "duplicate_key", "Keys must be unique across the plan."));
    }
    allKeys.set(item.key, [...path, "key"]);
    workKeys.add(item.key);
    addIssueForDate(issues, [...path, "dueDate"], item.dueDate);
    addIssueForDate(issues, [...path, "scheduledDate"], item.scheduledDate);
    addIssueForDate(issues, [...path, "notBeforeDate"], item.notBeforeDate);
    addIssueForDateTime(issues, [...path, "notBeforeAt"], item.notBeforeAt);
    for (const [reminderIndex, reminder] of item.reminders.entries()) {
      const reminderPath = [...path, "reminders", reminderIndex] as (string | number)[];
      if (reminder.kind === "absolute") {
        addIssueForDateTime(issues, [...reminderPath, "at"], reminder.at);
      } else {
        if (!validReminderTime(reminder.time)) {
          issues.push(issue(
            [...reminderPath, "time"],
            "invalid_reminder_time",
            `Invalid reminder time ${previewContractValue(reminder.time)}; expected HH:mm.`,
          ));
        }
        if (!validTimezone(reminder.timezone)) {
          issues.push(issue(
            [...reminderPath, "timezone"],
            "invalid_reminder_timezone",
            `Invalid reminder timezone ${previewContractValue(reminder.timezone)}; expected an IANA timezone.`,
          ));
        }
        if (item.dueDate === null || !validDate(item.dueDate)) {
          issues.push(issue(
            reminderPath,
            "deadline_relative_without_due",
            "Deadline-relative reminders require a usable deadline.",
          ));
        }
      }
    }
    if ((item.notBeforeAt === null) !== (item.notBeforeDate === null)) {
      issues.push(issue(path, "not_before_pair", "notBeforeDate and notBeforeAt must be set together."));
    } else if (item.notBeforeAt && item.notBeforeDate && validDateTime(item.notBeforeAt) && validDate(item.notBeforeDate)) {
      if (dateDistance(item.notBeforeDate, utcDate(item.notBeforeAt)) > 1) {
        issues.push(issue([...path, "notBeforeDate"], "not_before_date_mismatch", "Availability date must be within one day of the instant's UTC date."));
      }
    }
    if (item.scheduledDate && item.dueDate && item.scheduledDate > item.dueDate) {
      issues.push(issue(path, "scheduling_order", "Scheduled date must not be after the due date."));
    }
    if (item.kind === "project") {
      if (item.notBeforeDate !== null || item.notBeforeAt !== null || item.reminders.length > 0 || item.needsClarification) {
        issues.push(issue(path, "project_field_not_allowed", "Projects may have a scheduled date and due date, but no availability, reminders, or clarification fields."));
      }
      if (item.parentKey !== null && !plan.workItems.some((parent) => parent.key === item.parentKey && parent.kind === "project")) {
        issues.push(issue([...path, "parentKey"], "invalid_parent", "Projects can only be children of projects."));
      }
    } else if (item.kind === "reference") {
      if (item.ownerName !== null || item.dueDate !== null || item.scheduledDate !== null || item.notBeforeDate !== null || item.notBeforeAt !== null || item.reminders.length > 0 || item.needsClarification) {
        issues.push(issue(path, "reference_field_not_allowed", "References cannot carry ownership, scheduling, reminders, or clarification fields."));
      }
      if (item.parentKey !== null && !plan.workItems.some((parent) => parent.key === item.parentKey && (parent.kind === "project" || parent.kind === "action"))) {
        issues.push(issue([...path, "parentKey"], "invalid_parent", "References may only be children of projects or actions."));
      }
    } else if (item.parentKey !== null && !plan.workItems.some((parent) => parent.key === item.parentKey && (parent.kind === "project" || parent.kind === "action"))) {
      issues.push(issue([...path, "parentKey"], "invalid_parent", "Actions may only be children of projects or actions."));
    }
    if (item.parentKey === item.key) {
      issues.push(issue([...path, "parentKey"], "self_parent", "An item cannot parent itself."));
    } else if (item.parentKey !== null && !plan.workItems.some((parent) => parent.key === item.parentKey)) {
      issues.push(issue([...path, "parentKey"], "dangling_parent", "Parent item does not exist."));
    }
    for (const [keyIndex, relatedKey] of item.relatedCalendarKeys.entries()) {
      if (item.relatedCalendarKeys.indexOf(relatedKey) !== keyIndex) {
        issues.push(issue([...path, "relatedCalendarKeys", keyIndex], "duplicate_related_key", "Related keys must be unique."));
      } else if (!calendarKeys.has(relatedKey) && !plan.calendarEvents.some((event) => event.key === relatedKey)) {
        issues.push(issue([...path, "relatedCalendarKeys", keyIndex], "dangling_related_key", "Related calendar event does not exist."));
      }
    }
  });

  const parentState = new Map<string, "visiting" | "visited">();
  const byKey = new Map(plan.workItems.map((item) => [item.key, item]));
  const visit = (key: string): void => {
    if (parentState.get(key) === "visiting") {
      issues.push(issue(["workItems"], "parent_cycle", "Parent graph must be acyclic."));
      return;
    }
    if (parentState.get(key) === "visited") return;
    parentState.set(key, "visiting");
    const parent = byKey.get(key)?.parentKey;
    if (parent && byKey.has(parent)) visit(parent);
    parentState.set(key, "visited");
  };
  for (const item of plan.workItems) visit(item.key);
  return issues;
}

function berlinMidnight(date: string): string | null {
  if (!validDate(date)) return null;
  const [year, month, day] = date.split("-").map(Number);
  let candidate = Date.UTC(year!, month! - 1, day!, 0, 0, 0);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: INTAKE_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(candidate));
    const values = Object.fromEntries(parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])) as Record<string, number>;
    const local = Date.UTC(
      values.year ?? 0,
      (values.month ?? 1) - 1,
      values.day ?? 1,
      values.hour ?? 0,
      values.minute ?? 0,
      values.second ?? 0,
    );
    candidate += Date.UTC(year!, month! - 1, day!, 0, 0, 0) - local;
  }
  return new Date(candidate).toISOString();
}

function berlinDateForInstant(value: string): string | null {
  if (!validDateTime(value)) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: INTAKE_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

function addNormalizationWarning(
  warnings: IntakeWarning[],
  message: string,
): void {
  if (!warnings.some((warning) => warning.message === message)) {
    warnings.push({ message });
  }
}

/**
 * Repairs representation-level relationship and availability inconsistencies
 * without resolving semantic choices that must remain editable in review.
 */
export function normalizeIntakePlan(plan: IntakePlan): IntakeNormalizationResult {
  const warnings = [...plan.warnings];
  const calendarKeys = new Set(plan.calendarEvents.map((event) => event.key));
  const workItems = plan.workItems.map((item) => ({ ...item, reminders: [...item.reminders] }));
  const workKeys = new Set(workItems.map((item) => item.key));
  const workByKey = new Map(workItems.map((item) => [item.key, item]));

  const calendarEvents = plan.calendarEvents.map((event) => {
    const relatedWorkKeys: string[] = [];
    for (const key of event.relatedWorkKeys) {
      if (!workKeys.has(key)) {
        addNormalizationWarning(
          warnings,
          `Removed dangling related work link from calendar event '${event.key}'.`,
        );
      } else if (!relatedWorkKeys.includes(key)) {
        relatedWorkKeys.push(key);
      } else {
        addNormalizationWarning(
          warnings,
          `Removed duplicate related work link from calendar event '${event.key}'.`,
        );
      }
    }
    return { ...event, relatedWorkKeys };
  });

  for (const item of workItems) {
    const relatedCalendarKeys: string[] = [];
    for (const key of item.relatedCalendarKeys) {
      if (!calendarKeys.has(key)) {
        addNormalizationWarning(
          warnings,
          `Removed dangling related calendar link from work item '${item.key}'.`,
        );
      } else if (!relatedCalendarKeys.includes(key)) {
        relatedCalendarKeys.push(key);
      } else {
        addNormalizationWarning(
          warnings,
          `Removed duplicate related calendar link from work item '${item.key}'.`,
        );
      }
    }
    item.relatedCalendarKeys = relatedCalendarKeys;

    if (item.notBeforeDate === null && item.notBeforeAt !== null) {
      item.notBeforeDate = berlinDateForInstant(item.notBeforeAt);
      if (item.notBeforeDate !== null) {
        addNormalizationWarning(
          warnings,
          `Derived availability date for work item '${item.key}' from its instant.`,
        );
      }
    } else if (item.notBeforeDate !== null && item.notBeforeAt === null) {
      item.notBeforeAt = berlinMidnight(item.notBeforeDate);
    }

    if (item.parentKey !== null) {
      const parent = workByKey.get(item.parentKey);
      const allowed = parent !== undefined && (
        item.kind === "project"
          ? parent.kind === "project"
          : parent.kind === "action" || parent.kind === "project"
      );
      if (!allowed || item.parentKey === item.key) {
        addNormalizationWarning(
          warnings,
          `Moved work item '${item.key}' to the root because its parent was invalid.`,
        );
        item.parentKey = null;
      }
    }
  }

  const order = new Map(workItems.map((item, index) => [item.key, index]));
  let changedCycle = true;
  while (changedCycle) {
    changedCycle = false;
    for (const start of workItems) {
      const chain: string[] = [];
      const positions = new Map<string, number>();
      let current: IntakeWorkItem | undefined = start;
      while (current?.parentKey) {
        const position = positions.get(current.key);
        if (position !== undefined) {
          const cycle = chain.slice(position);
          const broken = cycle
            .map((key) => workByKey.get(key))
            .filter((item): item is IntakeWorkItem => item !== undefined)
            .sort((left, right) => (order.get(right.key) ?? 0) - (order.get(left.key) ?? 0))[0];
          if (broken) {
            broken.parentKey = null;
            addNormalizationWarning(
              warnings,
              `Moved work item '${broken.key}' to the root to break a parent cycle.`,
            );
            changedCycle = true;
          }
          break;
        }
        positions.set(current.key, chain.length);
        chain.push(current.key);
        current = workByKey.get(current.parentKey);
      }
    }
  }

  return {
    plan: {
      ...plan,
      calendarEvents,
      workItems,
      warnings: warnings.slice(0, INTAKE_MAX_WARNINGS),
    },
    warnings,
  };
}

export function intakeDraftIssues(
  draft: IntakeDraft,
  options: IntakeDraftValidationOptions,
): IntakeIssue[] {
  const plan = intakeDraftPlan(draft);
  const issues = intakePlanIssues(plan);
  draft.calendarEvents.forEach((event, index) => {
    if (event.enabled && !event.allDay && event.endDateTime === null) {
      issues.push(issue(["calendarEvents", index, "endDateTime"], "timed_end_required", "Enabled timed events require an end."));
    }
  });
  const enabledItems = new Map(draft.workItems.filter((item) => item.enabled).map((item) => [item.key, item]));
  draft.workItems.forEach((item, index) => {
    if (item.ownerMemberId !== null && !options.memberIds.includes(item.ownerMemberId)) {
      issues.push(issue(["workItems", index, "ownerMemberId"], "owner_not_member", "Owner is not a household member."));
    }
    if (item.kind === "reference" && item.ownerMemberId !== null) {
      issues.push(issue(["workItems", index, "ownerMemberId"], "reference_owner", "References cannot have an owner."));
    }
    if (item.enabled && item.parentKey !== null && !enabledItems.has(item.parentKey)) {
      issues.push(issue(["workItems", index, "parentKey"], "parent_disabled", "An enabled item cannot have a disabled parent."));
    }
  });
  if (draft.retainSourceInPaperless && (!options.paperlessAvailable || !options.hasFiles || draft.workItems.every((item) => !item.enabled))) {
    issues.push(issue(["retainSourceInPaperless"], "paperless_unavailable", "Source retention requires Paperless, files, and an enabled work item."));
  }
  if (draft.calendarEvents.every((event) => !event.enabled) && draft.workItems.every((item) => !item.enabled)) {
    issues.push(issue([], "nothing_selected", "At least one item or event must be enabled."));
  }
  return issues;
}

function intakeDraftPlan(draft: IntakeDraft): IntakePlan {
  return {
    summary: draft.summary,
    calendarEvents: draft.calendarEvents,
    workItems: draft.workItems.map(({ ownerMemberId, ...item }) => ({
      ...item,
      ownerName: ownerMemberId === null ? null : String(ownerMemberId),
    })),
    warnings: draft.warnings,
  };
}

function remapSelectedIssuePath(
  path: readonly (string | number)[],
  workIndices: readonly number[],
  calendarIndices: readonly number[],
): (string | number)[] {
  if (path.length < 2 || typeof path[1] !== "number") return [...path];
  if (path[0] === "workItems") {
    const originalIndex = workIndices[path[1]];
    return originalIndex === undefined ? [...path] : [path[0], originalIndex, ...path.slice(2)];
  }
  if (path[0] === "calendarEvents") {
    const originalIndex = calendarIndices[path[1]];
    return originalIndex === undefined ? [...path] : [path[0], originalIndex, ...path.slice(2)];
  }
  return [...path];
}

/**
 * Validate only the output selected for Apply. Review diagnostics continue to
 * cover the complete proposal, including disabled cards.
 */
export function intakeSelectedDraftIssues(
  draft: IntakeDraft,
  options: IntakeDraftValidationOptions,
): IntakeIssue[] {
  const workIndices = draft.workItems
    .map((item, index) => item.enabled ? index : -1)
    .filter((index) => index >= 0);
  const calendarIndices = draft.calendarEvents
    .map((event, index) => event.enabled ? index : -1)
    .filter((index) => index >= 0);
  const enabledWork = workIndices.map((index) => draft.workItems[index]!);
  const enabledCalendar = calendarIndices.map((index) => draft.calendarEvents[index]!);
  const enabledWorkKeys = new Set(enabledWork.map((item) => item.key));
  const enabledCalendarKeys = new Set(enabledCalendar.map((event) => event.key));
  const selectedDraft: IntakeDraft = {
    ...draft,
    workItems: enabledWork.map((item) => ({
      ...item,
      parentKey: item.parentKey !== null && enabledWorkKeys.has(item.parentKey) ? item.parentKey : null,
      relatedCalendarKeys: item.relatedCalendarKeys.filter((key) => enabledCalendarKeys.has(key)),
    })),
    calendarEvents: enabledCalendar.map((event) => ({
      ...event,
      relatedWorkKeys: event.relatedWorkKeys.filter((key) => enabledWorkKeys.has(key)),
    })),
  };
  const planIssues = intakePlanIssues(intakeDraftPlan(selectedDraft));
  const issues = planIssues.map((item) => ({
    ...item,
    path: remapSelectedIssuePath(item.path, workIndices, calendarIndices),
  }));

  enabledCalendar.forEach((event, selectedIndex) => {
    if (!event.allDay && event.endDateTime === null) {
      issues.push(issue(["calendarEvents", calendarIndices[selectedIndex]!, "endDateTime"], "timed_end_required", "Enabled timed events require an end."));
    }
  });
  enabledWork.forEach((item, selectedIndex) => {
    const originalIndex = workIndices[selectedIndex]!;
    if (item.ownerMemberId !== null && !options.memberIds.includes(item.ownerMemberId)) {
      issues.push(issue(["workItems", originalIndex, "ownerMemberId"], "owner_not_member", "Owner is not a household member."));
    }
    if (item.kind === "reference" && item.ownerMemberId !== null) {
      issues.push(issue(["workItems", originalIndex, "ownerMemberId"], "reference_owner", "References cannot have an owner."));
    }
    if (item.parentKey !== null && !enabledWorkKeys.has(item.parentKey)) {
      issues.push(issue(["workItems", originalIndex, "parentKey"], "parent_disabled", "An enabled item cannot have a disabled parent."));
    }
  });
  if (draft.retainSourceInPaperless && (!options.paperlessAvailable || !options.hasFiles || enabledWork.length === 0)) {
    issues.push(issue(["retainSourceInPaperless"], "paperless_unavailable", "Source retention requires Paperless, files, and an enabled work item."));
  }
  if (enabledCalendar.length === 0 && enabledWork.length === 0) {
    issues.push(issue([], "nothing_selected", "At least one item or event must be enabled."));
  }
  return issues;
}

function cloneIntakeDraft(draft: IntakeDraft): IntakeDraft {
  return {
    ...draft,
    calendarEvents: draft.calendarEvents.map((event) => ({
      ...event,
      relatedWorkKeys: [...event.relatedWorkKeys],
    })),
    workItems: draft.workItems.map((item) => ({
      ...item,
      reminders: item.reminders.map((reminder) => ({ ...reminder })),
      relatedCalendarKeys: [...item.relatedCalendarKeys],
    })),
    warnings: draft.warnings.map((warning) => ({ ...warning })),
  };
}

function omission(
  omissions: IntakeOmission[],
  path: (string | number)[],
  code: IntakeOmissionCode,
  originalValue: unknown,
): void {
  omissions.push({ path, code, originalValue });
}

function availabilityOmissionCode(
  notBeforeDate: string | null,
  notBeforeAt: string | null,
): "invalid_date" | "invalid_datetime" | "not_before_pair" | "not_before_date_mismatch" {
  if ((notBeforeDate === null) !== (notBeforeAt === null)) return "not_before_pair";
  if (notBeforeDate !== null && !validDate(notBeforeDate)) return "invalid_date";
  if (notBeforeAt !== null && !validDateTime(notBeforeAt)) return "invalid_datetime";
  return "not_before_date_mismatch";
}

/**
 * Prepare an enabled draft for the explicit incomplete-acceptance flow.
 * Only optional metadata with an unambiguous safe omission is removed;
 * structural, calendar, and kind-specific issues remain blockers.
 */
export function prepareIncompleteIntakeDraft(
  draft: IntakeDraft,
  options: IntakeDraftValidationOptions,
): {
  draft: IntakeDraft;
  omissions: IntakeOmission[];
  normalizedTimestamps: IntakeTimestampInference[];
  blockingIssues: IntakeIssue[];
} {
  const prepared = cloneIntakeDraft(draft);
  const omissions: IntakeOmission[] = [];
  const normalizedTimestamps: IntakeTimestampInference[] = [];
  const timezone = options.timezone ?? INTAKE_TIMEZONE;

  const recordTimestamp = (
    value: string,
    path: (string | number)[],
  ): IntakeTimestampNormalization => {
    const result = normalizeIntakeTimestamp(value, timezone);
    if (result.status === "normalized") {
      normalizedTimestamps.push({
        path,
        originalValue: value,
        value: result.value,
        secondsAdded: !/T\d{2}:\d{2}:\d{2}/.test(value),
        timezone: result.timezoneInferred ? timezone : null,
      });
    }
    return result;
  };

  const timestampOmissionCode = (
    status: IntakeTimestampNormalizationStatus,
  ): "invalid_datetime" | "ambiguous_datetime" | "nonexistent_datetime" => {
    if (status === "ambiguous") return "ambiguous_datetime";
    if (status === "nonexistent") return "nonexistent_datetime";
    return "invalid_datetime";
  };

  prepared.calendarEvents.forEach((event, index) => {
    if (!event.enabled) return;
    for (const field of ["startDateTime", "endDateTime"] as const) {
      const value = event[field];
      if (value === null) continue;
      const path = ["calendarEvents", index, field] as (string | number)[];
      const result = recordTimestamp(value, path);
      if (result.status === "normalized") {
        event[field] = result.value;
      }
    }
  });

  prepared.workItems.forEach((item, index) => {
    if (!item.enabled) return;

    for (const field of ["dueDate", "scheduledDate"] as const) {
      const value = item[field];
      if (value !== null && !validDate(value)) {
        omission(omissions, ["workItems", index, field], "invalid_date", value);
        item[field] = null;
      }
    }

    let availabilityRequiresDiagnostic = false;
    if (item.kind === "action" && item.notBeforeAt !== null) {
      const path = ["workItems", index, "notBeforeAt"] as (string | number)[];
      const result = recordTimestamp(item.notBeforeAt, path);
      if (result.status === "normalized") {
        item.notBeforeAt = result.value;
      } else if (result.status === "ambiguous" || result.status === "nonexistent") {
        availabilityRequiresDiagnostic = true;
        omission(omissions, path, timestampOmissionCode(result.status), item.notBeforeAt);
      } else if (result.status === "invalid") {
        omission(omissions, path, "invalid_datetime", item.notBeforeAt);
        item.notBeforeDate = null;
        item.notBeforeAt = null;
      }
    }

    if (item.kind === "action" && !availabilityRequiresDiagnostic) {
      const { notBeforeDate, notBeforeAt } = item;
      const availabilityValid =
        notBeforeDate === null && notBeforeAt === null
          ? true
          : notBeforeDate !== null &&
            notBeforeAt !== null &&
            validDate(notBeforeDate) &&
            validDateTime(notBeforeAt) &&
            dateDistance(notBeforeDate, utcDate(notBeforeAt)) <= 1;
      if (!availabilityValid) {
        omission(
          omissions,
          ["workItems", index, "notBeforeDate"],
          availabilityOmissionCode(notBeforeDate, notBeforeAt),
          { notBeforeDate, notBeforeAt },
        );
        item.notBeforeDate = null;
        item.notBeforeAt = null;
      }
    }

    if (item.ownerMemberId !== null && !options.memberIds.includes(item.ownerMemberId)) {
      omission(
        omissions,
        ["workItems", index, "ownerMemberId"],
        "owner_not_member",
        item.ownerMemberId,
      );
      item.ownerMemberId = null;
    }

    if (item.kind !== "action") return;
    const dueDateUsable = item.dueDate !== null && validDate(item.dueDate);
    item.reminders = item.reminders.filter((reminder, reminderIndex) => {
      const reminderPath = ["workItems", index, "reminders", reminderIndex] as (string | number)[];
      if (reminder.kind === "absolute") {
        const path = [...reminderPath, "at"];
        const result = recordTimestamp(reminder.at, path);
        if (result.status === "normalized") {
          reminder.at = result.value;
          return true;
        }
        if (result.status === "ambiguous" || result.status === "nonexistent") {
          omission(omissions, path, timestampOmissionCode(result.status), reminder.at);
          return true;
        }
        if (result.status === "invalid") {
          omission(omissions, path, "invalid_datetime", reminder.at);
          return false;
        }
        return true;
      }
      if (!validReminderTime(reminder.time)) {
        omission(omissions, [...reminderPath, "time"], "invalid_reminder_time", reminder.time);
        return false;
      }
      if (!validTimezone(reminder.timezone)) {
        omission(omissions, [...reminderPath, "timezone"], "invalid_reminder_timezone", reminder.timezone);
        return false;
      }
      if (!dueDateUsable) {
        omission(omissions, reminderPath, "deadline_relative_without_due", { ...reminder });
        return false;
      }
      return true;
    });
  });

  return {
    draft: prepared,
    omissions,
    normalizedTimestamps,
    blockingIssues: intakeSelectedDraftIssues(prepared, options),
  };
}

export function buildDraftFromPlan(
  plan: IntakePlan,
  members: readonly { id: number; name: string }[],
): IntakeDraft {
  const warnings = [...plan.warnings];
  const warnedMissingEnd = warnings.some((warning) => /no end time/i.test(warning.message));
  const calendarEvents = plan.calendarEvents.map((event) => {
    let durationAssumed = false;
    let endDateTime = event.endDateTime;
    if (!event.allDay && event.startDateTime && validDateTime(event.startDateTime) && endDateTime === null) {
      endDateTime = new Date(Date.parse(event.startDateTime) + 60 * 60_000).toISOString();
      durationAssumed = true;
      if (!warnedMissingEnd) warnings.push({ message: "No end time in source; 60 min assumed" });
    }
    return { ...event, endDateTime, enabled: true, durationAssumed };
  });
  const workItems = plan.workItems.map((item) => {
    const member = resolveOwnerSuggestion(item.ownerName, members);
    if (item.ownerName !== null && !member && !isAbsentOwnerSuggestion(item.ownerName)) {
      warnings.push({ message: `Owner '${item.ownerName}' is not a household member` });
    }
    const { ownerName: _ownerName, ...withoutOwnerName } = item;
    return {
      ...withoutOwnerName,
      ownerMemberId: member?.id ?? null,
      enabled: true,
    };
  });
  return {
    summary: plan.summary,
    calendarEvents,
    workItems,
    warnings,
    retainSourceInPaperless: false,
  };
}

export type IntakeStatus =
  | "queued"
  | "analyzing"
  | "analysis_failed"
  | "ready"
  | "applying"
  | "applied"
  | "partially_applied";

export type IntakeErrorCode =
  | "home_assistant_not_connected"
  | "home_assistant_protocol_outdated"
  | "ai_task_not_configured"
  | "ai_task_attachments_unsupported"
  | "ai_task_failed"
  | "ai_task_invalid_response"
  | "intake_plan_invalid"
  | "calendar_not_configured"
  | "calendar_not_writable"
  | "calendar_create_failed"
  | "calendar_uid_not_recovered"
  | "intake_apply_partial"
  | "intake_attachment_download_failed"
  | "intake_not_found"
  | "intake_expired"
  | "intake_input_required"
  | "intake_file_rejected"
  | "intake_file_too_large"
  | "intake_too_many_files"
  | "intake_draft_invalid"
  | "intake_state_conflict"
  | "intake_source_retention_failed"
  | "home_assistant_request_lease_lost"
  | "home_assistant_request_exhausted";

export interface IntakeErrorDetails {
  issues?: IntakeIssue[];
  path?: (string | number)[];
  expectedType?: string;
  actualType?: string;
  valuePreview?: string;
}

export interface IntakeErrorInfo {
  code: IntakeErrorCode;
  message: string;
  retryable: boolean;
  details?: IntakeErrorDetails;
}

export function intakeErrorIssues(error: IntakeErrorInfo | null): IntakeIssue[] {
  const details = error?.details;
  if (!details) return [];
  if (Array.isArray(details.issues)) {
    return details.issues
      .slice(0, 50)
      .filter((item): item is IntakeIssue => (
        Boolean(item)
        && Array.isArray(item.path)
        && isIntakeIssueCode(item.code)
        && typeof item.message === "string"
      ))
      .map((item) => ({
        path: item.path.filter((segment) => typeof segment === "string" || typeof segment === "number"),
        code: item.code,
        message: item.message.slice(0, 500),
      }));
  }
  if (error.code === "ai_task_invalid_response" && Array.isArray(details.path)) {
    const expected = typeof details.expectedType === "string"
      ? details.expectedType.slice(0, 200)
      : "the expected field type";
    const actual = typeof details.actualType === "string"
      ? ` Received ${details.actualType.slice(0, 50)}.`
      : "";
    const preview = typeof details.valuePreview === "string"
      ? ` Value ${details.valuePreview.slice(0, 100)}.`
      : "";
    return [{
      path: details.path.filter((segment) => typeof segment === "string" || typeof segment === "number"),
      code: "schema_invalid",
      message: `${error.message.slice(0, 250)} Expected ${expected}.${actual}${preview}`,
    }];
  }
  return [];
}

export interface HomeAssistantCalendarEventRef {
  calendarEntityId: string;
  uid: string;
  recurrenceId: string | null;
  summary: string;
  start: string;
  end: string;
  correlationId: string;
}

export type HomeAssistantRequestErrorCode =
  | "ai_task_not_configured"
  | "ai_task_attachments_unsupported"
  | "ai_task_failed"
  | "ai_task_invalid_response"
  | "intake_attachment_download_failed"
  | "calendar_not_configured"
  | "calendar_not_writable"
  | "calendar_create_failed"
  | "calendar_uid_not_recovered"
  | "unsupported_request";

export type HomeAssistantLeasedRequest =
  | { id: string; leaseToken: string; leaseExpiresAt: string; kind: "intake_analyze"; payload: { intakeId: string; taskName: string; instructions: string; text: string | null; attachments: Array<{ id: string; filename: string; mimeType: string; sizeBytes: number }> } }
  | { id: string; leaseToken: string; leaseExpiresAt: string; kind: "calendar_create"; payload: { intakeId: string; correlationId: string; title: string; description: string | null; location: string | null; allDay: boolean; startDate: string | null; endDate: string | null; startDateTime: string | null; endDateTime: string | null } }
  | { id: string; leaseToken: string; leaseExpiresAt: string; kind: "cleanup_round_analyze"; payload: CleanupRoundAnalyzePayload };

export type HomeAssistantRequestCompletion =
  | { leaseToken: string; outcome: "succeeded"; result: IntakePlan }
  | { leaseToken: string; outcome: "succeeded"; result: HomeAssistantCalendarEventRef }
  | { leaseToken: string; outcome: "succeeded"; result: CleanupRoundAiResponse }
  | {
      leaseToken: string;
      outcome: "failed";
      error: {
        code: HomeAssistantRequestErrorCode;
        message: string;
        details?: IntakeErrorDetails;
      };
    };

export interface IntakeCalendarApplyResult {
  key: string;
  correlationId: string;
  status: "pending" | "succeeded" | "failed";
  error: IntakeErrorInfo | null;
  event: { calendarEntityId: string; uid: string; recurrenceId: string | null; summary: string; start: string; end: string } | null;
}
export interface IntakeWorkApplyResult {
  key: string;
  kind: IntakeWorkItemKind;
  workItemId: number;
  role: "task" | "story";
}
export interface IntakeApplyResults {
  work: IntakeWorkApplyResult[];
  calendar: IntakeCalendarApplyResult[];
  paperlessDocumentIds: number[];
}
export interface IntakeRecord {
  id: string;
  status: IntakeStatus;
  revision: number;
  createdAt: string;
  expiresAt: string;
  text: string | null;
  retryHint: string | null;
  attachments: Array<{ id: string; filename: string; mimeType: string; sizeBytes: number }>;
  draft: IntakeDraft | null;
  error: IntakeErrorInfo | null;
  applyResults: IntakeApplyResults | null;
  homeAssistant: { workerOnline: boolean };
  paperlessAvailable: boolean;
}
