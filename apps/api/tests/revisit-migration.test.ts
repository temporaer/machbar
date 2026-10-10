import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import {
  DEFAULT_HOUSEHOLD_TIMEZONE,
  normalizeRevisitInput,
} from "@machbar/shared";
import { openDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import {
  applyRevisitMigration,
  assertRevisitMigrationReady,
  inspectRevisitMigration,
} from "../src/db/revisitMigration.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const drizzleDir = path.join(__dirname, "..", "drizzle");

function migrateThrough0017(handle: ReturnType<typeof openDb>) {
  const migrationDir = mkdtempSync(path.join(os.tmpdir(), "machbar-drizzle-0017-"));
  const journalPath = path.join(drizzleDir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: Array<{ idx: number; tag: string }>;
    [key: string]: unknown;
  };
  const entries = journal.entries.filter((entry) => entry.idx <= 17);
  mkdirSync(path.join(migrationDir, "meta"));
  for (const entry of entries) {
    copyFileSync(
      path.join(drizzleDir, `${entry.tag}.sql`),
      path.join(migrationDir, `${entry.tag}.sql`),
    );
  }
  writeFileSync(
    path.join(migrationDir, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries }),
  );
  try {
    handle.sqlite.pragma("foreign_keys = OFF");
    try {
      migrate(handle.db, { migrationsFolder: migrationDir });
    } finally {
      handle.sqlite.pragma("foreign_keys = ON");
    }
  } finally {
    rmSync(migrationDir, { recursive: true, force: true });
  }
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
  function readyHandle() {
    const handle = openDb(":memory:");
    runMigrations(handle.db);
    return handle;
  }

  it("requires explicit acknowledgement for existing databases", () => {
    const handle = readyHandle();
    try {
      handle.sqlite
        .prepare(
          "INSERT INTO work_items (id, role, title, status) VALUES (1, 'task', 'legacy', 'captured')",
        )
        .run();
      expect(() => assertRevisitMigrationReady(handle.sqlite)).toThrow(
        "db:revisit-dry-run",
      );
      handle.sqlite
        .prepare(
          "INSERT INTO data_migrations (name, completed_at) VALUES ('revisit_at_backfill', 'now')",
        )
        .run();
      expect(() => assertRevisitMigrationReady(handle.sqlite)).not.toThrow();
    } finally {
      handle.close();
    }
  });

  it("applies the full schema chain and initializes a fresh database idempotently", () => {
    const handle = readyHandle();
    try {
      const journal = JSON.parse(
        readFileSync(path.join(drizzleDir, "meta", "_journal.json"), "utf8"),
      ) as { entries: Array<{ idx: number; tag: string }> };
      expect(journal.entries).toHaveLength(20);
      expect(journal.entries.at(-1)).toEqual({
        idx: 19,
        tag: "0019_task_breakdown",
        version: "6",
        when: expect.any(Number),
        breakpoints: true,
      });
      const workItemColumns = handle.sqlite
        .prepare("PRAGMA table_info(work_items)")
        .all() as Array<{ name: string }>;
      expect(workItemColumns.map((column) => column.name)).toContain("revisit_at");
      expect(
        handle.sqlite
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all(),
      ).toEqual(
        expect.arrayContaining([
          { name: "data_migrations" },
          { name: "household_settings" },
        ]),
      );
      expect(
        handle.sqlite
          .prepare("SELECT value FROM household_settings WHERE key = 'timezone'")
          .get(),
      ).toEqual({ value: "Europe/Berlin" });

      assertRevisitMigrationReady(handle.sqlite);
      expect(
        handle.sqlite
          .prepare("SELECT name FROM data_migrations")
          .all(),
      ).toEqual([{ name: "revisit_at_backfill" }]);
      runMigrations(handle.db);
      assertRevisitMigrationReady(handle.sqlite);
      expect(
        handle.sqlite
          .prepare("SELECT COUNT(*) AS count FROM data_migrations")
          .get(),
      ).toEqual({ count: 1 });
      expect(
        handle.sqlite
          .prepare("SELECT COUNT(*) AS count FROM __drizzle_migrations")
          .get(),
      ).toEqual({ count: 20 });
    } finally {
      handle.close();
    }
  });

  it("upgrades a populated 0017 database through Drizzle and applies legacy mappings without losing data", () => {
    const handle = openDb(":memory:");
    try {
      migrateThrough0017(handle);
      handle.sqlite.exec(`
        INSERT INTO members (id, name, color) VALUES (1, 'Mira', '#123456');
        INSERT INTO work_items
          (id, role, title, status, scheduled_date, due_date, owner_member_id, owner_inheritance_mode,
           not_before_at, not_before_date, repeat_after_days)
        VALUES
          (1, 'task', 'ordinary revisit', 'active', NULL, '2026-01-25', 1, 'explicit', '2026-01-15T09:00:00.000Z', '2026-01-15', NULL),
          (2, 'task', 'scheduled conflict', 'active', '2026-01-20', '2026-01-25', 1, 'explicit', '2026-01-15T09:00:00.000Z', '2026-01-15', NULL),
          (3, 'task', 'recurring revisit', 'active', '2026-01-20', '2026-01-25', 1, 'explicit', '2026-01-15T09:00:00.000Z', '2026-01-15', 7),
          (4, 'task', 'waiting revisit', 'active', '2026-01-20', '2026-01-25', 1, 'explicit', '2026-01-14T09:00:00.000Z', '2026-01-14', NULL),
          (5, 'story', 'backlog revisit', 'backlog', '2026-01-15', '2026-01-30', 1, 'explicit', NULL, NULL, NULL),
          (6, 'task', 'terminal revisit', 'done', NULL, '2026-01-25', 1, 'explicit', '2026-01-15T09:00:00.000Z', '2026-01-15', NULL),
          (7, 'task', 'dependency target', 'active', NULL, NULL, 1, 'explicit', NULL, NULL, NULL);
        INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (1, 7);
        INSERT INTO task_external_waits (task_id, waiting_for, revisit_date)
        VALUES (4, 'Insurance', '2026-01-16');
        INSERT INTO task_reminders (task_id, kind, at)
        VALUES (1, 'absolute', '2026-01-14T09:00:00.000Z');
        INSERT INTO activity_events (kind, entity_type, entity_title)
        VALUES ('task_created', 'task', 'ordinary revisit');
      `);
      runMigrations(handle.db);
      expect(
        handle.sqlite
        .prepare("SELECT title, due_date, owner_member_id FROM work_items WHERE id = 1")
        .get(),
      ).toEqual({
        title: "ordinary revisit",
        due_date: "2026-01-25",
        owner_member_id: 1,
      });
      expect(
        handle.sqlite.prepare("SELECT COUNT(*) AS count FROM task_dependencies").get(),
      ).toEqual({ count: 1 });
      expect(() => assertRevisitMigrationReady(handle.sqlite)).toThrow(
        "db:revisit-dry-run",
      );

      const report = inspectRevisitMigration(handle.sqlite);
      expect(report.timezone).toBe("Europe/Berlin");
      expect(report.conflictCount).toBeGreaterThan(0);
      expect(report.rows.find((row) => row.id === 2)?.conflicts).toContain(
        "scheduled_date_preserved_over_not_before",
      );
      expect(report.rows.find((row) => row.id === 4)?.conflicts).toContain(
        "external_wait_revisit_preferred_over_not_before",
      );

      handle.sqlite.exec(`
        CREATE TRIGGER fail_revisit_backfill_for_test
        BEFORE UPDATE ON work_items
        WHEN NEW.id = 4
        BEGIN
          SELECT RAISE(ABORT, 'forced backfill failure');
        END;
      `);
      expect(() =>
        applyRevisitMigration(handle.sqlite, { allowConflicts: true }),
      ).toThrow("forced backfill failure");
      expect(
        handle.sqlite
          .prepare("SELECT revisit_at, not_before_at FROM work_items WHERE id = 1")
          .get(),
      ).toEqual({
        revisit_at: null,
        not_before_at: "2026-01-15T09:00:00.000Z",
      });
      expect(
        handle.sqlite
          .prepare("SELECT COUNT(*) AS count FROM data_migrations")
          .get(),
      ).toEqual({ count: 0 });
      handle.sqlite.exec("DROP TRIGGER fail_revisit_backfill_for_test");

      applyRevisitMigration(handle.sqlite, { allowConflicts: true });
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
        {
          id: 7,
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
          .prepare("SELECT title, due_date, owner_member_id FROM work_items WHERE id = 1")
          .get(),
      ).toEqual({
        title: "ordinary revisit",
        due_date: "2026-01-25",
        owner_member_id: 1,
      });
      expect(
        handle.sqlite.prepare("SELECT COUNT(*) AS count FROM task_dependencies").get(),
      ).toEqual({ count: 1 });
      expect(
        handle.sqlite
          .prepare("SELECT name FROM data_migrations WHERE name = 'revisit_at_backfill'")
          .get(),
      ).toEqual({ name: "revisit_at_backfill" });
      expect(() => assertRevisitMigrationReady(handle.sqlite)).not.toThrow();
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
