import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("0008 migration: captured task status", () => {
  it("maps legacy clarification flags without rebuilding the tasks table", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE tasks (
        id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        title text NOT NULL,
        status text DEFAULT 'actionable' NOT NULL,
        needs_clarification integer DEFAULT false NOT NULL,
        completed_at text,
        cancelled_at text
      );
      CREATE INDEX tasks_status_idx ON tasks (status);
      INSERT INTO tasks (
        title,
        status,
        needs_clarification,
        completed_at,
        cancelled_at
      )
      VALUES
        ('Capture', 'actionable', true, NULL, NULL),
        ('Ready', 'actionable', false, NULL, NULL),
        ('Waiting', 'waiting', false, NULL, NULL),
        ('Completed capture', 'done', true, '2026-01-01T10:00:00Z', NULL),
        ('Cancelled capture', 'cancelled', true, NULL, '2026-01-02T10:00:00Z');
    `);

    const migration = fs.readFileSync(
      path.resolve(__dirname, "../drizzle/0008_captured_task_status.sql"),
      "utf8",
    );
    sqlite.exec(migration);

    expect(
      sqlite
        .prepare(
          `SELECT
             title,
             status,
             needs_clarification AS needsClarification,
             completed_at AS completedAt,
             cancelled_at AS cancelledAt
           FROM tasks ORDER BY id`,
        )
        .all(),
    ).toEqual([
      {
        title: "Capture",
        status: "captured",
        needsClarification: 1,
        completedAt: null,
        cancelledAt: null,
      },
      {
        title: "Ready",
        status: "actionable",
        needsClarification: 0,
        completedAt: null,
        cancelledAt: null,
      },
      {
        title: "Waiting",
        status: "waiting",
        needsClarification: 0,
        completedAt: null,
        cancelledAt: null,
      },
      {
        title: "Completed capture",
        status: "captured",
        needsClarification: 1,
        completedAt: null,
        cancelledAt: null,
      },
      {
        title: "Cancelled capture",
        status: "captured",
        needsClarification: 1,
        completedAt: null,
        cancelledAt: null,
      },
    ]);
    expect(
      sqlite
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'index' AND name = 'tasks_status_idx'`,
        )
        .get(),
    ).toEqual({ name: "tasks_status_idx" });
    sqlite.close();
  });
});
