import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";

/**
 * Hierarchy queries (descendants / ancestors / cycle checks) expressed as
 * SQLite recursive CTEs and executed through Drizzle's raw `sql` tag. These
 * intentionally do NOT walk `parentTaskId` pointers node-by-node in
 * application code — the tree traversal itself is pushed down into SQL, and
 * this repository is the only place that owns that SQL.
 */

/** Every descendant work item (any depth) of `rootId`, excluding the root itself. */
export function getDescendantIds(db: Db, rootId: number): number[] {
  const rows = db.all<{ id: number }>(sql`
    WITH RECURSIVE descendants(id) AS (
      SELECT id FROM work_items WHERE parent_id = ${rootId}
      UNION ALL
      SELECT child.id
      FROM work_items child
      JOIN descendants d ON child.parent_id = d.id
    )
    SELECT id FROM descendants
  `);
  return rows.map((r) => r.id);
}

/**
 * Every ancestor of `itemId`, nearest first (immediate parent, grandparent,
 * ...), excluding the item itself.
 */
export function getAncestorIds(db: Db, itemId: number): number[] {
  const rows = db.all<{ id: number }>(sql`
    WITH RECURSIVE ancestors(id) AS (
      SELECT parent_id AS id FROM work_items
      WHERE id = ${itemId} AND parent_id IS NOT NULL
      UNION ALL
      SELECT item.parent_id
      FROM work_items item
      JOIN ancestors a ON item.id = a.id
      WHERE item.parent_id IS NOT NULL
    )
    SELECT id FROM ancestors
  `);
  return rows.map((r) => r.id);
}

/**
 * Would re-parenting `itemId` under `candidateParentId` create a hierarchy
 * cycle? True if the candidate parent is the task itself or one of its
 * existing descendants.
 */
export function wouldCreateHierarchyCycle(
  db: Db,
  itemId: number,
  candidateParentId: number,
): boolean {
  if (itemId === candidateParentId) return true;
  const row = db.get<{ is_cycle: number }>(sql`
    SELECT EXISTS (
      WITH RECURSIVE descendants(id) AS (
        SELECT id FROM work_items WHERE parent_id = ${itemId}
        UNION ALL
        SELECT child.id
        FROM work_items child
        JOIN descendants d ON child.parent_id = d.id
      )
      SELECT 1 FROM descendants WHERE id = ${candidateParentId}
    ) AS is_cycle
  `);
  return row?.is_cycle === 1;
}

/** Nearest ancestor story for each task, preserving the legacy `Task.projectId` projection. */
export function getTaskProjectIds(db: Db): Map<number, number | null> {
  const rows = db.all<{ task_id: number; project_id: number | null }>(sql`
    WITH RECURSIVE ancestors(task_id, ancestor_id, depth) AS (
      SELECT child.id, child.parent_id, 1
      FROM work_items child
      WHERE child.role = 'task'
      UNION ALL
      SELECT ancestors.task_id, parent.parent_id, ancestors.depth + 1
      FROM ancestors
      JOIN work_items parent ON parent.id = ancestors.ancestor_id
      WHERE ancestors.ancestor_id IS NOT NULL
    ),
    nearest_story AS (
      SELECT
        ancestors.task_id,
        ancestors.ancestor_id AS project_id,
        row_number() OVER (
          PARTITION BY ancestors.task_id
          ORDER BY ancestors.depth
        ) AS rn
      FROM ancestors
      JOIN work_items story ON story.id = ancestors.ancestor_id
      WHERE story.role = 'story'
    )
    SELECT task.id AS task_id, nearest_story.project_id
    FROM work_items task
    LEFT JOIN nearest_story
      ON nearest_story.task_id = task.id AND nearest_story.rn = 1
    WHERE task.role = 'task'
  `);
  return new Map(rows.map((row) => [row.task_id, row.project_id]));
}

/** All descendant task ids below a story, flattened regardless of depth. */
export function getTaskIdsForStory(db: Db, storyId: number): number[] {
  const rows = db.all<{ id: number }>(sql`
    WITH RECURSIVE descendants(id, role) AS (
      SELECT id, role FROM work_items WHERE parent_id = ${storyId}
      UNION ALL
      SELECT child.id, child.role
      FROM work_items child
      JOIN descendants d ON child.parent_id = d.id
    )
    SELECT id FROM descendants WHERE role = 'task'
  `);
  return rows.map((row) => row.id);
}
