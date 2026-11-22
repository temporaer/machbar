import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const drizzleDir = path.join(__dirname, "..", "drizzle");

describe("household backlog project owner migration", () => {
  it("clears legacy household backlog owners and rejects future violations while retaining work owners", () => {
    const { sqlite, close } = openDb(":memory:");
    try {
      sqlite.pragma("foreign_keys = OFF");
      const journal = JSON.parse(
        readFileSync(path.join(drizzleDir, "meta", "_journal.json"), "utf8"),
      ) as { entries: Array<{ tag: string }> };
      for (const { tag } of journal.entries) {
        if (tag === "0033_household_backlog_projects_unowned") break;
        sqlite.exec(readFileSync(path.join(drizzleDir, `${tag}.sql`), "utf8"));
      }
      sqlite.pragma("foreign_keys = OFF");
      sqlite.exec(`
        INSERT INTO work_items (id, role, title, status, archived_at, scope, owner_member_id) VALUES
          (1, 'story', 'Household backlog', 'backlog', NULL, 'household', 41),
          (2, 'story', 'Private backlog', 'backlog', NULL, 'work', 42),
          (3, 'story', 'Archived household', 'backlog', '2026-11-01T00:00:00.000Z', 'household', 43);
      `);
      sqlite.exec(readFileSync(path.join(drizzleDir, "0033_household_backlog_projects_unowned.sql"), "utf8"));
      sqlite.pragma("foreign_keys = ON");

      const rows = sqlite.prepare(`
        SELECT id, owner_member_id AS ownerMemberId, revision
        FROM work_items WHERE id IN (1, 2, 3) ORDER BY id
      `).all();
      expect(rows).toEqual([
        { id: 1, ownerMemberId: null, revision: 2 },
        { id: 2, ownerMemberId: 42, revision: 1 },
        { id: 3, ownerMemberId: 43, revision: 1 },
      ]);
      expect(() => sqlite.prepare(`
        INSERT INTO work_items (role, title, status, scope, owner_member_id)
        VALUES ('story', 'Invalid household backlog', 'backlog', 'household', 44)
      `).run()).toThrow(/household_backlog_project_owner_forbidden/);
      expect(() => sqlite.prepare(`
        UPDATE work_items SET scope = 'household' WHERE id = 2
      `).run()).toThrow(/household_backlog_project_owner_forbidden/);
    } finally {
      close();
    }
  });
});
