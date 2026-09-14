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

describe("work_items.scope migration", () => {
  it("backfills every pre-existing row to the 'household' default", () => {
    const { sqlite, close } = openDb(":memory:");
    try {
      applyMigration(sqlite, "0000_baseline.sql");
      applyMigration(sqlite, "0001_work_items_merge.sql");
      applyMigration(sqlite, "0002_add_additional_next_action.sql");
      applyMigration(sqlite, "0003_add_task_reminders.sql");

      sqlite.exec(`
        INSERT INTO work_items (id, role, title) VALUES
          (1, 'task', 'Vor der Migration angelegt'),
          (2, 'story', 'Ebenfalls vorher angelegt');
      `);

      applyMigration(sqlite, "0004_add_work_item_scope.sql");

      const scopes = sqlite
        .prepare(`SELECT id, scope FROM work_items ORDER BY id`)
        .all() as Array<{ id: number; scope: string }>;
      expect(scopes).toEqual([
        { id: 1, scope: "household" },
        { id: 2, scope: "household" },
      ]);
    } finally {
      close();
    }
  });
});
