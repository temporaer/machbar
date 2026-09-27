import type {
  IntakeDraftCalendarEvent,
  IntakeDraftWorkItem,
  IntakeIssue,
} from "@machbar/shared";

const BERLIN_TIME_ZONE = "Europe/Berlin";

function berlinDateTimeParts(value: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: BERLIN_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  return Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
}

export function berlinDateForInstant(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = berlinDateTimeParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function berlinWallTimeToIso(date: string, time: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const clock = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match || !clock) return null;
  const [, year, month, day] = match.map(Number);
  const [, hour, minute] = clock.map(Number);
  const calendarCheck = new Date(Date.UTC(year!, month! - 1, day!));
  if (
    calendarCheck.getUTCFullYear() !== year ||
    calendarCheck.getUTCMonth() !== month! - 1 ||
    calendarCheck.getUTCDate() !== day ||
    hour! > 23 ||
    minute! > 59
  ) {
    return null;
  }
  const desired = Date.UTC(year!, month! - 1, day!, hour!, minute!);
  let candidate = desired;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = berlinDateTimeParts(new Date(candidate));
    const represented = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    const difference = desired - represented;
    if (difference === 0) return new Date(candidate).toISOString();
    candidate += difference;
  }
  return null;
}

export function transitionCalendarAllDay(
  event: IntakeDraftCalendarEvent,
  allDay: boolean,
): IntakeDraftCalendarEvent {
  if (event.allDay === allDay) return event;
  if (allDay) {
    return {
      ...event,
      allDay: true,
      startDate: berlinDateForInstant(event.startDateTime),
      endDate: berlinDateForInstant(event.endDateTime),
      startDateTime: null,
      endDateTime: null,
      durationAssumed: false,
    };
  }
  return {
    ...event,
    allDay: false,
    startDate: null,
    endDate: null,
    startDateTime: event.startDate
      ? berlinWallTimeToIso(event.startDate, "09:00")
      : null,
    endDateTime: null,
    durationAssumed: false,
  };
}

function canParent(
  parent: IntakeDraftWorkItem,
  childKind: IntakeDraftWorkItem["kind"],
): boolean {
  return parent.kind === "project" ||
    (parent.kind === "action" && childKind !== "project");
}

function nearestLegalParent(
  key: string,
  parentKey: string | null,
  kind: IntakeDraftWorkItem["kind"],
  byKey: ReadonlyMap<string, IntakeDraftWorkItem>,
): string | null {
  let parent = parentKey ? byKey.get(parentKey) : undefined;
  const seen = new Set<string>();
  while (parent && !seen.has(parent.key)) {
    if (parent.key !== key && canParent(parent, kind)) {
      return parent.key;
    }
    seen.add(parent.key);
    parent = parent.parentKey ? byKey.get(parent.parentKey) : undefined;
  }
  return null;
}

function normalizedWorkItemKind(
  item: IntakeDraftWorkItem,
  kind: IntakeDraftWorkItem["kind"],
  parentKey: string | null,
): IntakeDraftWorkItem {
  const base = { ...item, kind, parentKey };
  if (kind === "project") {
    return {
      ...base,
      scheduledDate: null,
      notBeforeDate: null,
      notBeforeAt: null,
      reminderAt: null,
      needsClarification: false,
    };
  }
  if (kind === "reference") {
    return {
      ...base,
      ownerMemberId: null,
      dueDate: null,
      scheduledDate: null,
      notBeforeDate: null,
      notBeforeAt: null,
      reminderAt: null,
      needsClarification: false,
    };
  }
  return {
    ...base,
    scheduledDate: null,
    notBeforeDate: null,
    notBeforeAt: null,
    reminderAt: null,
    needsClarification: false,
  };
}

export function transitionWorkItemKind(
  items: readonly IntakeDraftWorkItem[],
  key: string,
  kind: IntakeDraftWorkItem["kind"],
): IntakeDraftWorkItem[] {
  const selected = items.find((item) => item.key === key);
  if (!selected || selected.kind === kind) return [...items];
  const byKey = new Map(items.map((item) => [item.key, item]));
  const parentKey = nearestLegalParent(key, selected.parentKey, kind, byKey);
  const changed = normalizedWorkItemKind(selected, kind, parentKey);
  byKey.set(key, changed);
  return items.map((item) => {
    if (item.key === key) return changed;
    if (item.parentKey !== key || canParent(changed, item.kind)) return item;
    return {
      ...item,
      parentKey: nearestLegalParent(item.key, changed.parentKey, item.kind, byKey),
    };
  });
}

export function workItemDepths(items: readonly IntakeDraftWorkItem[]): number[] {
  const byKey = new Map(items.map((item) => [item.key, item]));
  const depths = new Map<string, number>();
  const depthFor = (item: IntakeDraftWorkItem, visiting = new Set<string>()): number => {
    const cached = depths.get(item.key);
    if (cached !== undefined) return cached;
    if (!item.parentKey || visiting.has(item.key)) return 0;
    const parent = byKey.get(item.parentKey);
    if (!parent) return 0;
    const nextVisiting = new Set(visiting);
    nextVisiting.add(item.key);
    const depth = depthFor(parent, nextVisiting) + 1;
    depths.set(item.key, depth);
    return depth;
  };
  return items.map((item) => depthFor(item));
}

export function issuesForPath(
  issues: readonly IntakeIssue[],
  path: readonly (string | number)[],
): IntakeIssue[] {
  return issues.filter(
    (issue) =>
      issue.path.length === path.length &&
      issue.path.every((segment, index) => segment === path[index]),
  );
}
