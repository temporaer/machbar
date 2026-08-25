import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";

/**
 * Dependency-graph queries: cycle detection and "blocked" derivation, both
 * expressed as SQLite recursive CTEs / set queries through Drizzle's raw
 * `sql` tag rather than by walking edges one row at a time in application
 * code.
 */

/**
 * Would adding an edge `taskId -> dependsOnTaskId` (task depends on
 * dependsOnTaskId) create a cycle? True if `dependsOnTaskId` can already
 * (transitively) reach `taskId` through the existing dependency graph.
 */
export function wouldCreateDependencyCycle(
  db: Db,
  taskId: number,
  dependsOnTaskId: number,
): boolean {
  if (taskId === dependsOnTaskId) return true;
  const row = db.get<{ reaches: number }>(sql`
    WITH RECURSIVE reachable(id) AS (
      SELECT depends_on_task_id AS id FROM task_dependencies WHERE task_id = ${dependsOnTaskId}
      UNION ALL
      SELECT td.depends_on_task_id FROM task_dependencies td
      JOIN reachable r ON td.task_id = r.id
    )
    SELECT EXISTS(SELECT 1 FROM reachable WHERE id = ${taskId}) AS reaches
  `);
  return row?.reaches === 1;
}

/**
 * A task is blocked when at least one of its dependencies points at a task
 * that is not yet done/cancelled. Computed for every task in a single
 * query; returns the set of blocked task ids.
 */
export function getBlockedTaskIds(db: Db): Set<number> {
  const rows = db.all<{ id: number }>(sql`
    SELECT t.id AS id
    FROM tasks t
    WHERE EXISTS (
      SELECT 1 FROM task_dependencies td
      JOIN tasks dep ON dep.id = td.depends_on_task_id
      WHERE td.task_id = t.id AND dep.status NOT IN ('done', 'cancelled')
    )
  `);
  return new Set(rows.map((r) => r.id));
}
