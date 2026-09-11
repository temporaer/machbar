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

describe("task_reminders migration", () => {
  it("converts every existing legacy work_items.reminder_at into one absolute task_reminders row and clears the legacy column", () => {
    const { sqlite, close } = openDb(":memory:");
    try {
      applyMigration(sqlite, "0000_baseline.sql");
      applyMigration(sqlite, "0001_work_items_merge.sql");
      applyMigration(sqlite, "0002_add_additional_next_action.sql");

      sqlite.exec(`
        INSERT INTO work_items (id, role, title, reminder_at) VALUES
          (1, 'task', 'Paket abholen', '2026-08-30T08:00:00.000Z'),
          (2, 'task', 'Ohne Erinnerung', NULL),
          (3, 'task', 'Zweite Erinnerung', '2026-09-01T09:00:00.000Z');
      `);

      applyMigration(sqlite, "0003_add_task_reminders.sql");

      const reminders = sqlite
        .prepare(`SELECT task_id, kind, at FROM task_reminders ORDER BY task_id`)
        .all() as Array<{ task_id: number; kind: string; at: string }>;
      expect(reminders).toEqual([
        { task_id: 1, kind: "absolute", at: "2026-08-30T08:00:00.000Z" },
        { task_id: 3, kind: "absolute", at: "2026-09-01T09:00:00.000Z" },
      ]);

      const legacyValues = sqlite
        .prepare(`SELECT id, reminder_at FROM work_items ORDER BY id`)
        .all() as Array<{ id: number; reminder_at: string | null }>;
      expect(legacyValues.every((row) => row.reminder_at === null)).toBe(true);
    } finally {
      close();
    }
  });
});
