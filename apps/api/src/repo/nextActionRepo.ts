import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";

/**
 * "Next action" selection: the first actionable, unblocked task in a
 * project's tree, in depth-first pre-order (top-to-bottom, following
 * sibling `position` order at every level). Implemented as a single
 * SQLite recursive CTE that builds a lexicographically-sortable materialized
 * path per task (zero-padded position segments joined by `.`), combined
 * with a window function to pick the best candidate per project in one
 * query — no per-project queries and no DFS walk in application code.
 */
export function getNextActionTaskIdsByProject(db: Db): Map<number, number> {
  const rows = db.all<{ project_id: number; task_id: number }>(sql`
    WITH RECURSIVE sortkey(task_id, project_id, key) AS (
      SELECT id, project_id, printf('%08d', position) FROM tasks WHERE parent_task_id IS NULL
      UNION ALL
      SELECT t.id, t.project_id, sk.key || '.' || printf('%08d', t.position)
      FROM tasks t JOIN sortkey sk ON t.parent_task_id = sk.task_id
    ),
    ranked AS (
      SELECT sk.task_id, sk.project_id,
        ROW_NUMBER() OVER (PARTITION BY sk.project_id ORDER BY sk.key ASC) AS rn
      FROM sortkey sk
      JOIN tasks t ON t.id = sk.task_id
      WHERE sk.project_id IS NOT NULL
        AND t.status = 'actionable'
        AND NOT EXISTS (
          SELECT 1 FROM task_dependencies td
          JOIN tasks dep ON dep.id = td.depends_on_task_id
          WHERE td.task_id = t.id AND dep.status NOT IN ('done', 'cancelled')
        )
    )
    SELECT project_id, task_id FROM ranked WHERE rn = 1
  `);
  return new Map(rows.map((r) => [r.project_id, r.task_id]));
}
