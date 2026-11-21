import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";

/**
 * "Next action" selection: the first active, unblocked task in a story's tree
 * that no longer needs clarification, in depth-first
 * pre-order (top-to-bottom, following
 * sibling `position` order at every level). Implemented as a single
 * SQLite recursive CTE that builds a lexicographically-sortable materialized
 * path per task (zero-padded position segments joined by `.`), carrying the
 * nearest ancestor story id as the legacy project id. Keeping every eligible
 * candidate lets Today pick the first canonical item for a selected member or
 * for each ownership lane.
 *
 * An otherwise-eligible task with any open (not `done`/`cancelled`)
 * action or open project descendant anywhere below it — direct or nested — is treated
 * as a container, not a candidate: it never competes with that descendant
 * for selection. Reference nodes (`task_kind = 'reference'`) are
 * transparent for this check: they neither block their ancestors from
 * candidacy on their own account, nor can they themselves ever be a
 * candidate, so an open action nested two or more reference containers
 * deep still correctly disqualifies every action above it and is still
 * itself reachable as a candidate. This is what lets pre-order naturally
 * descend into the subtree and surface the first eligible leaf action
 * instead of an ancestor action or an intervening reference container, and
 * it is intentionally central here rather than layered on by any consumer
 * (`Graph`, Today, Week/unplanned, project readiness) -- they all read this
 * one map. A blocked/waiting parent still does not prevent an eligible
 * descendant from being reached, and a parent whose actionable descendants
 * have all become terminal is free to become a candidate again. Future
 * `revisit_at` values defer a task; once reached, an ordinary revisit is
 * available without being cleared.
 */
export interface NextActionTaskIdsByProject {
  openProjectContainers: Set<number>;
  unfinishedWorkContainers: Set<number>;
  unfinishedWorkDescendantsByContainer: Map<number, number[]>;
  available: Map<number, number[]>;
  ordered: Map<number, Array<{ taskId: number; availability: "available" | "deferred" }>>;
}

export function getNextActionTaskIdsByProject(
  db: Db,
  now = new Date().toISOString(),
): Map<number, number[]> {
  return getNextActionTaskIdsByProjectProjection(db, now).available;
}

export function getNextActionTaskIdsByProjectProjection(
  db: Db,
  now = new Date().toISOString(),
): NextActionTaskIdsByProject {
  const rows = db.all<{
    project_id: number | null;
    task_id: number;
    availability: "available" | "deferred" | "project_container" | "work_container" | "work_descendant";
    key: string | null;
    descendant_id: number | null;
  }>(sql`
    WITH RECURSIVE sortkey(task_id, project_id, key) AS (
      SELECT task.id, story.id, printf('%08d', task.position)
      FROM work_items task
      JOIN work_items story ON story.id = task.parent_id AND story.role = 'story'
      WHERE task.role = 'task'
      UNION ALL
      SELECT task.id, sk.project_id, sk.key || '.' || printf('%08d', task.position)
      FROM work_items task
      JOIN sortkey sk ON task.parent_id = sk.task_id
      WHERE task.role = 'task'
    ),
    relevant_descendants(descendant_id, descendant_role, parent_id) AS (
      -- Only open actions and projects can affect the container projection.
      SELECT id, role, parent_id
      FROM work_items
      WHERE role = 'task'
        AND COALESCE(task_kind, 'action') = 'action'
        AND status NOT IN ('done', 'cancelled')
      UNION ALL
      SELECT id, role, parent_id
      FROM work_items
      WHERE role = 'story' AND archived_at IS NULL
        AND status NOT IN ('done', 'cancelled')
    ),
    ancestor_walk(node_id, descendant_id, descendant_role) AS (
      -- Walk upward from relevant descendants instead of materializing every
      -- task-to-descendant pair, including pairs in terminal or irrelevant branches.
      SELECT parent_id, descendant_id, descendant_role
      FROM relevant_descendants
      WHERE parent_id IS NOT NULL
      UNION ALL
      SELECT parent.id, walk.descendant_id, walk.descendant_role
      FROM ancestor_walk walk
      JOIN work_items current ON current.id = walk.node_id
      JOIN work_items parent ON parent.id = current.parent_id
      WHERE (
        current.role = 'task' AND parent.role IN ('task', 'story')
      ) OR (
        current.role = 'story' AND current.archived_at IS NULL
        AND current.status NOT IN ('done', 'cancelled')
        AND parent.role = 'task'
      )
    ),
    blocking_descendants AS (
      -- Each row is an open action and one of its task ancestors.
      SELECT walk.node_id AS task_id, walk.descendant_id
      FROM ancestor_walk walk
      JOIN work_items ancestor ON ancestor.id = walk.node_id AND ancestor.role = 'task'
      WHERE walk.descendant_role = 'task'
    ),
    candidates AS (
      SELECT sk.task_id, sk.project_id, sk.key
      FROM sortkey sk
      JOIN work_items t ON t.id = sk.task_id
      WHERE sk.project_id IS NOT NULL
        AND t.status = 'active'
        AND COALESCE(t.task_kind, 'action') = 'action'
        AND NOT EXISTS (
          SELECT 1 FROM task_dependencies td
          JOIN work_items dep ON dep.id = td.depends_on_task_id
          WHERE td.task_id = t.id AND dep.status NOT IN ('done', 'cancelled')
        )
        AND NOT EXISTS (
          SELECT 1 FROM task_external_waits ew WHERE ew.task_id = t.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM blocking_descendants bd WHERE bd.task_id = t.id
        )
    ),
    eligible AS (
      SELECT c.project_id, c.task_id, c.key,
        CASE
         WHEN t.revisit_at IS NULL OR julianday(t.revisit_at) <= julianday(${now})
           THEN 'available'
         ELSE 'deferred'
        END AS availability
      FROM candidates c
      JOIN work_items t ON t.id = c.task_id
    )
    SELECT project_id, task_id, availability, key, NULL AS descendant_id FROM eligible
    UNION ALL
    SELECT NULL, walk.node_id, 'project_container', NULL, NULL
    FROM ancestor_walk walk
    JOIN work_items ancestor ON ancestor.id = walk.node_id AND ancestor.role = 'task'
    WHERE walk.descendant_role = 'story'
    GROUP BY walk.node_id
    UNION ALL
    SELECT NULL, task_id, 'work_container', NULL, NULL
    FROM (SELECT DISTINCT task_id FROM blocking_descendants)
    UNION ALL
    SELECT NULL, task_id, 'work_descendant', NULL, descendant_id
    FROM blocking_descendants
    ORDER BY project_id, key
  `);
  const openProjectContainers = new Set<number>();
  const unfinishedWorkContainers = new Set<number>();
  const unfinishedWorkDescendantsByContainer = new Map<number, number[]>();
  const available = new Map<number, number[]>();
  const ordered = new Map<
    number,
    Array<{ taskId: number; availability: "available" | "deferred" }>
  >();
  for (const row of rows) {
    if (row.availability === "work_descendant") {
      if (row.descendant_id !== null) {
        const descendants =
          unfinishedWorkDescendantsByContainer.get(row.task_id) ?? [];
        descendants.push(row.descendant_id);
        unfinishedWorkDescendantsByContainer.set(row.task_id, descendants);
      }
      continue;
    }
    if (row.availability === "work_container") {
      unfinishedWorkContainers.add(row.task_id);
      continue;
    }
    if (row.availability === "project_container") {
      openProjectContainers.add(row.task_id);
      continue;
    }
    if (row.project_id === null) continue;
    if (row.availability === "available") {
      const ids = available.get(row.project_id) ?? [];
      ids.push(row.task_id);
      available.set(row.project_id, ids);
    }
    const candidates = ordered.get(row.project_id) ?? [];
    candidates.push({ taskId: row.task_id, availability: row.availability });
    ordered.set(row.project_id, candidates);
  }
  return {
    available,
    ordered,
    openProjectContainers,
    unfinishedWorkContainers,
    unfinishedWorkDescendantsByContainer,
  };
}
