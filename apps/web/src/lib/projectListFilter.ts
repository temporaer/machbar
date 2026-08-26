import type { ProjectWithActions } from "./api";
import type { Tag } from "@machbar/shared";

/** The two visibility scopes the Projekte tab's compact chips switch between. */
export type ProjectVisibilityScope = "mine" | "all";

export interface ProjectListFilterOptions {
  /** Free-text query, matched against title, notes, and completion criteria. */
  query: string;
  scope: ProjectVisibilityScope;
  /** The currently selected identity, or `null` when no member is selected yet. */
  currentMemberId: number | null;
  areaTagId?: number | undefined;
}

/** Strips diacritics and lower-cases so "Cafe" matches "Café" and vice versa. */
function foldForSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function matchesQuery(project: ProjectWithActions, foldedQuery: string): boolean {
  if (!foldedQuery) return true;
  if (foldForSearch(project.title).includes(foldedQuery)) return true;
  if (foldForSearch(project.notes).includes(foldedQuery)) return true;
  return (project.acceptanceCriteria ?? []).some((c) => foldForSearch(c.text).includes(foldedQuery));
}

/**
 * Default visibility is "mine & open": the selected member's own stories plus
 * every unassigned one, so nothing anybody could still pick up gets hidden.
 * With no identity selected there is no "mine" to speak of, so the default
 * scope sensibly collapses to unassigned-only rather than showing nothing —
 * or everything.
 */
function matchesScope(project: ProjectWithActions, scope: ProjectVisibilityScope, currentMemberId: number | null): boolean {
  if (scope === "all") return true;
  if (currentMemberId === null) return project.ownerMemberId === null;
  return project.ownerMemberId === null || project.ownerMemberId === currentMemberId;
}

/** Sort bucket a story falls into, in display order. */
function bucketOf(project: ProjectWithActions): number {
  if (project.status === "active") return project.stuckReason ? 1 : 0;
  if (project.status === "backlog") return 2;
  if (project.status === "completed") return 3;
  return 4; // archived
}

/**
 * A story is "terminal" once it has left the active workflow for good:
 * completed or archived. The Projekte tab groups these two statuses into
 * one folded section below the primary (active/backlog) list, so this is
 * the single place that decides which statuses count as terminal.
 */
export function isTerminalProjectStatus(project: ProjectWithActions): boolean {
  return project.status === "completed" || project.status === "archived";
}

/**
 * Filters (search text + visibility scope), then deterministically sorts, the
 * Projekte tab's story list. Filtering always runs before sorting so a
 * bucket never contains a story the current search/scope would hide.
 *
 * Sort buckets, in order: active & healthy, active & stuck (`stuckReason`
 * set), backlog, completed, archived. Within a bucket, ties break on the
 * backend-assigned `position`, then the locale-aware title, then the id —
 * so the order stays stable and reproducible across reloads/retentions.
 */
export function filterAndSortProjects(
  projects: ProjectWithActions[],
  { query, scope, currentMemberId, areaTagId }: ProjectListFilterOptions,
): ProjectWithActions[] {
  const foldedQuery = foldForSearch(query.trim());
  const filtered = projects.filter(
    (p) =>
      matchesScope(p, scope, currentMemberId) &&
      matchesQuery(p, foldedQuery) &&
      (areaTagId === undefined ||
        p.effectiveAreaTags.some((tag) => tag.id === areaTagId)),
  );
  return filtered.sort((a, b) => {
    const bucketDiff = bucketOf(a) - bucketOf(b);
    if (bucketDiff !== 0) return bucketDiff;
    if (a.position !== b.position) return a.position - b.position;
    const titleDiff = a.title.localeCompare(b.title, "de");
    if (titleDiff !== 0) return titleDiff;
    return a.id - b.id;
  });
}

export interface ProjectAreaGroup {
  area: Tag | null;
  projects: ProjectWithActions[];
}

export function groupProjectsByArea(
  projects: ProjectWithActions[],
): ProjectAreaGroup[] {
  const groups = new Map<number | null, ProjectAreaGroup>();
  for (const project of projects) {
    const area = project.primaryAreaTag;
    const key = area?.id ?? null;
    const group = groups.get(key) ?? { area, projects: [] };
    group.projects.push(project);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => {
    if (a.area === null) return b.area === null ? 0 : 1;
    if (b.area === null) return -1;
    const pinned =
      Number(b.area.groupingMode === "pinned") -
      Number(a.area.groupingMode === "pinned");
    if (pinned !== 0) return pinned;
    const position =
      (a.area.sortPosition ?? Number.MAX_SAFE_INTEGER) -
      (b.area.sortPosition ?? Number.MAX_SAFE_INTEGER);
    if (position !== 0) return position;
    const name = a.area.name.localeCompare(b.area.name, "de");
    return name !== 0 ? name : a.area.id - b.area.id;
  });
}
