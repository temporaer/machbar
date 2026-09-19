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

describe("non-backlog project revisit cleanup migration", () => {
  it("clears scheduled_date only for non-backlog stories", () => {
    const { sqlite, close } = openDb(":memory:");
    try {
      applyMigration(sqlite, "0000_baseline.sql");
      applyMigration(sqlite, "0001_work_items_merge.sql");
      applyMigration(sqlite, "0002_add_additional_next_action.sql");
      applyMigration(sqlite, "0003_add_task_reminders.sql");
      applyMigration(sqlite, "0004_add_work_item_scope.sql");
      applyMigration(sqlite, "0005_add_mcp_agents.sql");
      applyMigration(sqlite, "0006_add_task_not_before.sql");

      sqlite.exec(`
        INSERT INTO work_items (id, role, title, status, scheduled_date, archived_at) VALUES
          (1, 'story', 'Backlog bleibt terminiert', 'backlog', '2026-09-10', NULL),
          (2, 'story', 'Aktiv wird bereinigt', 'active', '2026-09-11', NULL),
          (3, 'story', 'Abgeschlossen wird bereinigt', 'done', '2026-09-12', NULL),
          (4, 'story', 'Archiviert wird bereinigt', 'backlog', '2026-09-13', '2026-09-14T08:00:00.000Z'),
          (5, 'task', 'Aufgabe bleibt geplant', 'active', '2026-09-14', NULL);
      `);

      applyMigration(sqlite, "0007_clean_non_backlog_revisit_dates.sql");

      const rows = sqlite
        .prepare(`SELECT id, scheduled_date FROM work_items ORDER BY id`)
        .all() as Array<{ id: number; scheduled_date: string | null }>;
      expect(rows).toEqual([
        { id: 1, scheduled_date: "2026-09-10" },
        { id: 2, scheduled_date: null },
        { id: 3, scheduled_date: null },
        { id: 4, scheduled_date: null },
        { id: 5, scheduled_date: "2026-09-14" },
      ]);
    } finally {
      close();
    }
  });
});
