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
 * A copy of the 0000/0001 migrations (never rewritten in place) plus a
 * trimmed journal, used to recreate the exact on-disk schema of an
 * already-deployed database *before* the 0002 acceptance-criteria/size
 * migration existed.
 */
const preExistingMigrationsFolder = path.resolve(
  __dirname,
  "fixtures/pre-0002-migrations",
);

function tableInfo(sqlite: Database.Database, table: string) {
  return sqlite
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{ name: string }>;
}

function indexList(sqlite: Database.Database, table: string) {
  return sqlite
    .prepare(`PRAGMA index_list(${table})`)
    .all() as Array<{ name: string }>;
}

describe("0002 migration: acceptance criteria + task size", () => {
  let sqlite: Database.Database | undefined;

  afterEach(() => {
    sqlite?.close();
    sqlite = undefined;
  });

  it("preserves every non-empty description as the first acceptance criterion, and adds the new columns/tables safely", () => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    const preDb = drizzle(sqlite, { schema });

    // 1. Recreate the schema exactly as it existed for an already-deployed
    //    database (only migrations 0000 + 0001 applied).
    migrate(preDb, { migrationsFolder: preExistingMigrationsFolder });

    // Old schema still has a `description` column and no acceptance
    // criteria table / task size column yet.
    const oldProjectColumns = tableInfo(sqlite, "projects").map((c) => c.name);
    expect(oldProjectColumns).toContain("description");
    expect(oldProjectColumns).not.toContain("status_placeholder");

    const now = new Date().toISOString();
    const withDescription = sqlite
      .prepare(
        `INSERT INTO projects (title, description, status, position, created_at, updated_at)
         VALUES (?, ?, 'active', 0, ?, ?)`,
      )
      .run("Projekt mit Beschreibung", "Alte Freitextbeschreibung.", now, now);
    const withEmptyDescription = sqlite
      .prepare(
        `INSERT INTO projects (title, description, status, position, created_at, updated_at)
         VALUES (?, '', 'active', 1, ?, ?)`,
      )
      .run("Projekt ohne Beschreibung", now, now);
    const withWhitespaceDescription = sqlite
      .prepare(
        `INSERT INTO projects (title, description, status, position, created_at, updated_at)
         VALUES (?, '   ', 'active', 2, ?, ?)`,
      )
      .run("Projekt mit Leerzeichen-Beschreibung", now, now);

    // Pre-existing dependents of the project row (a tag link and a task)
    // must survive the projects-table rebuild untouched: this guards
    // against SQLite's `ON DELETE` FK actions firing during the rebuild's
    // `DROP TABLE projects` step, which would otherwise silently cascade
    // /null out already-deployed data (see runMigrations' foreign_keys
    // handling in src/db/migrate.ts).
    const tag = sqlite
      .prepare(`INSERT INTO tags (name) VALUES ('Zuhause')`)
      .run();
    sqlite
      .prepare(
        `INSERT INTO project_tags (project_id, tag_id) VALUES (?, ?)`,
      )
      .run(withDescription.lastInsertRowid, tag.lastInsertRowid);
    const task = sqlite
      .prepare(
        `INSERT INTO tasks (project_id, title, status, position, created_at, updated_at)
         VALUES (?, 'Bestehende Aufgabe', 'inbox', 0, ?, ?)`,
      )
      .run(withDescription.lastInsertRowid, now, now);

    // 2. Apply the real (full) migrations folder, which — for this
    //    already-migrated database — only runs the newer 0002 migration.
    runMigrations(preDb);

    const newProjectColumns = tableInfo(sqlite, "projects").map((c) => c.name);
    expect(newProjectColumns).not.toContain("description");
    expect(newProjectColumns).toContain("status");

    const criteriaTableColumns = tableInfo(
      sqlite,
      "project_acceptance_criteria",
    ).map((c) => c.name);
    expect(criteriaTableColumns).toEqual(
      expect.arrayContaining([
        "id",
        "project_id",
        "text",
        "checked",
        "position",
        "created_at",
        "updated_at",
      ]),
    );
    expect(indexList(sqlite, "project_acceptance_criteria").map((i) => i.name)).toContain(
      "project_acceptance_criteria_project_idx",
    );

    const criteriaByProject = sqlite
      .prepare(
        `SELECT project_id as projectId, text, checked, position FROM project_acceptance_criteria ORDER BY project_id, position`,
      )
      .all() as Array<{
      projectId: number;
      text: string;
      checked: number;
      position: number;
    }>;

    // Only the project with a real, non-empty description gets a preserved
    // criterion; empty / whitespace-only descriptions are dropped, not
    // inserted as blank criteria.
    expect(criteriaByProject).toHaveLength(1);
    expect(criteriaByProject[0]).toMatchObject({
      projectId: withDescription.lastInsertRowid,
      text: "Alte Freitextbeschreibung.",
      checked: 0,
      position: 0,
    });
    expect(
      criteriaByProject.find(
        (c) =>
          c.projectId === withEmptyDescription.lastInsertRowid ||
          c.projectId === withWhitespaceDescription.lastInsertRowid,
      ),
    ).toBeUndefined();

    // The pre-existing tag link and task survived the rebuild intact and
    // still point at the same project id.
    const survivingProjectTag = sqlite
      .prepare(`SELECT * FROM project_tags WHERE project_id = ?`)
      .get(withDescription.lastInsertRowid);
    expect(survivingProjectTag).toBeDefined();
    const survivingTask = sqlite
      .prepare(`SELECT project_id as projectId FROM tasks WHERE id = ?`)
      .get(task.lastInsertRowid) as { projectId: number } | undefined;
    expect(survivingTask?.projectId).toBe(withDescription.lastInsertRowid);

    // 3. Task `size` column exists, is nullable, and is indexed.
    const taskColumns = tableInfo(sqlite, "tasks");
    const sizeColumn = taskColumns.find((c) => c.name === "size");
    expect(sizeColumn).toBeDefined();
    expect(indexList(sqlite, "tasks").map((i) => i.name)).toContain(
      "tasks_size_idx",
    );

    // 4. FK cascade: deleting the project removes its acceptance criteria.
    sqlite
      .prepare(`DELETE FROM projects WHERE id = ?`)
      .run(withDescription.lastInsertRowid);
    const remaining = sqlite
      .prepare(`SELECT COUNT(*) as n FROM project_acceptance_criteria`)
      .get() as { n: number };
    expect(remaining.n).toBe(0);
  });

  it("defaults new projects.status to backlog at the database level", () => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    const db = drizzle(sqlite, { schema });
    runMigrations(db);

    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO projects (title, position, created_at, updated_at) VALUES (?, 0, ?, ?)`,
      )
      .run("Neues Projekt ohne Status", now, now);
    const row = sqlite
      .prepare(`SELECT status FROM projects WHERE title = ?`)
      .get("Neues Projekt ohne Status") as { status: string };
    expect(row.status).toBe("backlog");
  });
});
