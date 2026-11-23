import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/client.js";
import { getEffectiveOwners } from "../src/repo/effectiveRepo.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const drizzleDir = path.join(__dirname, "..", "drizzle");

describe("household backlog project owner migration", () => {
  it("clears legacy household backlog project owners while retaining work and task owners", () => {
    const { db, sqlite, close } = openDb(":memory:");
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
        INSERT INTO members (id, name, color) VALUES
          (41, 'Legacy Anna', '#111111'),
          (42, 'Work owner', '#222222'),
          (43, 'Archived owner', '#333333'),
          (44, 'Explicit task owner', '#444444');
        INSERT INTO work_items (id, role, title, status, archived_at, scope, owner_member_id) VALUES
          (1, 'story', 'Household backlog', 'backlog', NULL, 'household', 41),
          (2, 'story', 'Private backlog', 'backlog', NULL, 'work', 42),
          (3, 'story', 'Archived household', 'backlog', '2026-11-01T00:00:00.000Z', 'household', 43),
          (4, 'task', 'Explicit household task', 'backlog', NULL, 'household', 44),
          (5, 'task', 'Inherited household task', 'actionable', NULL, 'household', NULL),
          (6, 'task', 'Nested inherited household task', 'actionable', NULL, 'household', NULL),
          (7, 'task', 'Intentionally unassigned task', 'actionable', NULL, 'household', NULL);
        UPDATE work_items SET parent_id = 1 WHERE id = 5;
        UPDATE work_items SET parent_id = 5 WHERE id = 6;
        UPDATE work_items SET parent_id = 1, owner_inheritance_mode = 'none' WHERE id = 7;
        UPDATE work_items SET task_kind = 'action' WHERE id = 5;
      `);
      sqlite.exec("UPDATE work_items SET parent_id = 1, owner_inheritance_mode = 'explicit' WHERE id = 4");
      const beforeOwners = getEffectiveOwners(db);
      expect(beforeOwners.get(5)?.ownerId).toBe(41);
      expect(beforeOwners.get(6)?.ownerId).toBe(41);
      expect(beforeOwners.get(7)?.ownerId).toBeNull();

      sqlite.exec(readFileSync(path.join(drizzleDir, "0033_household_backlog_projects_unowned.sql"), "utf8"));
      sqlite.pragma("foreign_keys = ON");

      const rows = sqlite.prepare(`
        SELECT id, owner_member_id AS ownerMemberId, owner_inheritance_mode AS ownerInheritanceMode, revision
        FROM work_items WHERE id IN (1, 2, 3, 4, 5, 6, 7) ORDER BY id
      `).all();
      expect(rows).toEqual(expect.arrayContaining([
        { id: 1, ownerMemberId: null, ownerInheritanceMode: "inherit", revision: 2 },
        { id: 2, ownerMemberId: 42, ownerInheritanceMode: "inherit", revision: 1 },
        { id: 3, ownerMemberId: 43, ownerInheritanceMode: "inherit", revision: 1 },
        { id: 4, ownerMemberId: 44, ownerInheritanceMode: "explicit", revision: 1 },
        { id: 5, ownerMemberId: null, ownerInheritanceMode: "inherit", revision: 1 },
        { id: 6, ownerMemberId: null, ownerInheritanceMode: "inherit", revision: 1 },
        { id: 7, ownerMemberId: null, ownerInheritanceMode: "none", revision: 1 },
      ]));
      const afterOwners = getEffectiveOwners(db);
      expect(afterOwners.get(5)?.ownerId).toBeNull();
      expect(afterOwners.get(6)?.ownerId).toBeNull();
      expect(afterOwners.get(7)?.ownerId).toBeNull();
      expect(afterOwners.get(4)?.ownerId).toBe(44);

    } finally {
      close();
    }
  });
});
