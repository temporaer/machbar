import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate.js";
import * as schema from "../src/db/schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const preExistingMigrationsFolder = path.resolve(
  __dirname,
  "fixtures/pre-0002-migrations",
);

describe("0007 migration: typed tags and context removal", () => {
  let sqlite: Database.Database | undefined;

  afterEach(() => {
    sqlite?.close();
    sqlite = undefined;
  });

  it("preserves associations and backfills known production tag kinds", () => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: preExistingMigrationsFolder });

    const now = new Date().toISOString();
    const projectId = sqlite
      .prepare(
        `INSERT INTO projects
          (title, description, status, context, position, created_at, updated_at)
         VALUES ('Bestand', '', 'active', 'Alt', 0, ?, ?)`,
      )
      .run(now, now).lastInsertRowid;
    const taskId = sqlite
      .prepare(
        `INSERT INTO tasks
          (project_id, title, status, context, context_inheritance_mode, position, created_at, updated_at)
         VALUES (?, 'Bestandsaufgabe', 'actionable', 'Alt', 'explicit', 0, ?, ?)`,
      )
      .run(projectId, now, now).lastInsertRowid;
    const blockerId = sqlite
      .prepare(
        `INSERT INTO tasks
          (project_id, title, status, position, created_at, updated_at)
         VALUES (?, 'Blocker', 'actionable', 1, ?, ?)`,
      )
      .run(projectId, now, now).lastInsertRowid;

    const insertTag = sqlite.prepare(`INSERT INTO tags (name) VALUES (?)`);
    const hausId = insertTag.run("Haus").lastInsertRowid;
    const schuleId = insertTag.run("Schule").lastInsertRowid;
    const unknownId = insertTag.run("Bestand unbekannt").lastInsertRowid;
    sqlite
      .prepare(`INSERT INTO project_tags (project_id, tag_id) VALUES (?, ?)`)
      .run(projectId, hausId);
    sqlite
      .prepare(`INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)`)
      .run(taskId, schuleId);
    sqlite
      .prepare(`INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)`)
      .run(taskId, unknownId);
    sqlite
      .prepare(
        `INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)`,
      )
      .run(taskId, blockerId);

    runMigrations(db);

    const tagRows = sqlite
      .prepare(
        `SELECT name, kind, grouping_mode AS groupingMode,
                sort_position AS sortPosition
         FROM tags ORDER BY name`,
      )
      .all() as Array<{
      name: string;
      kind: string;
      groupingMode: string;
      sortPosition: number | null;
    }>;
    expect(tagRows).toEqual(
      expect.arrayContaining([
        {
          name: "Haus",
          kind: "area",
          groupingMode: "auto",
          sortPosition: null,
        },
        {
          name: "Schule",
          kind: "actor",
          groupingMode: "auto",
          sortPosition: null,
        },
        {
          name: "Bestand unbekannt",
          kind: "plain",
          groupingMode: "auto",
          sortPosition: null,
        },
      ]),
    );

    const columns = (table: string) =>
      (
        sqlite!.prepare(`PRAGMA table_info(${table})`).all() as Array<{
          name: string;
        }>
      ).map((column) => column.name);
    expect(columns("projects")).not.toContain("context");
    expect(columns("tasks")).not.toContain("context");
    expect(columns("tasks")).not.toContain("context_inheritance_mode");
    expect(
      sqlite
        .prepare(`SELECT COUNT(*) FROM project_tags WHERE project_id = ?`)
        .pluck()
        .get(projectId),
    ).toBe(1);
    expect(
      sqlite
        .prepare(`SELECT COUNT(*) FROM task_tags WHERE task_id = ?`)
        .pluck()
        .get(taskId),
    ).toBe(2);
    expect(
      sqlite
        .prepare(
          `SELECT COUNT(*) FROM task_dependencies
           WHERE task_id = ? AND depends_on_task_id = ?`,
        )
        .pluck()
        .get(taskId, blockerId),
    ).toBe(1);
    expect(sqlite.pragma("foreign_key_check")).toEqual([]);
  });
});
