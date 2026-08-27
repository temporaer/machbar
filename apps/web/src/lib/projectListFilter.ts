import type { ProjectWithActions } from "./api";

/** The two visibility scopes the Projekte tab's compact chips switch between. */
export type ProjectVisibilityScope = "mine" | "all";

export interface ProjectListFilterOptions {
  /** Free-text query, matched against title, notes, and completion criteria. */
  query: string;
  scope: ProjectVisibilityScope;
  /** The currently selected identity, or `null` when no member is selected yet. */
  currentMemberId: number | null;
}

export type ProjectListClassification =
  | "active-actionable"
  | "active-stuck"
  | "healthy-waiting"
  | "backlog"
  | "completed"
  | "archived";

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
  if ((project.waitingOn ?? []).some((value) => foldForSearch(value).includes(foldedQuery))) {
    return true;
  }
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

/**
 * Classifies a project for the list without changing its persisted workflow
 * status. Healthy waiting is the narrow active state with neither a next
 * action nor a stuck reason; any active stuck reason takes precedence.
 */
export function classifyProjectListItem(project: ProjectWithActions): ProjectListClassification {
  if (
    project.status === "active" &&
    project.nextAction == null &&
    project.stuckReason == null
  ) {
    return "healthy-waiting";
  }
  if (project.status === "active") {
    if (project.stuckReason != null) return "active-stuck";
    return "active-actionable";
  }
  return project.status;
}

const projectListClassificationOrder: Record<ProjectListClassification, number> = {
  "active-actionable": 0,
  "active-stuck": 1,
  "healthy-waiting": 2,
  backlog: 3,
  completed: 4,
  archived: 5,
};

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
 * Sort buckets, in order: active & actionable, active & stuck, healthy
 * waiting, backlog, completed, archived. Within a bucket, ties break on the
 * backend-assigned `position`, then the locale-aware title, then the id, so
 * the order stays stable and reproducible across reloads/retentions.
 */
export function filterAndSortProjects(
  projects: ProjectWithActions[],
  { query, scope, currentMemberId }: ProjectListFilterOptions,
): ProjectWithActions[] {
  const foldedQuery = foldForSearch(query.trim());
  const filtered = projects.filter(
    (p) =>
      matchesScope(p, scope, currentMemberId) &&
      matchesQuery(p, foldedQuery),
  );
  return filtered.sort((a, b) => {
    const bucketDiff =
      projectListClassificationOrder[classifyProjectListItem(a)] -
      projectListClassificationOrder[classifyProjectListItem(b)];
    if (bucketDiff !== 0) return bucketDiff;
    if (a.position !== b.position) return a.position - b.position;
    const titleDiff = a.title.localeCompare(b.title, "de");
    if (titleDiff !== 0) return titleDiff;
    return a.id - b.id;
  });
}
