import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_HOUSEHOLD_TIMEZONE,
  normalizeRevisitInput,
} from "@machbar/shared";
import { openDb } from "../src/db/client.js";
import {
  applyRevisitMigration,
  inspectRevisitMigration,
} from "../src/db/revisitMigration.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const drizzleDir = path.join(__dirname, "..", "drizzle");

function applyMigration(sqlite: ReturnType<typeof openDb>["sqlite"], file: string) {
  sqlite.exec(readFileSync(path.join(drizzleDir, file), "utf8"));
}

describe("revisit time conversion", () => {
  it("uses the configured household timezone and rejects DST gaps/overlaps", () => {
    expect(normalizeRevisitInput("2026-01-15", DEFAULT_HOUSEHOLD_TIMEZONE).value).toBe(
      "2026-01-14T23:00:00Z",
    );
    expect(
      normalizeRevisitInput("2026-03-29T02:30", DEFAULT_HOUSEHOLD_TIMEZONE).status,
    ).toBe("nonexistent");
    expect(
      normalizeRevisitInput("2026-10-25T02:30", DEFAULT_HOUSEHOLD_TIMEZONE).status,
    ).toBe("ambiguous");
  });
});

describe("revisit migration", () => {
  it("plans and applies legacy mappings without losing protected data", () => {
    const handle = openDb(":memory:");
    try {
      for (const file of [
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
        "0013_add_keyed_managed_external_reminders.sql",
        "0014_intake_retry_hint.sql",
        "0015_add_cleanup_rounds.sql",
        "0016_add_household_ai_context.sql",
        "0017_add_activity_digest_state.sql",
      ]) {
        applyMigration(handle.sqlite, file);
      }
      handle.sqlite.exec(`
        INSERT INTO work_items
          (id, role, title, status, scheduled_date, not_before_at, not_before_date, repeat_after_days)
        VALUES
          (1, 'task', 'ordinary revisit', 'active', NULL, '2026-01-15T09:00:00.000Z', '2026-01-15', NULL),
          (2, 'task', 'scheduled conflict', 'active', '2026-01-20', '2026-01-15T09:00:00.000Z', '2026-01-15', NULL),
          (3, 'task', 'recurring revisit', 'active', '2026-01-20', '2026-01-15T09:00:00.000Z', '2026-01-15', 7),
          (4, 'task', 'waiting revisit', 'active', '2026-01-20', '2026-01-14T09:00:00.000Z', '2026-01-14', NULL),
          (5, 'story', 'backlog revisit', 'backlog', '2026-01-15', NULL, NULL, NULL),
          (6, 'task', 'terminal revisit', 'done', NULL, '2026-01-15T09:00:00.000Z', '2026-01-15', NULL);
        INSERT INTO task_external_waits (task_id, waiting_for, revisit_date)
        VALUES (4, 'Insurance', '2026-01-16');
        INSERT INTO task_reminders (task_id, kind, at)
        VALUES (1, 'absolute', '2026-01-14T09:00:00.000Z');
        INSERT INTO activity_events (kind, entity_type, entity_title)
        VALUES ('task_created', 'task', 'ordinary revisit');
      `);
      applyMigration(handle.sqlite, "0018_add_revisit_at.sql");
      applyMigration(handle.sqlite, "0019_add_household_settings.sql");

      const report = inspectRevisitMigration(handle.sqlite);
      expect(report.timezone).toBe("Europe/Berlin");
      expect(report.conflictCount).toBeGreaterThan(0);
      expect(report.rows.find((row) => row.id === 2)?.conflicts).toContain(
        "scheduled_date_preserved_over_not_before",
      );
      expect(report.rows.find((row) => row.id === 4)?.conflicts).toContain(
        "external_wait_revisit_preferred_over_not_before",
      );

      applyRevisitMigration(handle.sqlite);
      const rows = handle.sqlite
        .prepare(
          `SELECT id, scheduled_date, revisit_at, not_before_at, not_before_date
           FROM work_items ORDER BY id`,
        )
        .all();
      expect(rows).toEqual([
        {
          id: 1,
          scheduled_date: null,
          revisit_at: "2026-01-15T09:00:00.000Z",
          not_before_at: null,
          not_before_date: null,
        },
        {
          id: 2,
          scheduled_date: "2026-01-20",
          revisit_at: null,
          not_before_at: null,
          not_before_date: null,
        },
        {
          id: 3,
          scheduled_date: "2026-01-20",
          revisit_at: "2026-01-15T09:00:00.000Z",
          not_before_at: null,
          not_before_date: null,
        },
        {
          id: 4,
          scheduled_date: "2026-01-20",
          revisit_at: "2026-01-15T23:00:00Z",
          not_before_at: null,
          not_before_date: null,
        },
        {
          id: 5,
          scheduled_date: null,
          revisit_at: "2026-01-14T23:00:00Z",
          not_before_at: null,
          not_before_date: null,
        },
        {
          id: 6,
          scheduled_date: null,
          revisit_at: null,
          not_before_at: null,
          not_before_date: null,
        },
      ]);
      expect(
        handle.sqlite
          .prepare("SELECT revisit_date FROM task_external_waits WHERE task_id = 4")
          .get(),
      ).toEqual({ revisit_date: null });
      expect(
        handle.sqlite
          .prepare("SELECT COUNT(*) AS count FROM task_reminders")
          .get(),
      ).toEqual({ count: 1 });
      expect(
        handle.sqlite
          .prepare("SELECT COUNT(*) AS count FROM activity_events")
          .get(),
      ).toEqual({ count: 1 });
      expect(
        handle.sqlite
          .prepare("SELECT COUNT(*) AS count FROM data_migrations")
          .get(),
      ).toEqual({ count: 1 });

      const secondReport = applyRevisitMigration(handle.sqlite);
      expect(secondReport.alreadyApplied).toBe(true);
      expect(
        handle.sqlite
          .prepare("PRAGMA foreign_key_check")
          .all(),
      ).toEqual([]);
    } finally {
      handle.close();
    }
  });
});
