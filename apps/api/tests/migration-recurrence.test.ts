import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("0013 migration: task recurrence", () => {
  it("adds recurrence storage while preserving task, activity, and contribution data", () => {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = OFF");
    sqlite.exec(`
      CREATE TABLE tasks (
        id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        title text NOT NULL,
        recurrence_rule text
      );
      CREATE TABLE activity_events (
        id integer PRIMARY KEY AUTOINCREMENT NOT NULL
      );
      CREATE TABLE contribution_events (
        id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        activity_event_id integer NOT NULL,
        reason text NOT NULL
      );
      CREATE UNIQUE INDEX contribution_events_activity_unique
        ON contribution_events (activity_event_id);
      INSERT INTO tasks (title, recurrence_rule)
        VALUES ('Bestandsaufgabe', 'FREQ=DAILY');
      INSERT INTO activity_events DEFAULT VALUES;
      INSERT INTO contribution_events (activity_event_id, reason)
        VALUES (1, 'task_completed');
    `);

    const migration = fs.readFileSync(
      path.resolve(__dirname, "../drizzle/0013_task_recurrence.sql"),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) sqlite.exec(statement);
    }

    expect(sqlite.prepare("SELECT title FROM tasks").pluck().get()).toBe(
      "Bestandsaufgabe",
    );
    expect(
      sqlite.prepare("SELECT recurrence_rule FROM tasks").pluck().get(),
    ).toBe("FREQ=DAILY");
    expect(
      sqlite.prepare("SELECT COUNT(*) FROM activity_events").pluck().get(),
    ).toBe(1);
    expect(
      sqlite.prepare("SELECT COUNT(*) FROM contribution_events").pluck().get(),
    ).toBe(1);
    expect(
      (
        sqlite.prepare("PRAGMA table_info(tasks)").all() as Array<{
          name: string;
        }>
      ).map((column) => column.name),
    ).toEqual(
      expect.arrayContaining(["repeat_after_days", "allowed_deviation_days"]),
    );
    expect(
      (
        sqlite.prepare("PRAGMA index_list(contribution_events)").all() as Array<{
          name: string;
        }>
      ).map((index) => index.name),
    ).toContain("contribution_events_activity_reason_unique");
    sqlite.close();
  });
});
