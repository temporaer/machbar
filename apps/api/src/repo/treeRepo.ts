import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";

/**
 * Hierarchy queries (descendants / ancestors / cycle checks) expressed as
 * SQLite recursive CTEs and executed through Drizzle's raw `sql` tag. These
 * intentionally do NOT walk `parentTaskId` pointers node-by-node in
 * application code — the tree traversal itself is pushed down into SQL, and
 * this repository is the only place that owns that SQL.
 */

/** Every descendant (any depth) of `rootId`, excluding the root itself. */
export function getDescendantIds(db: Db, rootId: number): number[] {
  const rows = db.all<{ id: number }>(sql`
    WITH RECURSIVE descendants(id) AS (
      SELECT id FROM tasks WHERE parent_task_id = ${rootId}
      UNION ALL
      SELECT t.id FROM tasks t JOIN descendants d ON t.parent_task_id = d.id
    )
    SELECT id FROM descendants
  `);
  return rows.map((r) => r.id);
}

/**
 * Every ancestor of `taskId`, nearest first (immediate parent, grandparent,
 * ...), excluding the task itself.
 */
export function getAncestorIds(db: Db, taskId: number): number[] {
  const rows = db.all<{ id: number }>(sql`
    WITH RECURSIVE ancestors(id) AS (
      SELECT parent_task_id AS id FROM tasks
      WHERE id = ${taskId} AND parent_task_id IS NOT NULL
      UNION ALL
      SELECT t.parent_task_id FROM tasks t
      JOIN ancestors a ON t.id = a.id
      WHERE t.parent_task_id IS NOT NULL
    )
    SELECT id FROM ancestors
  `);
  return rows.map((r) => r.id);
}

/**
 * Would re-parenting `taskId` under `candidateParentId` create a hierarchy
 * cycle? True if the candidate parent is the task itself or one of its
 * existing descendants.
 */
export function wouldCreateHierarchyCycle(
  db: Db,
  taskId: number,
  candidateParentId: number,
): boolean {
  if (taskId === candidateParentId) return true;
  const row = db.get<{ is_cycle: number }>(sql`
    SELECT EXISTS (
      WITH RECURSIVE descendants(id) AS (
        SELECT id FROM tasks WHERE parent_task_id = ${taskId}
        UNION ALL
        SELECT t.id FROM tasks t JOIN descendants d ON t.parent_task_id = d.id
      )
      SELECT 1 FROM descendants WHERE id = ${candidateParentId}
    ) AS is_cycle
  `);
  return row?.is_cycle === 1;
}
