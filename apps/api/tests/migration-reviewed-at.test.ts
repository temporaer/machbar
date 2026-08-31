import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("reviewed-at migration", () => {
  it("adds nullable review timestamps without rewriting existing update timestamps", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE projects (
        id integer PRIMARY KEY,
        updated_at text NOT NULL
      );
      CREATE TABLE tasks (
        id integer PRIMARY KEY,
        updated_at text NOT NULL
      );
      INSERT INTO projects VALUES (1, '2026-07-01T10:00:00.000Z');
      INSERT INTO tasks VALUES (1, '2026-07-02T10:00:00.000Z');
    `);
    const migration = fs.readFileSync(
      path.resolve(__dirname, "../drizzle/0018_reviewed_at.sql"),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) sqlite.exec(statement);
    }

    expect(
      sqlite.prepare("SELECT updated_at, reviewed_at FROM projects").get(),
    ).toEqual({
      updated_at: "2026-07-01T10:00:00.000Z",
      reviewed_at: null,
    });
    expect(
      sqlite.prepare("SELECT updated_at, reviewed_at FROM tasks").get(),
    ).toEqual({
      updated_at: "2026-07-02T10:00:00.000Z",
      reviewed_at: null,
    });
    sqlite.close();
  });
});
