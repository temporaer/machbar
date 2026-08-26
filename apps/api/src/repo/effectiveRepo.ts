import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";

export type EffectiveSource = "task" | "parent" | "project" | "none";

export interface EffectiveOwner {
  ownerId: number | null;
  ownerSource: EffectiveSource;
}

/**
 * Computes effective owner inheritance for every task in the
 * database in a single pass, via a SQLite recursive CTE that walks the
 * `parentTaskId` chain top-down (root tasks resolve against their project,
 * every other task resolves against its own parent's already-computed
 * effective value). No parent-chain walking happens in application code.
 *
 * Source labelling mirrors the domain rule: a task's effective value is
 * attributed to `"parent"` only when some ancestor in the chain holds an
 * explicit override; if the value traces back to the project with no
 * explicit override anywhere in between, the source stays `"project"` even
 * for deeply nested descendants.
 */
export function getEffectiveOwners(
  db: Db,
): Map<number, EffectiveOwner> {
  const rows = db.all<{
    task_id: number;
    owner_id: number | null;
    owner_source: EffectiveSource;
  }>(sql`
    WITH RECURSIVE eff(task_id, owner_id, owner_source) AS (
      SELECT
        t.id,
        CASE
          WHEN t.owner_inheritance_mode = 'explicit' THEN t.owner_member_id
          WHEN t.owner_inheritance_mode = 'none' THEN NULL
          ELSE p.owner_member_id
        END,
        CASE
          WHEN t.owner_inheritance_mode = 'explicit' THEN 'task'
          WHEN t.owner_inheritance_mode = 'none' THEN 'none'
          WHEN p.owner_member_id IS NOT NULL THEN 'project'
          ELSE 'none'
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
          ELSE eff.owner_id
        END,
        CASE
          WHEN t.owner_inheritance_mode = 'explicit' THEN 'task'
          WHEN t.owner_inheritance_mode = 'none' THEN 'none'
          WHEN eff.owner_source = 'none' THEN 'none'
          WHEN eff.owner_source = 'project' THEN 'project'
          ELSE 'parent'
        END
      FROM tasks t
      JOIN eff ON t.parent_task_id = eff.task_id
    )
    SELECT task_id, owner_id, owner_source FROM eff
  `);

  const result = new Map<number, EffectiveOwner>();
  for (const row of rows) {
    result.set(row.task_id, {
      ownerId: row.owner_id,
      ownerSource: row.owner_source,
    });
  }
  return result;
}

/**
 * Computes the effective, deduplicated set of tag ids for every task via a
 * single recursive CTE. Each step folds the parent's (or project's, for
 * roots) already-effective tag set through the current task's exclusions
 * and then unions in the task's own explicit tags — expressed entirely as
 * JSON set operations in SQL (`json_group_array` / `json_each`) rather than
 * as an in-memory recursive fold.
 */
export function getEffectiveTagIds(db: Db): Map<number, number[]> {
  const rows = db.all<{ task_id: number; effective_json: string }>(sql`
    WITH RECURSIVE tag_state(task_id, effective_json) AS (
      SELECT
        t.id,
        (
          SELECT json_group_array(tag_id) FROM (
            SELECT pt.tag_id AS tag_id FROM project_tags pt
            WHERE pt.project_id = t.project_id
              AND pt.tag_id NOT IN (SELECT tag_id FROM task_excluded_tags WHERE task_id = t.id)
            UNION
            SELECT tt.tag_id FROM task_tags tt WHERE tt.task_id = t.id
          )
        )
      FROM tasks t
      WHERE t.parent_task_id IS NULL

      UNION ALL

      SELECT
        t.id,
        (
          SELECT json_group_array(tag_id) FROM (
            SELECT je.value AS tag_id FROM json_each(ts.effective_json) je
            WHERE je.value NOT IN (SELECT tag_id FROM task_excluded_tags WHERE task_id = t.id)
            UNION
            SELECT tt.tag_id FROM task_tags tt WHERE tt.task_id = t.id
          )
        )
      FROM tasks t
      JOIN tag_state ts ON t.parent_task_id = ts.task_id
    )
    SELECT task_id, effective_json FROM tag_state
  `);

  const result = new Map<number, number[]>();
  for (const row of rows) {
    const ids = JSON.parse(row.effective_json) as number[];
    result.set(row.task_id, ids);
  }
  return result;
}
