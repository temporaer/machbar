import { sql } from "drizzle-orm";
import type { StuckReason } from "@machbar/shared";
import type { Db } from "../db/client.js";

/**
 * "Festgefahren" (stuck) classification for every project, computed in a
 * single self-contained SQL statement: a recursive CTE resolves effective
 * owner ids (mirroring effectiveRepo's owner rule), open/actionable/waiting
 * counts and the blocked flag are aggregated per project, and the final
 * priority-ordered classification is a single SQL `CASE`.
 *
 * Only `active` projects can be stuck — `backlog`, `completed` and
 * `archived` projects are excluded outright, regardless of their task
 * state. Within `active` projects, the classification (highest priority
 * first) is:
 *
 * Captured open tasks contribute to `open_count`, but not to actionable,
 * unassigned-actionable, waiting, or revisit counts until clarified. This
 * keeps captured-only projects open while correctly classifying them as
 * `no_next_action`.
 *
 *   1. no `next_action` at all: zero tasks in the project => `no_next_action`.
 *   2. tasks exist but none are open (all `done`/`cancelled`) => the
 *      project isn't "stuck" for lack of a next step, it just needs a
 *      human decision (complete/reopen/archive) => `completion_review`.
 *   3. every open task is `waiting` and every one carries a future
 *      `scheduled_date` => healthy. The project is deliberately parked.
 *      A reached Wiedervorlage is `followup_due`; a missing one is
 *      `only_waiting_without_followup`.
 *   4. actionable work whose unresolved dependency graph consists only of
 *      clarified actionable links ending in either an unblocked actionable
 *      task or a future scheduled, clarified waiting task is also healthy.
 *      Every other open task in the project must be
 *      either actionable or a scheduled waiting task; this prevents an
 *      unrelated someday/captured/unscheduled task from being hidden.
 *   5. otherwise, the original open-task-based rules apply unchanged:
 *      `unassigned_actionable` > `only_waiting` / `no_next_action` >
 *      `blocked_dependencies` > healthy (absent from the map).
 *
 * Projects that are not stuck (healthy, or excluded by status) are simply
 * absent from the returned map.
 */
export function getStuckReasonsByProject(
  db: Db,
  today = new Date().toISOString().slice(0, 10),
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
        t.scheduled_date,
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
    dependency_walk(project_id, task_id) AS (
      SELECT ot.project_id, dep.id
      FROM open_tasks ot
      JOIN task_dependencies td ON td.task_id = ot.id
      JOIN tasks dep ON dep.id = td.depends_on_task_id
      WHERE ot.status = 'actionable'
        AND dep.status NOT IN ('done', 'cancelled')

      UNION

      SELECT dw.project_id, dep.id
      FROM dependency_walk dw
      JOIN tasks current ON current.id = dw.task_id
      JOIN task_dependencies td ON td.task_id = current.id
      JOIN tasks dep ON dep.id = td.depends_on_task_id
      WHERE (
          current.status = 'actionable'
          OR (
            current.status = 'waiting'
            AND current.scheduled_date IS NOT NULL
            AND TRIM(current.scheduled_date) <> ''
            AND current.scheduled_date > ${today}
          )
        )
        AND dep.status NOT IN ('done', 'cancelled')
    ),
    agg AS (
      SELECT
        project_id,
        COUNT(*) AS open_count,
        SUM(CASE WHEN status = 'actionable' THEN 1 ELSE 0 END) AS actionable_count,
        SUM(CASE WHEN status = 'actionable' AND blocked = 0 THEN 1 ELSE 0 END) AS actionable_unblocked_count,
        SUM(CASE WHEN status = 'actionable' AND owner_id IS NULL THEN 1 ELSE 0 END) AS unassigned_actionable_count,
        SUM(CASE WHEN status = 'waiting' THEN 1 ELSE 0 END) AS waiting_count,
        SUM(
          CASE
            WHEN (
                status = 'actionable'
                OR (
                  status = 'waiting'
                  AND scheduled_date IS NOT NULL
                  AND TRIM(scheduled_date) <> ''
                )
              )
            THEN 0 ELSE 1
          END
        ) AS parking_disqualifier_count,
        SUM(
          CASE
            WHEN status = 'waiting'
              AND scheduled_date IS NOT NULL
              AND TRIM(scheduled_date) <> ''
              AND scheduled_date > ${today}
            THEN 1 ELSE 0
          END
        ) AS waiting_future_count,
        SUM(
          CASE
            WHEN status = 'waiting'
              AND scheduled_date IS NOT NULL
              AND TRIM(scheduled_date) <> ''
              AND scheduled_date <= ${today}
            THEN 1 ELSE 0
          END
        ) AS waiting_due_count
      FROM open_tasks
      GROUP BY project_id
    ),
    totals AS (
      SELECT project_id, COUNT(*) AS total_count
      FROM tasks
      WHERE project_id IS NOT NULL
      GROUP BY project_id
    )
    SELECT
      p.id AS project_id,
      CASE
        WHEN COALESCE(tot.total_count, 0) = 0 THEN 'no_next_action'
        WHEN COALESCE(agg.open_count, 0) = 0 THEN 'completion_review'
        WHEN agg.unassigned_actionable_count > 0 THEN 'unassigned_actionable'
        WHEN agg.actionable_count = 0
          AND agg.waiting_count = agg.open_count
          AND agg.waiting_future_count = agg.open_count THEN NULL
        WHEN agg.actionable_count = 0
          AND agg.waiting_count = agg.open_count
          AND agg.waiting_due_count > 0 THEN 'followup_due'
        WHEN agg.actionable_count = 0 AND agg.waiting_count = agg.open_count THEN 'only_waiting_without_followup'
        WHEN agg.actionable_count = 0 THEN 'no_next_action'
        WHEN agg.actionable_unblocked_count = 0
          AND agg.parking_disqualifier_count = 0
          AND NOT EXISTS (
            SELECT 1
            FROM dependency_walk dw
            JOIN tasks blocker ON blocker.id = dw.task_id
            LEFT JOIN projects blocker_project
              ON blocker_project.id = blocker.project_id
            WHERE dw.project_id = p.id
              AND NOT (
                (
                  blocker.project_id IS NULL
                  OR blocker_project.status = 'active'
                )
                AND (
                  (
                    blocker.status = 'waiting'
                    AND blocker.scheduled_date IS NOT NULL
                    AND TRIM(blocker.scheduled_date) <> ''
                    AND blocker.scheduled_date > ${today}
                  )
                  OR blocker.status = 'actionable'
                )
              )
          ) THEN NULL
        WHEN agg.actionable_unblocked_count = 0 THEN 'blocked_dependencies'
        ELSE NULL
      END AS stuck_reason
    FROM projects p
    LEFT JOIN totals tot ON tot.project_id = p.id
    LEFT JOIN agg ON agg.project_id = p.id
    WHERE p.status = 'active'
  `,
  );

  const result = new Map<number, StuckReason>();
  for (const row of rows) {
    if (row.stuck_reason) result.set(row.project_id, row.stuck_reason);
  }
  return result;
}
