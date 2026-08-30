import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ActivityEventMetadata } from "@machbar/shared";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("0015 migration: external waits", () => {
  it("migrates only waiting tasks without disturbing related history or scheduling", () => {
    const historicalMetadata: ActivityEventMetadata = {
      previousStatus: "actionable",
      nextStatus: "waiting",
    };
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    sqlite.exec(`
      CREATE TABLE tasks (
        id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        title text NOT NULL,
        status text DEFAULT 'actionable' NOT NULL,
        scheduled_date text,
        waiting_for text
      );
      CREATE TABLE task_dependencies (
        id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        task_id integer NOT NULL,
        depends_on_task_id integer NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE cascade,
        FOREIGN KEY (depends_on_task_id) REFERENCES tasks(id) ON DELETE cascade
      );
      CREATE TABLE activity_events (
        id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        task_id integer,
        metadata text NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE set null
      );
      CREATE TABLE contribution_events (
        id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        activity_event_id integer NOT NULL,
        reason text NOT NULL,
        FOREIGN KEY (activity_event_id) REFERENCES activity_events(id) ON DELETE cascade
      );

      INSERT INTO tasks (id, title, status, scheduled_date, waiting_for) VALUES
        (1, 'Ordinary actionable', 'actionable', '2026-09-10', NULL),
        (2, 'Waiting, no details', 'waiting', NULL, NULL),
        (3, 'Waiting for reply', 'waiting', NULL, 'Reply'),
        (4, 'Waiting until date', 'waiting', '2026-09-02', NULL),
        (5, 'Waiting for delivery until date', 'waiting', '2026-09-03', 'Delivery'),
        (6, 'Stale legacy waiting-for', 'actionable', '2026-09-04', 'Stale'),
        (7, 'Dependency prerequisite', 'actionable', NULL, NULL);
      INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (1, 7);
      INSERT INTO activity_events (task_id, metadata)
        VALUES (5, '${JSON.stringify(historicalMetadata)}');
      INSERT INTO contribution_events (activity_event_id, reason)
        VALUES (1, 'waiting_followup_added');
    `);

    const migration = fs.readFileSync(
      path.resolve(__dirname, "../drizzle/0015_external_waits.sql"),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) sqlite.exec(statement);
    }

    expect(
      sqlite
        .prepare(
          `SELECT task_id AS taskId, waiting_for AS waitingFor
           FROM task_external_waits ORDER BY task_id`,
        )
        .all(),
    ).toEqual([
      { taskId: 2, waitingFor: null },
      { taskId: 3, waitingFor: "Reply" },
      { taskId: 4, waitingFor: null },
      { taskId: 5, waitingFor: "Delivery" },
    ]);
    expect(
      sqlite
        .prepare(
          `SELECT id, status, scheduled_date AS scheduledDate, waiting_for AS waitingFor
           FROM tasks ORDER BY id`,
        )
        .all(),
    ).toEqual([
      {
        id: 1,
        status: "actionable",
        scheduledDate: "2026-09-10",
        waitingFor: null,
      },
      { id: 2, status: "actionable", scheduledDate: null, waitingFor: null },
      { id: 3, status: "actionable", scheduledDate: null, waitingFor: "Reply" },
      {
        id: 4,
        status: "actionable",
        scheduledDate: "2026-09-02",
        waitingFor: null,
      },
      {
        id: 5,
        status: "actionable",
        scheduledDate: "2026-09-03",
        waitingFor: "Delivery",
      },
      {
        id: 6,
        status: "actionable",
        scheduledDate: "2026-09-04",
        waitingFor: "Stale",
      },
      { id: 7, status: "actionable", scheduledDate: null, waitingFor: null },
    ]);
    expect(
      sqlite.prepare("SELECT COUNT(*) FROM task_dependencies").pluck().get(),
    ).toBe(1);
    expect(
      JSON.parse(
        sqlite
          .prepare("SELECT metadata FROM activity_events")
          .pluck()
          .get() as string,
      ),
    ).toEqual(historicalMetadata);
    expect(
      sqlite.prepare("SELECT COUNT(*) FROM contribution_events").pluck().get(),
    ).toBe(1);

    sqlite.prepare("DELETE FROM tasks WHERE id = 5").run();
    expect(
      sqlite
        .prepare("SELECT COUNT(*) FROM task_external_waits WHERE task_id = 5")
        .pluck()
        .get(),
    ).toBe(0);
    sqlite.close();
  });
});
