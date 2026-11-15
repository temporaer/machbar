/**
 * Locally remembered share destinations. The kind is stored alongside the
 * numeric id, so task 12 and project 12 are intentionally distinct entries.
 */
export type ShareTargetKind = "task" | "project";

export interface RecentShareTarget {
  kind: ShareTargetKind;
  id: number;
}

export const MAX_RECENT_MATERIAL_TARGETS = 5;
export const MAX_RECENT_NOTE_TARGETS = 3;

const STORAGE_KEY = "machbar:recent-share-targets";
const NOTE_STORAGE_KEY = "machbar:recent-share-note-targets";

export function readRecentMaterialTargets(): RecentShareTarget[] {
  return readTargets(STORAGE_KEY, MAX_RECENT_MATERIAL_TARGETS);
}

/** Moves the destination to the front while preserving a short typed history. */
export function rememberMaterialTarget(target: RecentShareTarget): void {
  rememberTarget(STORAGE_KEY, target, MAX_RECENT_MATERIAL_TARGETS);
}

export function readRecentNoteTargets(): RecentShareTarget[] {
  return readTargets(NOTE_STORAGE_KEY, MAX_RECENT_NOTE_TARGETS);
}

export function rememberNoteTarget(target: RecentShareTarget): void {
  rememberTarget(NOTE_STORAGE_KEY, target, MAX_RECENT_NOTE_TARGETS);
}

function rememberTarget(
  storageKey: string,
  target: RecentShareTarget,
  limit: number,
): void {
  if (!isTarget(target)) return;
  const next = dedupe([target, ...readRaw(storageKey)]).slice(0, limit);
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(next));
  } catch {
    /* localStorage may be unavailable (private mode, server rendering, tests). */
  }
}

function readTargets(storageKey: string, limit: number): RecentShareTarget[] {
  return dedupe(readRaw(storageKey)).slice(0, limit);
}

function readRaw(storageKey: string): RecentShareTarget[] {
  try {
    const raw = window.localStorage.getItem(storageKey);
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
