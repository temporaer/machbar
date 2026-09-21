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
 * *actionable* descendant anywhere below it — direct or nested — is treated
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
 * have all become terminal is free to become a candidate again. Tasks
 * whose `not_before_at` is later than `now` are likewise excluded.
 */
export interface NextActionTaskIdsByProject {
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
    project_id: number;
    task_id: number;
    availability: "available" | "deferred";
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
    task_descendants(ancestor_id, descendant_id) AS (
      SELECT id, id FROM work_items WHERE role = 'task'
      UNION ALL
      SELECT td.ancestor_id, child.id
      FROM task_descendants td
      JOIN work_items child ON child.parent_id = td.descendant_id
      WHERE child.role = 'task'
    ),
    blocking_descendants AS (
      -- Every task that has at least one open actionable descendant
      -- (direct or nested through any depth of reference containers).
      SELECT DISTINCT td.ancestor_id AS task_id
      FROM task_descendants td
      JOIN work_items descendant ON descendant.id = td.descendant_id
      WHERE td.descendant_id != td.ancestor_id
        AND COALESCE(descendant.task_kind, 'action') = 'action'
        AND descendant.status NOT IN ('done', 'cancelled')
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
         WHEN t.not_before_at IS NULL OR t.not_before_at <= ${now}
           THEN 'available'
         ELSE 'deferred'
        END AS availability
      FROM candidates c
      JOIN work_items t ON t.id = c.task_id
    )
    SELECT project_id, task_id, availability
    FROM eligible
    ORDER BY project_id, key
  `);
  const available = new Map<number, number[]>();
  const ordered = new Map<
    number,
    Array<{ taskId: number; availability: "available" | "deferred" }>
  >();
  for (const row of rows) {
    if (row.availability === "available") {
      const ids = available.get(row.project_id) ?? [];
      ids.push(row.task_id);
      available.set(row.project_id, ids);
    }
    const candidates = ordered.get(row.project_id) ?? [];
    candidates.push({ taskId: row.task_id, availability: row.availability });
    ordered.set(row.project_id, candidates);
  }
  return { available, ordered };
}
