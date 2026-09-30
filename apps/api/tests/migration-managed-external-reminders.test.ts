import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const drizzleDir = path.join(__dirname, "..", "drizzle");

function applyMigration(
  sqlite: ReturnType<typeof openDb>["sqlite"],
  file: string,
) {
  sqlite.exec(readFileSync(path.join(drizzleDir, file), "utf8"));
}

describe("managed external reminders migration", () => {
  it("moves the legacy pointer to the default keyed mapping", () => {
    const { sqlite, close } = openDb(":memory:");
    try {
      for (const migration of [
        "0000_baseline.sql",
        "0001_work_items_merge.sql",
        "0002_add_additional_next_action.sql",
        "0003_add_task_reminders.sql",
        "0004_add_work_item_scope.sql",
        "0005_add_mcp_agents.sql",
        "0006_add_task_not_before.sql",
        "0007_external_task_links.sql",
        "0008_add_task_kind.sql",
        "0009_ai_intake_bridge.sql",
        "0010_intake_accepted_draft.sql",
        "0011_intake_apply_claim_lease.sql",
        "0012_add_managed_external_reminder.sql",
      ]) {
        applyMigration(sqlite, migration);
      }
      sqlite.exec(`
        INSERT INTO work_items (id, role, title, status)
        VALUES (1, 'task', 'Bestehende Aufgabe', 'active');
        INSERT INTO task_reminders (id, task_id, kind, days_before, time, timezone)
        VALUES (1, 1, 'deadline_relative', 1, '19:00', 'Europe/Berlin');
        INSERT INTO external_task_links (
          id, source, source_key, task_id, managed_reminder_id
        ) VALUES (1, 'home_assistant', 'legacy', 1, 1);
      `);

      applyMigration(sqlite, "0013_add_keyed_managed_external_reminders.sql");

      const columns = sqlite
        .prepare("PRAGMA table_info(external_task_links)")
        .all() as Array<{ name: string }>;
      expect(columns.map(({ name }) => name)).not.toContain("managed_reminder_id");
      expect(
        sqlite
          .prepare(
            "SELECT external_task_link_id, key, reminder_id FROM external_task_link_managed_reminders",
          )
          .all(),
      ).toEqual([{ external_task_link_id: 1, key: "default", reminder_id: 1 }]);
    } finally {
      close();
    }
  });
});
