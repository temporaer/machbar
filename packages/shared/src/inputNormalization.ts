export const INTAKE_NULLABLE_ABSENCE_FIELDS = new Set([
  "parentKey",
  "ownerName",
  "dueDate",
  "scheduledDate",
  "notBeforeDate",
  "notBeforeAt",
  "startDate",
  "endDate",
  "startDateTime",
  "endDateTime",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isAbsentPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  return trimmed === ""
    || /^(?:null|none)$/i.test(trimmed)
    || !/[\p{L}\p{N}]/u.test(trimmed);
}

export function normalizeNullableContractValue(value: unknown): unknown {
  return typeof value === "string" && isAbsentPlaceholder(value) ? null : value;
}

export function normalizeIntakeNullableAbsenceFields(
  value: unknown,
  options: { ownerNames?: readonly string[] } = {},
): unknown {
  if (!isRecord(value)) return value;
  const normalized = { ...value };
  for (const collection of ["calendarEvents", "workItems"]) {
    const entries = normalized[collection];
    if (!Array.isArray(entries)) continue;
    normalized[collection] = entries.map((entry) => {
      if (!isRecord(entry)) return entry;
      const item = { ...entry };
      for (const field of INTAKE_NULLABLE_ABSENCE_FIELDS) {
        if (field === "ownerName" && typeof item[field] === "string") {
          const owner = item[field].trim().toLocaleLowerCase();
          const matchesMember = options.ownerNames?.some(
            (name) => name.trim().toLocaleLowerCase() === owner,
          );
          if (matchesMember) continue;
        }
        if (field in item) item[field] = normalizeNullableContractValue(item[field]);
      }
      return item;
    });
  }
  return normalized;
}

const PLAN_FIELDS = new Set(["summary", "calendarEvents", "workItems", "warnings"]);
const CALENDAR_FIELDS = new Set([
  "key", "title", "description", "location", "allDay", "startDate", "endDate",
  "startDateTime", "endDateTime", "relatedWorkKeys",
]);
const WORK_FIELDS = new Set([
  "key", "kind", "title", "notes", "parentKey", "ownerName", "dueDate",
  "scheduledDate", "notBeforeDate", "notBeforeAt", "reminders",
  "needsClarification", "relatedCalendarKeys",
]);
const WARNING_FIELDS = new Set(["message"]);
const PROJECT_TASK_FIELDS = ["notBeforeDate", "notBeforeAt", "reminders", "needsClarification"] as const;

function stripFields(
  value: Record<string, unknown>,
  allowed: Set<string>,
  path: string,
  warnings: string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (allowed.has(key)) result[key] = item;
    else warnings.push(`Ignored unsupported intake field '${path}.${key}'.`);
  }
  return result;
}

function isMeaningfulProjectField(field: (typeof PROJECT_TASK_FIELDS)[number], value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (field === "reminders" && Array.isArray(value) && value.length === 0) return false;
  if ((field === "notBeforeDate" || field === "notBeforeAt") && typeof value === "string") {
    return !isAbsentPlaceholder(value);
  }
  return true;
}

function discardProjectTaskFields(
  item: Record<string, unknown>,
  index: number,
  warnings: string[],
): Record<string, unknown> {
  if (item.kind !== "project") return item;
  const normalized = { ...item };
  for (const field of ["notBeforeDate", "notBeforeAt"] as const) {
    if (field in normalized) normalized[field] = normalizeNullableContractValue(normalized[field]);
  }
  if (PROJECT_TASK_FIELDS.some((field) => isMeaningfulProjectField(field, normalized[field]))) {
    const key = typeof normalized.key === "string" && normalized.key.trim()
      ? normalized.key
      : String(index);
    warnings.push(`Ignored task-only fields on project '${key}'.`);
  }
  for (const field of PROJECT_TASK_FIELDS) delete normalized[field];
  normalized.notBeforeDate = null;
  normalized.notBeforeAt = null;
  normalized.reminders = [];
  normalized.needsClarification = false;
  return normalized;
}

/**
 * Repairs compact AI output without weakening the strict canonical schema.
 * Missing optional fields receive creation defaults; present values keep their
 * original type so structural diagnostics remain actionable.
 */
export function normalizeIntakePlanInput(
  value: unknown,
  options: { ownerNames?: readonly string[] } = {},
): unknown {
  if (!isRecord(value)) return value;
  const warnings: string[] = [];
  const root = stripFields(value, PLAN_FIELDS, "plan", warnings);
  const calendarEvents = root.calendarEvents == null
    ? []
    : Array.isArray(root.calendarEvents) ? root.calendarEvents.map((entry, index) => {
    if (!isRecord(entry)) return entry;
    const item = stripFields(entry, CALENDAR_FIELDS, `calendarEvents[${index}]`, warnings);
    const normalized: Record<string, unknown> = {
      description: null,
      location: null,
      allDay: false,
      startDate: null,
      endDate: null,
      startDateTime: null,
      endDateTime: null,
      relatedWorkKeys: [],
      ...item,
    };
    normalized.allDay = item.allDay ?? false;
    normalized.relatedWorkKeys = item.relatedWorkKeys ?? [];
    return normalized;
  }) : root.calendarEvents;
  const workItems = root.workItems == null
    ? []
    : Array.isArray(root.workItems) ? root.workItems.map((entry, index) => {
    if (!isRecord(entry)) return entry;
    const item = discardProjectTaskFields(
      stripFields(entry, WORK_FIELDS, `workItems[${index}]`, warnings),
      index,
      warnings,
    );
    const normalized: Record<string, unknown> = {
      notes: null,
      parentKey: null,
      ownerName: null,
      dueDate: null,
      scheduledDate: null,
      notBeforeDate: null,
      notBeforeAt: null,
      reminders: [],
      needsClarification: false,
      relatedCalendarKeys: [],
      ...item,
    };
    normalized.reminders = item.reminders ?? [];
    normalized.needsClarification = item.needsClarification ?? false;
    normalized.relatedCalendarKeys = item.relatedCalendarKeys ?? [];
    return normalized;
  }) : root.workItems;
  const planWarnings = root.warnings == null
    ? []
    : Array.isArray(root.warnings)
    ? root.warnings.map((entry) => {
        if (!isRecord(entry)) return entry;
        return stripFields(entry, WARNING_FIELDS, "warnings[]", warnings);
      })
    : root.warnings;
  const normalized = {
    ...root,
    summary: root.summary,
    calendarEvents,
    workItems,
    warnings: planWarnings,
  };
  if (warnings.length > 0 && Array.isArray(planWarnings)) {
    normalized.warnings = [
      ...planWarnings,
      ...warnings.map((message) => ({ message })),
    ];
  }
  return normalizeIntakeNullableAbsenceFields(normalized, options);
}

/**
 * Normalizes stored review drafts without projecting them through the plan
 * contract, so enabled state and resolved owner IDs remain intact.
 */
export function normalizeIntakeDraftInput(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const warnings: string[] = [];
  const calendarEvents = value.calendarEvents == null
    ? []
    : Array.isArray(value.calendarEvents)
      ? value.calendarEvents.map((entry) => {
          if (!isRecord(entry)) return entry;
          return {
            ...entry,
            allDay: entry.allDay ?? false,
            relatedWorkKeys: entry.relatedWorkKeys ?? [],
          };
        })
      : value.calendarEvents;
  const workItems = value.workItems == null
    ? []
    : Array.isArray(value.workItems)
      ? value.workItems.map((entry, index) => {
          if (!isRecord(entry)) return entry;
          const item = discardProjectTaskFields(entry, index, warnings);
          return {
            ...item,
            reminders: item.reminders ?? [],
            needsClarification: item.needsClarification ?? false,
            relatedCalendarKeys: item.relatedCalendarKeys ?? [],
          };
        })
      : value.workItems;
  const planWarnings = value.warnings == null ? [] : value.warnings;
  const normalized = {
    ...value,
    calendarEvents,
    workItems,
    warnings: Array.isArray(planWarnings) && warnings.length > 0
      ? [...planWarnings, ...warnings.map((message) => ({ message }))]
      : planWarnings,
  };
  return normalizeIntakeNullableAbsenceFields(normalized);
}

export function resolveOwnerSuggestion<T extends { id: number; name: string }>(
  value: unknown,
  members: readonly T[],
): T | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLocaleLowerCase();
  if (!normalized) return null;
  return members.find((member) => member.name.trim().toLocaleLowerCase() === normalized) ?? null;
}

export function isAbsentOwnerSuggestion(value: unknown): boolean {
  return value === null || (typeof value === "string" && isAbsentPlaceholder(value));
}
