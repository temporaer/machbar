import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("external-wait migrations", () => {
  it("migrates waiting tasks, then removes superseded storage and status metadata", () => {
    const oldStatusMetadata = {
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
        (6, 'Stale waiting-for', 'actionable', '2026-09-04', 'Stale'),
        (7, 'Dependency prerequisite', 'actionable', NULL, NULL);
      INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (1, 7);
      INSERT INTO activity_events (task_id, metadata)
        VALUES (5, '${JSON.stringify(oldStatusMetadata)}');
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
    ).toEqual(oldStatusMetadata);
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

    const cleanupMigration = fs.readFileSync(
      path.resolve(
        __dirname,
        "../drizzle/0016_remove_waiting_compatibility.sql",
      ),
      "utf8",
    );
    sqlite.pragma("foreign_keys = OFF");
    for (const statement of cleanupMigration.split("--> statement-breakpoint")) {
      if (statement.trim()) sqlite.exec(statement);
    }
    sqlite.pragma("foreign_keys = ON");

    expect(
      sqlite
        .prepare("PRAGMA table_info(tasks)")
        .all()
        .map((column) => (column as { name: string }).name),
    ).not.toContain("waiting_for");
    expect(
      JSON.parse(
        sqlite
          .prepare("SELECT metadata FROM activity_events")
          .pluck()
          .get() as string,
      ),
    ).toEqual({
      previousStatus: "actionable",
      nextStatus: "actionable",
    });
    expect(
      sqlite.prepare("SELECT COUNT(*) FROM task_dependencies").pluck().get(),
    ).toBe(1);
    expect(
      sqlite.prepare("SELECT COUNT(*) FROM contribution_events").pluck().get(),
    ).toBe(1);
    expect(sqlite.pragma("foreign_key_check")).toEqual([]);
    sqlite.close();
  });
});
