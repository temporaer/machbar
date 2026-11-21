import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";

/** Marks one bounded bottom-up batch of terminal work items. An item is only
 * eligible after every direct child is already archived, so no open descendant
 * can be hidden by an archived ancestor. The UPDATE repeats the eligibility
 * predicate atomically; a concurrent reopen or reparent therefore wins or
 * makes this statement fail rather than allowing a stale candidate through. */
export function archiveTerminalWorkBatch(
  db: Db,
  options: { now?: string; limit?: number } = {},
): number {
  const now = options.now ?? new Date().toISOString();
  const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 100)));
  const updated = db.all<{ id: number }>(sql`
    WITH candidates AS (
      SELECT candidate.id
      FROM work_items candidate
      WHERE candidate.operational_archived_at IS NULL
        AND (
          (
            candidate.role = 'task'
            AND COALESCE(candidate.task_kind, 'action') != 'reference'
            AND candidate.status IN ('done', 'cancelled')
            AND candidate.repeat_after_days IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM task_external_waits wait
              WHERE wait.task_id = candidate.id
            )
          )
          OR (
            candidate.role = 'story'
            AND (candidate.status = 'done' OR candidate.archived_at IS NOT NULL)
          )
        )
        AND NOT EXISTS (
          SELECT 1 FROM work_items child
          WHERE child.parent_id = candidate.id
            AND child.operational_archived_at IS NULL
        )
        -- Active project summaries and completion review depend on their
        -- terminal children, so retain that small historical working set.
        AND NOT EXISTS (
          WITH RECURSIVE ancestors(id) AS (
            SELECT candidate.parent_id WHERE candidate.parent_id IS NOT NULL
            UNION ALL
            SELECT parent.parent_id
            FROM work_items parent JOIN ancestors a ON parent.id = a.id
            WHERE parent.parent_id IS NOT NULL
          )
          SELECT 1
          FROM ancestors a JOIN work_items ancestor ON ancestor.id = a.id
          WHERE ancestor.role = 'story' AND ancestor.status = 'active'
            AND ancestor.archived_at IS NULL
        )
      ORDER BY candidate.id
      LIMIT ${limit}
    )
    UPDATE work_items
    SET operational_archived_at = ${now}
    WHERE id IN (SELECT id FROM candidates)
      AND operational_archived_at IS NULL
      AND (
        (role = 'task' AND COALESCE(task_kind, 'action') != 'reference'
          AND status IN ('done', 'cancelled') AND repeat_after_days IS NULL
          AND NOT EXISTS (SELECT 1 FROM task_external_waits wait WHERE wait.task_id = work_items.id))
        OR (role = 'story' AND (status = 'done' OR archived_at IS NOT NULL))
      )
      AND NOT EXISTS (
        SELECT 1 FROM work_items child
        WHERE child.parent_id = work_items.id
          AND child.operational_archived_at IS NULL
      )
      AND NOT EXISTS (
        WITH RECURSIVE ancestors(id) AS (
          SELECT work_items.parent_id WHERE work_items.parent_id IS NOT NULL
          UNION ALL
          SELECT parent.parent_id
          FROM work_items parent JOIN ancestors a ON parent.id = a.id
          WHERE parent.parent_id IS NOT NULL
        )
        SELECT 1
        FROM ancestors a JOIN work_items ancestor ON ancestor.id = a.id
        WHERE ancestor.role = 'story' AND ancestor.status = 'active'
          AND ancestor.archived_at IS NULL
      )
    RETURNING id
  `);
  return updated.length;
}
