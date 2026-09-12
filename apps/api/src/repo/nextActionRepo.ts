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
 * An otherwise-eligible task with any open (not `done`/`cancelled`) child
 * task is treated as a container, not a candidate: it never competes with
 * its own children for selection. This is what lets pre-order naturally
 * descend into the subtree and surface the first eligible leaf instead of
 * the parent, and it is intentionally central here rather than layered on
 * by any consumer (`Graph`, Today, Week/unplanned, project readiness) --
 * they all read this one map. A blocked/waiting parent still does not
 * prevent an eligible child from being reached, and a parent whose
 * children have all become terminal is free to become a candidate again.
 */
export function getNextActionTaskIdsByProject(db: Db): Map<number, number[]> {
  const rows = db.all<{ project_id: number; task_id: number }>(sql`
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
    eligible AS (
      SELECT sk.task_id, sk.project_id, sk.key
      FROM sortkey sk
      JOIN work_items t ON t.id = sk.task_id
      WHERE sk.project_id IS NOT NULL
        AND t.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM task_dependencies td
          JOIN work_items dep ON dep.id = td.depends_on_task_id
          WHERE td.task_id = t.id AND dep.status NOT IN ('done', 'cancelled')
        )
        AND NOT EXISTS (
          SELECT 1 FROM task_external_waits ew WHERE ew.task_id = t.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM work_items child
          WHERE child.parent_id = t.id
            AND child.role = 'task'
            AND child.status NOT IN ('done', 'cancelled')
        )
    )
    SELECT project_id, task_id FROM eligible ORDER BY project_id, key
  `);
  const result = new Map<number, number[]>();
  for (const row of rows) {
    const ids = result.get(row.project_id) ?? [];
    ids.push(row.task_id);
    result.set(row.project_id, ids);
  }
  return result;
}
