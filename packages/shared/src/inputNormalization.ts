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
  const calendarEvents = root.calendarEvents === undefined
    ? []
    : Array.isArray(root.calendarEvents) ? root.calendarEvents.map((entry, index) => {
    if (!isRecord(entry)) return entry;
    const item = stripFields(entry, CALENDAR_FIELDS, `calendarEvents[${index}]`, warnings);
    return {
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
  }) : root.calendarEvents;
  const workItems = root.workItems === undefined
    ? []
    : Array.isArray(root.workItems) ? root.workItems.map((entry, index) => {
    if (!isRecord(entry)) return entry;
    const item = stripFields(entry, WORK_FIELDS, `workItems[${index}]`, warnings);
    return {
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
  }) : root.workItems;
  const planWarnings = root.warnings === undefined
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
