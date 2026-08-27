/**
 * Locally remembered share destinations. The kind is stored alongside the
 * numeric id, so task 12 and project 12 are intentionally distinct entries.
 */
export type ShareTargetKind = "task" | "project";

export interface RecentShareTarget {
  kind: ShareTargetKind;
  id: number;
}

export const MAX_RECENT_SHARE_TARGETS = 5;

const STORAGE_KEY = "machbar:recent-share-targets";

export function readRecentShareTargets(): RecentShareTarget[] {
  return dedupe(readRaw()).slice(0, MAX_RECENT_SHARE_TARGETS);
}

/** Moves the destination to the front while preserving a short typed history. */
export function rememberShareTarget(target: RecentShareTarget): void {
  if (!isTarget(target)) return;
  const next = dedupe([target, ...readRaw()]).slice(0, MAX_RECENT_SHARE_TARGETS);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* localStorage may be unavailable (private mode, server rendering, tests). */
  }
}

function readRaw(): RecentShareTarget[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isTarget) : [];
  } catch {
    return [];
  }
}

function isTarget(value: unknown): value is RecentShareTarget {
  if (typeof value !== "object" || value === null) return false;
  const target = value as { kind?: unknown; id?: unknown };
  return (
    (target.kind === "task" || target.kind === "project") &&
    typeof target.id === "number" &&
    Number.isInteger(target.id)
  );
}

function dedupe(targets: RecentShareTarget[]): RecentShareTarget[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = `${target.kind}:${target.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
