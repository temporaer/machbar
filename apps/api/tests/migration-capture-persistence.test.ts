import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("0005 migration: capture persistence", () => {
  it("converts inbox rows and adds a clarified capture default without rebuilding tasks", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE members (id integer PRIMARY KEY);
      CREATE TABLE projects (id integer PRIMARY KEY);
      CREATE TABLE tasks (
        id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        project_id integer,
        parent_task_id integer,
        title text NOT NULL,
        notes text DEFAULT '' NOT NULL,
        status text DEFAULT 'inbox' NOT NULL,
        owner_member_id integer,
        owner_inheritance_mode text DEFAULT 'inherit' NOT NULL,
        created_by_member_id integer,
        due_date text,
        scheduled_date text,
        waiting_for text,
        context text,
        context_inheritance_mode text DEFAULT 'inherit' NOT NULL,
        priority integer,
        size text,
        position integer DEFAULT 0 NOT NULL,
        completed_at text,
        cancelled_at text,
        recurrence_rule text,
        reminder_at text,
        created_at text DEFAULT '' NOT NULL,
        updated_at text DEFAULT '' NOT NULL
      );
      CREATE INDEX tasks_project_idx ON tasks (project_id);
      CREATE INDEX tasks_parent_idx ON tasks (parent_task_id);
      CREATE INDEX tasks_status_idx ON tasks (status);
      CREATE INDEX tasks_size_idx ON tasks (size);
      INSERT INTO tasks (title, status) VALUES ('Capture', 'inbox');
      INSERT INTO tasks (title, status) VALUES ('Ready', 'actionable');
    `);

    const migration = fs.readFileSync(
      path.resolve(__dirname, "../drizzle/0005_capture_persistence.sql"),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) sqlite.exec(statement);
    }

    const rows = sqlite
      .prepare(
        `SELECT title, status, needs_clarification AS needsClarification
         FROM tasks ORDER BY id`,
      )
      .all();
    expect(rows).toEqual([
      {
        title: "Capture",
        status: "actionable",
        needsClarification: 1,
      },
      {
        title: "Ready",
        status: "actionable",
        needsClarification: 0,
      },
    ]);

    const clarificationColumn = sqlite
      .prepare(`PRAGMA table_info(tasks)`)
      .all()
      .find((column) => (column as { name: string }).name === "needs_clarification") as
      | { dflt_value: string; notnull: number }
      | undefined;
    expect(clarificationColumn).toMatchObject({
      dflt_value: "false",
      notnull: 1,
    });

    sqlite
      .prepare(`INSERT INTO tasks (title, status) VALUES ('Application default', 'actionable')`)
      .run();
    expect(
      sqlite
        .prepare(
          `SELECT status, needs_clarification AS needsClarification
           FROM tasks WHERE title = 'Application default'`,
        )
        .get(),
    ).toEqual({ status: "actionable", needsClarification: 0 });
    sqlite.close();
  });
});
