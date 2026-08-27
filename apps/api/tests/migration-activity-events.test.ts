import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("0009 migration: activity events", () => {
  let sqlite: Database.Database | undefined;

  afterEach(() => {
    sqlite?.close();
    sqlite = undefined;
  });

  it("adds indexed deletion-safe activity storage without backfilling existing data", () => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    sqlite.exec(`
      CREATE TABLE members (
        id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        name text NOT NULL,
        color text NOT NULL
      );
      CREATE TABLE projects (
        id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        title text NOT NULL
      );
      CREATE TABLE tasks (
        id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        project_id integer REFERENCES projects(id) ON DELETE SET NULL,
        title text NOT NULL
      );
      INSERT INTO members (name, color) VALUES ('Alex', '#123456');
      INSERT INTO projects (title) VALUES ('Bestandsprojekt');
      INSERT INTO tasks (project_id, title) VALUES (1, 'Bestandsaufgabe');
    `);

    const migration = fs.readFileSync(
      path.resolve(__dirname, "../drizzle/0009_activity_events.sql"),
      "utf8",
    );
    sqlite.exec(migration);

    expect(
      sqlite.prepare("SELECT COUNT(*) FROM activity_events").pluck().get(),
    ).toBe(0);
    expect(sqlite.prepare("SELECT title FROM projects").pluck().get()).toBe(
      "Bestandsprojekt",
    );
    expect(sqlite.prepare("SELECT title FROM tasks").pluck().get()).toBe(
      "Bestandsaufgabe",
    );

    const columns = sqlite
      .prepare("PRAGMA table_info(activity_events)")
      .all() as Array<{ name: string; notnull: number }>;
    expect(columns.map((column) => column.name)).toEqual([
      "id",
      "created_at",
      "actor_member_id",
      "kind",
      "task_id",
      "project_id",
      "entity_type",
      "entity_title",
      "metadata",
    ]);
    expect(
      columns.find((column) => column.name === "actor_member_id")?.notnull,
    ).toBe(0);
    expect(columns.find((column) => column.name === "task_id")?.notnull).toBe(0);
    expect(columns.find((column) => column.name === "project_id")?.notnull).toBe(
      0,
    );

    const indexes = (
      sqlite.prepare("PRAGMA index_list(activity_events)").all() as Array<{
        name: string;
      }>
    ).map((index) => index.name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        "activity_events_created_at_idx",
        "activity_events_actor_idx",
        "activity_events_task_idx",
        "activity_events_project_idx",
      ]),
    );
    const indexColumns = (name: string) =>
      (
        sqlite!.prepare(`PRAGMA index_info(${name})`).all() as Array<{
          name: string;
        }>
      ).map((column) => column.name);
    expect(indexColumns("activity_events_created_at_idx")).toEqual([
      "created_at",
      "id",
    ]);
    expect(indexColumns("activity_events_actor_idx")).toEqual([
      "actor_member_id",
      "created_at",
      "id",
    ]);
    expect(indexColumns("activity_events_task_idx")).toEqual([
      "task_id",
      "created_at",
      "id",
    ]);
    expect(indexColumns("activity_events_project_idx")).toEqual([
      "project_id",
      "created_at",
      "id",
    ]);

    sqlite
      .prepare(
        `INSERT INTO activity_events (
           actor_member_id,
           kind,
           task_id,
           project_id,
           entity_type,
           entity_title,
           metadata
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        1,
        "task_updated",
        1,
        1,
        "task",
        "Bestandsaufgabe",
        JSON.stringify({ changedFields: ["scheduledDate"] }),
      );

    sqlite.exec(`
      DELETE FROM members WHERE id = 1;
      DELETE FROM tasks WHERE id = 1;
      DELETE FROM projects WHERE id = 1;
    `);

    expect(
      sqlite
        .prepare(
          `SELECT
             id,
             created_at AS createdAt,
             actor_member_id AS actorMemberId,
             task_id AS taskId,
             project_id AS projectId,
             entity_type AS entityType,
             entity_title AS entityTitle,
             metadata
           FROM activity_events`,
        )
        .get(),
    ).toMatchObject({
      id: 1,
      actorMemberId: null,
      taskId: null,
      projectId: null,
      entityType: "task",
      entityTitle: "Bestandsaufgabe",
      metadata: '{"changedFields":["scheduledDate"]}',
    });
    const createdAt = sqlite
      .prepare("SELECT created_at FROM activity_events WHERE id = 1")
      .pluck()
      .get();
    expect(createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(sqlite.pragma("foreign_key_check")).toEqual([]);
  });
});
