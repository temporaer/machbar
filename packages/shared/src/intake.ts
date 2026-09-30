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
  reminderAt: string | null;
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
  | "captured_reminder"
  | "timed_end_required"
  | "parent_disabled"
  | "owner_not_member"
  | "reference_owner"
  | "paperless_unavailable"
  | "nothing_selected";

export interface IntakeIssue {
  path: (string | number)[];
  code: IntakeIssueCode;
  message: string;
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
  if (!/T/.test(value) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
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
    issues.push(issue(path, "invalid_date", "Date must use a valid YYYY-MM-DD value."));
  }
}

function addIssueForDateTime(
  issues: IntakeIssue[],
  path: (string | number)[],
  value: string | null,
): void {
  if (value !== null && !validDateTime(value)) {
    issues.push(issue(path, "invalid_datetime", "Date-time must be RFC 3339 with an offset."));
  }
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
      issues.push(issue([...path, "key"], "key_invalid", "Invalid plan key."));
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
      issues.push(issue([...path, "key"], "key_invalid", "Invalid plan key."));
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
    addIssueForDateTime(issues, [...path, "reminderAt"], item.reminderAt);
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
    if (item.needsClarification && item.reminderAt !== null) {
      issues.push(issue([...path, "reminderAt"], "captured_reminder", "Clarifying items cannot have reminders."));
    }
    if (item.kind === "project") {
      if (item.scheduledDate !== null || item.notBeforeDate !== null || item.notBeforeAt !== null || item.reminderAt !== null || item.needsClarification) {
        issues.push(issue(path, "project_field_not_allowed", "Projects may only have a due date."));
      }
      if (item.parentKey !== null && !plan.workItems.some((parent) => parent.key === item.parentKey && parent.kind === "project")) {
        issues.push(issue([...path, "parentKey"], "invalid_parent", "Projects can only be children of projects."));
      }
    } else if (item.kind === "reference") {
      if (item.ownerName !== null || item.dueDate !== null || item.scheduledDate !== null || item.notBeforeDate !== null || item.notBeforeAt !== null || item.reminderAt !== null || item.needsClarification) {
        issues.push(issue(path, "reference_field_not_allowed", "References cannot carry scheduling, owner, or clarification fields."));
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

export function intakeDraftIssues(
  draft: IntakeDraft,
  options: { memberIds: readonly number[]; paperlessAvailable: boolean; hasFiles: boolean },
): IntakeIssue[] {
  const plan: IntakePlan = {
    summary: draft.summary,
    calendarEvents: draft.calendarEvents,
    workItems: draft.workItems.map(({ ownerMemberId, ...item }) => ({
      ...item,
      ownerName: ownerMemberId === null ? null : String(ownerMemberId),
    })),
    warnings: draft.warnings,
  };
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

export function buildDraftFromPlan(
  plan: IntakePlan,
  members: readonly { id: number; name: string }[],
): IntakeDraft {
  const warnings = [...plan.warnings];
  const warnedMissingEnd = warnings.some((warning) => /no end time/i.test(warning.message));
  const calendarEvents = plan.calendarEvents.map((event) => {
    let durationAssumed = false;
    let endDateTime = event.endDateTime;
    if (!event.allDay && event.startDateTime && endDateTime === null) {
      endDateTime = new Date(Date.parse(event.startDateTime) + 60 * 60_000).toISOString();
      durationAssumed = true;
      if (!warnedMissingEnd) warnings.push({ message: "No end time in source; 60 min assumed" });
    }
    return { ...event, endDateTime, enabled: true, durationAssumed };
  });
  const workItems = plan.workItems.map((item) => {
    const owner = item.ownerName?.trim().toLocaleLowerCase();
    const member = owner
      ? members.find((candidate) => candidate.name.trim().toLocaleLowerCase() === owner)
      : undefined;
    if (item.ownerName !== null && !member) {
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
export interface IntakeErrorInfo {
  code: IntakeErrorCode;
  message: string;
  retryable: boolean;
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
  | { id: string; leaseToken: string; leaseExpiresAt: string; kind: "calendar_create"; payload: { intakeId: string; correlationId: string; title: string; description: string | null; location: string | null; allDay: boolean; startDate: string | null; endDate: string | null; startDateTime: string | null; endDateTime: string | null } };

export type HomeAssistantRequestCompletion =
  | { leaseToken: string; outcome: "succeeded"; result: IntakePlan }
  | { leaseToken: string; outcome: "succeeded"; result: HomeAssistantCalendarEventRef }
  | { leaseToken: string; outcome: "failed"; error: { code: HomeAssistantRequestErrorCode; message: string } };

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
  attachments: Array<{ id: string; filename: string; mimeType: string; sizeBytes: number }>;
  draft: IntakeDraft | null;
  error: IntakeErrorInfo | null;
  applyResults: IntakeApplyResults | null;
  homeAssistant: { workerOnline: boolean };
  paperlessAvailable: boolean;
}
