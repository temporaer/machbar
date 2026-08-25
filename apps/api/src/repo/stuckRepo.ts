import { sql } from "drizzle-orm";
import type { StuckReason } from "@machbar/shared";
import type { Db } from "../db/client.js";

/**
 * "Festgefahren" (stuck) classification for every project, computed in a
 * single self-contained SQL statement: a recursive CTE resolves effective
 * owner ids (mirroring effectiveRepo's owner rule), open/actionable/waiting
 * counts and the blocked flag are aggregated per project, and the final
 * priority-ordered classification (unassigned_actionable > only_waiting /
 * no_next_action > blocked_dependencies > healthy) is a single SQL `CASE`.
 * Projects with no open tasks, or that are not stuck, are simply absent
 * from the returned map.
 */
export function getStuckReasonsByProject(
  db: Db,
): Map<number, StuckReason> {
  const rows = db.all<{ project_id: number; stuck_reason: StuckReason | null }>(
    sql`
    WITH RECURSIVE owner_eff(task_id, owner_id) AS (
      SELECT
        t.id,
        CASE
          WHEN t.owner_inheritance_mode = 'explicit' THEN t.owner_member_id
          WHEN t.owner_inheritance_mode = 'none' THEN NULL
          ELSE p.owner_member_id
        END
      FROM tasks t
      LEFT JOIN projects p ON p.id = t.project_id
      WHERE t.parent_task_id IS NULL

      UNION ALL

      SELECT
        t.id,
        CASE
          WHEN t.owner_inheritance_mode = 'explicit' THEN t.owner_member_id
          WHEN t.owner_inheritance_mode = 'none' THEN NULL
          ELSE oe.owner_id
        END
      FROM tasks t
      JOIN owner_eff oe ON t.parent_task_id = oe.task_id
    ),
    open_tasks AS (
      SELECT
        t.id,
        t.project_id,
        t.status,
        oe.owner_id,
        EXISTS (
          SELECT 1 FROM task_dependencies td
          JOIN tasks dep ON dep.id = td.depends_on_task_id
          WHERE td.task_id = t.id AND dep.status NOT IN ('done', 'cancelled')
        ) AS blocked
      FROM tasks t
      JOIN owner_eff oe ON oe.task_id = t.id
      WHERE t.project_id IS NOT NULL AND t.status NOT IN ('done', 'cancelled')
    ),
    agg AS (
      SELECT
        project_id,
        COUNT(*) AS open_count,
        SUM(CASE WHEN status = 'actionable' THEN 1 ELSE 0 END) AS actionable_count,
        SUM(CASE WHEN status = 'actionable' AND blocked = 0 THEN 1 ELSE 0 END) AS actionable_unblocked_count,
        SUM(CASE WHEN status = 'actionable' AND owner_id IS NULL THEN 1 ELSE 0 END) AS unassigned_actionable_count,
        SUM(CASE WHEN status = 'waiting' THEN 1 ELSE 0 END) AS waiting_count
      FROM open_tasks
      GROUP BY project_id
    )
    SELECT
      project_id,
      CASE
        WHEN unassigned_actionable_count > 0 THEN 'unassigned_actionable'
        WHEN actionable_count = 0 AND waiting_count = open_count THEN 'only_waiting'
        WHEN actionable_count = 0 THEN 'no_next_action'
        WHEN actionable_unblocked_count = 0 THEN 'blocked_dependencies'
        ELSE NULL
      END AS stuck_reason
    FROM agg
  `,
  );

  const result = new Map<number, StuckReason>();
  for (const row of rows) {
    if (row.stuck_reason) result.set(row.project_id, row.stuck_reason);
  }
  return result;
}
