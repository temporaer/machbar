/**
 * Recently opened tasks/projects, persisted locally as a soft ranking
 * signal for search and pickers — never a source of truth and never a Task
 * domain property. Modeled on `recentDestinations.ts`: bounded, timestamped,
 * and a missing/corrupt entry degrades to "no boost" rather than failing.
 *
 * Entries decay: anything older than `RECENCY_WINDOW_MS` stops contributing
 * a boost at all, so a stale open from weeks ago cannot outrank a clearly
 * better text match today.
 */
export type RecencyKind = "task" | "project";

const MAX_RECENT_ENTRIES = 20;
const RECENCY_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

const STORAGE_KEY_BY_KIND: Record<RecencyKind, string> = {
  task: "machbar:recently-viewed:task",
  project: "machbar:recently-viewed:project",
};

interface RecentlyViewedEntry {
  id: number;
  at: number;
}

function isRecentlyViewedEntry(value: unknown): value is RecentlyViewedEntry {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as RecentlyViewedEntry).id === "number" &&
    Number.isInteger((value as RecentlyViewedEntry).id) &&
    typeof (value as RecentlyViewedEntry).at === "number"
  );
}

function readEntries(kind: RecencyKind): RecentlyViewedEntry[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY_BY_KIND[kind]);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecentlyViewedEntry);
  } catch {
    // localStorage may be unavailable (private mode, tests) or hold garbage.
    return [];
  }
}

/**
 * Records `id` as just opened/selected, most-recent-first, de-duplicated
 * and bounded. Call this on meaningful opens/selections, not every render.
 */
export function recordRecentlyViewed(kind: RecencyKind, id: number): void {
  const next = [
    { id, at: Date.now() },
    ...readEntries(kind).filter((entry) => entry.id !== id),
  ].slice(0, MAX_RECENT_ENTRIES);
  try {
    window.localStorage.setItem(STORAGE_KEY_BY_KIND[kind], JSON.stringify(next));
  } catch {
    /* localStorage may be unavailable (private mode, tests) */
  }
}

/**
 * A ranking-ready lookup for `sortOrder.ts`'s `recencyRank`: 0 for the most
 * recently viewed id, increasing for less-recent ones, and `Infinity` for
 * anything not viewed within the recency window. A sort key, not a
 * user-visible value.
 */
export function recencyRankLookup(
  kind: RecencyKind,
  now: number = Date.now(),
): (id: number) => number {
  const fresh = readEntries(kind).filter(
    (entry) => now - entry.at <= RECENCY_WINDOW_MS,
  );
  const rankById = new Map<number, number>();
  fresh.forEach((entry, index) => {
    if (!rankById.has(entry.id)) rankById.set(entry.id, index);
  });
  return (id: number) => rankById.get(id) ?? Number.POSITIVE_INFINITY;
}
