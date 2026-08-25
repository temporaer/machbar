/**
 * Recently chosen refile destinations, persisted locally.
 *
 * Refiling is repetitive: the same handful of projects and parent tasks
 * absorb most moves, so surfacing them first turns a scroll-and-search into
 * a single tap. The list is deliberately tiny and local-only — it is a
 * convenience cache, never a source of truth, so it is never synced and a
 * missing/corrupt entry simply degrades to "no recents".
 *
 * Entries are recorded on a *successful* move, most recent first,
 * de-duplicated by id and capped at `MAX_RECENT_DESTINATIONS`. Ids that no
 * longer resolve to an available destination are filtered out at read time
 * by `pickRecent` rather than pruned from storage: a project can be missing
 * from one picker (e.g. excluded as a task's own subtree) while still being
 * a perfectly good destination for the next one.
 */
export type DestinationKind = "project" | "parent";

export const MAX_RECENT_DESTINATIONS = 5;

const STORAGE_KEY_BY_KIND: Record<DestinationKind, string> = {
  project: "machbar:recent-destinations:project",
  parent: "machbar:recent-destinations:parent",
};

function readRaw(kind: DestinationKind): number[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY_BY_KIND[kind]);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is number => typeof id === "number" && Number.isInteger(id));
  } catch {
    // localStorage may be unavailable (private mode, tests) or hold garbage.
    return [];
  }
}

export function readRecentDestinationIds(kind: DestinationKind): number[] {
  return dedupe(readRaw(kind)).slice(0, MAX_RECENT_DESTINATIONS);
}

/** Moves `id` to the front, keeping the list de-duplicated and bounded. */
export function rememberDestination(kind: DestinationKind, id: number | null): void {
  if (id === null) return;
  const next = dedupe([id, ...readRaw(kind)]).slice(0, MAX_RECENT_DESTINATIONS);
  try {
    window.localStorage.setItem(STORAGE_KEY_BY_KIND[kind], JSON.stringify(next));
  } catch {
    /* localStorage may be unavailable (private mode, tests) */
  }
}

/**
 * Returns the still-available recents in most-recent-first order. Anything
 * that is no longer a legal destination (archived, deleted, or excluded by
 * the caller's own subtree/cycle rules) is dropped silently.
 */
export function pickRecent<T extends { id: number }>(
  kind: DestinationKind,
  available: T[],
): T[] {
  const byId = new Map(available.map((item) => [item.id, item]));
  const picked: T[] = [];
  for (const id of readRecentDestinationIds(kind)) {
    const item = byId.get(id);
    if (item) picked.push(item);
  }
  return picked;
}

function dedupe(ids: number[]): number[] {
  return [...new Set(ids)];
}
