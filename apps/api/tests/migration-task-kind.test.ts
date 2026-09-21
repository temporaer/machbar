import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const drizzleDir = path.join(__dirname, "..", "drizzle");

function applyMigration(sqlite: ReturnType<typeof openDb>["sqlite"], file: string) {
  sqlite.exec(readFileSync(path.join(drizzleDir, file), "utf8"));
}

describe("task_kind migration", () => {
  it("backfills existing task rows to 'action' and leaves stories NULL", () => {
    const { sqlite, close } = openDb(":memory:");
    try {
      applyMigration(sqlite, "0000_baseline.sql");
      applyMigration(sqlite, "0001_work_items_merge.sql");
      applyMigration(sqlite, "0002_add_additional_next_action.sql");
      applyMigration(sqlite, "0003_add_task_reminders.sql");
      applyMigration(sqlite, "0004_add_work_item_scope.sql");
      applyMigration(sqlite, "0005_add_mcp_agents.sql");
      applyMigration(sqlite, "0006_add_task_not_before.sql");
      applyMigration(sqlite, "0007_external_task_links.sql");
      sqlite.exec(`
        INSERT INTO work_items (id, role, title, status) VALUES
          (1, 'story', 'Ein Projekt', 'active'),
          (2, 'task', 'Eine bestehende Aufgabe', 'active'),
          (3, 'task', 'Eine erledigte Aufgabe', 'done');
      `);

      applyMigration(sqlite, "0008_add_task_kind.sql");

      const columns = sqlite
        .prepare(`PRAGMA table_info(work_items)`)
        .all() as Array<{ name: string }>;
      expect(columns.map(({ name }) => name)).toEqual(
        expect.arrayContaining(["task_kind"]),
      );

      const rows = sqlite
        .prepare(`SELECT id, role, task_kind FROM work_items ORDER BY id`)
        .all() as Array<{ id: number; role: string; task_kind: string | null }>;
      expect(rows).toEqual([
        { id: 1, role: "story", task_kind: null },
        { id: 2, role: "task", task_kind: "action" },
        { id: 3, role: "task", task_kind: "action" },
      ]);
    } finally {
      close();
    }
  });
});
