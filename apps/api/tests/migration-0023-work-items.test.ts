import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate.js";
import * as schema from "../src/db/schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * A copy of migrations 0000-0022 (never rewritten in place) plus a trimmed
 * journal, used to recreate the exact on-disk schema of an already-deployed
 * database *before* the 0023 shared-identity migration existed. Tasks and
 * projects still use independent AUTOINCREMENT sequences at this point, so
 * a task and a project can share the same numeric id.
 */
const preExistingMigrationsFolder = path.resolve(
  __dirname,
  "fixtures/pre-0023-migrations",
);

function tableInfo(sqlite: Database.Database, table: string) {
  return sqlite
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{ name: string }>;
}

describe("0023 migration: shared work-item identity", () => {
  let sqlite: Database.Database | undefined;

  afterEach(() => {
    sqlite?.close();
    sqlite = undefined;
  });

  it("resolves a pre-existing task/project id collision, preserves every reference, and seeds work_items so no id is orphaned", () => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    const preDb = drizzle(sqlite, { schema });

    // 1. Recreate the schema exactly as it existed for an already-deployed
    //    database (only migrations 0000-0022 applied).
    migrate(preDb, { migrationsFolder: preExistingMigrationsFolder });

    const oldProjectColumns = tableInfo(sqlite, "projects").map((c) => c.name);
    expect(oldProjectColumns).not.toContain("work_item"); // sanity: pre-migration shape

    const now = new Date().toISOString();

    // A task and a project deliberately sharing id 5, reproducing a
    // real-world collision (independent AUTOINCREMENT sequences both
    // starting at 1 make this the common case, not an edge case).
    for (let i = 0; i < 4; i++) {
      sqlite
        .prepare(
          `INSERT INTO projects (title, status, position, created_at, updated_at) VALUES (?, 'active', ?, ?, ?)`,
        )
        .run(`Filler project ${i}`, i, now, now);
    }
    const collidingProject = sqlite
      .prepare(
        `INSERT INTO projects (title, status, position, created_at, updated_at) VALUES ('Kollisions-Projekt', 'active', 4, ?, ?)`,
      )
      .run(now, now);
    expect(collidingProject.lastInsertRowid).toBe(5);

    for (let i = 0; i < 4; i++) {
      sqlite
        .prepare(
          `INSERT INTO tasks (title, status, position, created_at, updated_at) VALUES (?, 'actionable', ?, ?, ?)`,
        )
        .run(`Filler task ${i}`, i, now, now);
    }
    const collidingTask = sqlite
      .prepare(
        `INSERT INTO tasks (project_id, title, status, position, created_at, updated_at) VALUES (?, 'Kollisions-Aufgabe', 'actionable', 4, ?, ?)`,
      )
      .run(collidingProject.lastInsertRowid, now, now);
    expect(collidingTask.lastInsertRowid).toBe(5);

    // Every kind of reference into the colliding project id must survive
    // renumbering unchanged in meaning (still pointing at the same
    // logical project, whatever its new id becomes).
    const tag = sqlite
      .prepare(`INSERT INTO tags (name) VALUES ('Kollisionstest-Tag')`)
      .run();
    const member = sqlite
      .prepare(`INSERT INTO members (name, color) VALUES ('Anna', '#000000')`)
      .run();
    sqlite
      .prepare(`INSERT INTO project_tags (project_id, tag_id) VALUES (?, ?)`)
      .run(collidingProject.lastInsertRowid, tag.lastInsertRowid);
    sqlite
      .prepare(
        `INSERT INTO project_acceptance_criteria (project_id, text, position, created_at, updated_at) VALUES (?, 'Fertig, wenn ...', 0, ?, ?)`,
      )
      .run(collidingProject.lastInsertRowid, now, now);
    const activityEvent = sqlite
      .prepare(
        `INSERT INTO activity_events (kind, project_id, entity_type, entity_title, metadata, created_at) VALUES ('project_created', ?, 'project', 'Kollisions-Projekt', '{}', ?)`,
      )
      .run(collidingProject.lastInsertRowid, now);
    sqlite
      .prepare(
        `INSERT INTO notification_events (kind, recipient_member_id, entity_type, entity_id, entity_title, source_key, created_at)
         VALUES ('project_assigned', ?, 'project', ?, 'Kollisions-Projekt', 'test-source-key', ?)`,
      )
      .run(member.lastInsertRowid, collidingProject.lastInsertRowid, now);
    sqlite
      .prepare(
        `INSERT INTO contribution_events (activity_event_id, category, reason, entity_type, entity_id, policy_points, shared_points, personal_points, created_at)
         VALUES (?, 'planning', 'project_outcome_added', 'project', ?, 1, 1, 0, ?)`,
      )
      .run(
        activityEvent.lastInsertRowid,
        collidingProject.lastInsertRowid,
        now,
      );

    // 2. Apply the real (full) migrations folder, which — for this
    //    already-migrated database — only runs the newer 0023 migration.
    runMigrations(preDb);

    const projectIds = sqlite
      .prepare(`SELECT id FROM projects ORDER BY id`)
      .all() as Array<{ id: number }>;
    const taskIds = sqlite
      .prepare(`SELECT id FROM tasks ORDER BY id`)
      .all() as Array<{ id: number }>;
    const workItemIds = new Set(
      (sqlite.prepare(`SELECT id FROM work_items`).all() as Array<{ id: number }>).map(
        (r) => r.id,
      ),
    );

    // No collisions remain, and every task/project id has a matching
    // work_items row (nothing orphaned).
    const projectIdSet = new Set(projectIds.map((r) => r.id));
    const taskIdSet = new Set(taskIds.map((r) => r.id));
    for (const id of projectIdSet) expect(taskIdSet.has(id)).toBe(false);
    for (const id of projectIds.map((r) => r.id)) expect(workItemIds.has(id)).toBe(true);
    for (const id of taskIds.map((r) => r.id)) expect(workItemIds.has(id)).toBe(true);
    expect(workItemIds.size).toBe(projectIds.length + taskIds.length);

    // The renumbered project row itself, and every table that referenced
    // it, still agree on the same (new) id.
    const renumberedProject = sqlite
      .prepare(`SELECT id FROM projects WHERE title = 'Kollisions-Projekt'`)
      .get() as { id: number };
    expect(renumberedProject.id).not.toBe(5);
    expect(renumberedProject.id).toBeGreaterThan(1_000_000_000);

    expect(
      sqlite
        .prepare(`SELECT project_id FROM project_tags WHERE tag_id = ?`)
        .get(tag.lastInsertRowid),
    ).toEqual({ project_id: renumberedProject.id });
    expect(
      sqlite
        .prepare(
          `SELECT project_id FROM project_acceptance_criteria WHERE text = 'Fertig, wenn ...'`,
        )
        .get(),
    ).toEqual({ project_id: renumberedProject.id });
    expect(
      sqlite
        .prepare(
          `SELECT project_id FROM activity_events WHERE entity_title = 'Kollisions-Projekt'`,
        )
        .get(),
    ).toEqual({ project_id: renumberedProject.id });
    expect(
      sqlite
        .prepare(
          `SELECT entity_id FROM notification_events WHERE source_key = 'test-source-key'`,
        )
        .get(),
    ).toEqual({ entity_id: renumberedProject.id });
    expect(
      sqlite
        .prepare(
          `SELECT entity_id FROM contribution_events WHERE reason = 'project_outcome_added'`,
        )
        .get(),
    ).toEqual({ entity_id: renumberedProject.id });

    // The task that used to belong to the colliding project (by its old
    // id) still points at the same, now-renumbered project.
    const survivingTask = sqlite
      .prepare(`SELECT project_id FROM tasks WHERE title = 'Kollisions-Aufgabe'`)
      .get() as { project_id: number };
    expect(survivingTask.project_id).toBe(renumberedProject.id);

    // Newly-allocated work-item ids continue past every seeded id (the
    // AUTOINCREMENT sequence was correctly advanced by the explicit-id
    // seeding inserts, not left at its pre-migration high-water mark).
    const nextId = sqlite
      .prepare(`INSERT INTO work_items DEFAULT VALUES`)
      .run().lastInsertRowid as number;
    const maxSeeded = Math.max(...Array.from(workItemIds));
    expect(nextId).toBeGreaterThan(maxSeeded);
  });
});
