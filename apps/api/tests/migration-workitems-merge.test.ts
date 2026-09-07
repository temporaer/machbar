import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const drizzleDir = path.join(__dirname, "..", "drizzle");

function loadMigratedDb() {
  const { sqlite, close } = openDb(":memory:");
  sqlite.exec(readFileSync(path.join(drizzleDir, "0000_baseline.sql"), "utf8"));

  sqlite.exec(`
    INSERT INTO members (id, name, color) VALUES
      (1, 'Ada', '#2563eb'),
      (2, 'Linus', '#16a34a');

    INSERT INTO work_items (id) VALUES (10), (11), (20), (21), (30);

    INSERT INTO tags (id, name, color, kind) VALUES
      (100, 'Urgent', '#dc2626', 'plain'),
      (101, 'Home', '#7c3aed', 'area');

    INSERT INTO physical_contexts (id, source, external_id, name) VALUES
      (100, 'home_assistant', 'hallway', 'Hallway');

    INSERT INTO projects (id, revision, title, notes, status, owner_member_id, due_date, scheduled_date, position)
    VALUES
      (10, 1, 'Renovate hallway', 'Prepare walls', 'archived', 1, '2026-09-15', '2026-09-10', 0),
      (11, 1, 'Buy groceries', 'Weekly plan', 'completed', 2, '2026-09-20', null, 1);

    INSERT INTO tasks (id, revision, project_id, parent_task_id, title, notes, status, needs_clarification, owner_member_id, due_date, scheduled_date, position)
    VALUES
      (20, 1, 10, null, 'Measure walls', 'Take tape measure', 'actionable', 0, 1, '2026-09-11', '2026-09-09', 0),
      (21, 1, 10, 20, 'Choose paint', 'Pick two colors', 'someday', 1, 1, null, null, 1),
      (30, 1, 11, null, 'Make list', 'Write list', 'cancelled', 0, 2, '2026-09-16', null, 0);

    INSERT INTO project_tags (project_id, tag_id) VALUES (10, 100), (11, 101);
    INSERT INTO task_tags (task_id, tag_id) VALUES (20, 100), (21, 101);
    INSERT INTO project_physical_contexts (project_id, context_id) VALUES (10, 100);
    INSERT INTO task_physical_contexts (task_id, context_id) VALUES (20, 100);
    INSERT INTO project_acceptance_criteria (id, project_id, text, checked, position)
    VALUES (100, 10, 'Walls are measured', 0, 0), (101, 11, 'Groceries are bought', 1, 1);
    INSERT INTO task_dependencies (id, task_id, depends_on_task_id) VALUES (1, 21, 20);
    INSERT INTO task_external_waits (task_id, waiting_for, revisit_date) VALUES (30, 'Delivery', '2026-09-18');
    INSERT INTO activity_events (id, actor_member_id, kind, task_id, project_id, entity_type, entity_title, metadata)
    VALUES
      (1, 1, 'task_created', 20, null, 'task', 'Measure walls', '{"source":"fixture"}'),
      (2, 2, 'project_completed', null, 11, 'project', 'Buy groceries', '{"source":"fixture"}');
  `);

  sqlite.exec(readFileSync(path.join(drizzleDir, "0001_work_items_merge.sql"), "utf8"));

  return { sqlite, close };
}

describe("work_items migration", () => {
  it("creates a unified work item table and preserves legacy row identity", () => {
    const { sqlite, close } = loadMigratedDb();

    try {
      const rows = sqlite
        .prepare(
          `SELECT id, role, parent_id, status, archived_at, title FROM work_items ORDER BY id`,
        )
        .all() as Array<{ id: number; role: string; parent_id: number | null; status: string; archived_at: string | null; title: string }>;

      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 10, role: "story", parent_id: null, status: "backlog", archived_at: expect.any(String) }),
          expect.objectContaining({ id: 11, role: "story", parent_id: null, status: "done" }),
          expect.objectContaining({ id: 20, role: "task", parent_id: 10, status: "active" }),
          expect.objectContaining({ id: 21, role: "task", parent_id: 20, status: "backlog" }),
          expect.objectContaining({ id: 30, role: "task", parent_id: 11, status: "cancelled" }),
        ]),
      );
    } finally {
      close();
    }
  });

  it("re-points satellite rows and keeps activity/event references valid", () => {
    const { sqlite, close } = loadMigratedDb();

    try {
      const tagRows = sqlite
        .prepare(`SELECT work_item_id, tag_id FROM work_item_tags ORDER BY work_item_id, tag_id`)
        .all() as Array<{ work_item_id: number; tag_id: number }>;
      expect(tagRows).toEqual(
        expect.arrayContaining([
          { work_item_id: 10, tag_id: 100 },
          { work_item_id: 11, tag_id: 101 },
          { work_item_id: 20, tag_id: 100 },
          { work_item_id: 21, tag_id: 101 },
        ]),
      );

      const criteriaRows = sqlite
        .prepare(`SELECT work_item_id, text, checked FROM work_item_acceptance_criteria ORDER BY id`)
        .all() as Array<{ work_item_id: number; text: string; checked: number }>;
      expect(criteriaRows).toEqual([
        { work_item_id: 10, text: "Walls are measured", checked: 0 },
        { work_item_id: 11, text: "Groceries are bought", checked: 1 },
      ]);

      const dependencyRows = sqlite
        .prepare(`SELECT task_id, depends_on_task_id FROM task_dependencies ORDER BY id`)
        .all() as Array<{ task_id: number; depends_on_task_id: number }>;
      expect(dependencyRows).toEqual([{ task_id: 21, depends_on_task_id: 20 }]);

      const activityRows = sqlite
        .prepare(
          `SELECT entity_id, entity_type, entity_title FROM activity_events ORDER BY id`,
        )
        .all() as Array<{ entity_id: number; entity_type: string; entity_title: string }>;
      expect(activityRows).toEqual([
        { entity_id: 20, entity_type: "task", entity_title: "Measure walls" },
        { entity_id: 11, entity_type: "project", entity_title: "Buy groceries" },
      ]);
    } finally {
      close();
    }
  });

  it("keeps task-only metadata on the shared row and preserves archived story metadata", () => {
    const { sqlite, close } = loadMigratedDb();

    try {
      const taskRow = sqlite
        .prepare(
          `SELECT status, size, reminder_at, needs_clarification, due_date FROM work_items WHERE id = 20`,
        )
        .get() as { status: string; size: string | null; reminder_at: string | null; needs_clarification: number; due_date: string | null };
      expect(taskRow).toMatchObject({
        status: "active",
        size: null,
        reminder_at: null,
        needs_clarification: 0,
        due_date: "2026-09-11",
      });

      const storyRow = sqlite
        .prepare(
          `SELECT archived_at, status, completed_at FROM work_items WHERE id = 10`,
        )
        .get() as { archived_at: string | null; status: string; completed_at: string | null };
      expect(storyRow).toMatchObject({
        archived_at: expect.any(String),
        status: "backlog",
        completed_at: null,
      });
    } finally {
      close();
    }
  });
});
