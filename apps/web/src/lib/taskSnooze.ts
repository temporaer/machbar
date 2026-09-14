/**
 * Storage for the member-scoped, ephemeral same-day "Später" snooze
 * ("Heute Abend" / "In einer Weile"). This deliberately does not touch
 * `scheduledDate` or any other server-side field: today is still the
 * scheduled day, the task is unchanged for every other household member,
 * and the snooze naturally stops applying once `until` has passed — see
 * `TaskLaterSheet.tsx` (writer) and `taskSnoozeContext.tsx` (the
 * member-scoped provider that reads this and prunes expired entries).
 */
export interface TaskSnoozeEntry {
  taskId: number;
  /** ISO instant; the task counts as actively snoozed only until this passes. */
  until: string;
}

const STORAGE_KEY_PREFIX = "machbar:task-snooze";

function storageKey(memberId: number | null): string {
  return memberId === null ? STORAGE_KEY_PREFIX : `${STORAGE_KEY_PREFIX}:${memberId}`;
}

function isTaskSnoozeEntry(value: unknown): value is TaskSnoozeEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as TaskSnoozeEntry).taskId === "number" &&
    typeof (value as TaskSnoozeEntry).until === "string"
  );
}

export function readSnoozeEntries(memberId: number | null = null): TaskSnoozeEntry[] {
  try {
    const raw = window.localStorage.getItem(storageKey(memberId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isTaskSnoozeEntry) : [];
  } catch {
    return [];
  }
}

export function writeSnoozeEntries(
  entries: readonly TaskSnoozeEntry[],
  memberId: number | null = null,
): void {
  try {
    window.localStorage.setItem(storageKey(memberId), JSON.stringify(entries));
  } catch {
    // localStorage may be unavailable in private mode, SSR, or tests.
  }
}

/** Whether `entry` is still in effect at `now` — expired entries are pruned by the provider. */
export function isSnoozeActive(entry: TaskSnoozeEntry, now = new Date()): boolean {
  return new Date(entry.until).getTime() > now.getTime();
}
