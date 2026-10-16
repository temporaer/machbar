import { describe, expect, it } from "vitest";
import * as schema from "../src/db/schema.js";
import { createTestDatabase, insertTestTask } from "./database.js";

// Guard fixture isolation because all domain and HTTP suites share this template.
describe("migrated database fixtures", () => {
  it("isolates writes, sequences and connection settings between copies", () => {
    const first = createTestDatabase();
    const second = createTestDatabase();
    try {
      const task = insertTestTask(first.db, { title: "Only in the first copy" });
      first.sqlite.pragma("foreign_keys = OFF");
      expect(second.db.select().from(schema.workItems).all()).toEqual([]);
      expect(second.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
      const other = insertTestTask(second.db, { title: "Independent sequence" });
      expect(other.id).toBe(task.id);
    } finally {
      first.close();
      second.close();
    }
    const later = createTestDatabase();
    try {
      expect(later.db.select().from(schema.workItems).all()).toEqual([]);
      expect(later.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(later.sqlite.pragma("foreign_key_check")).toEqual([]);
    } finally {
      later.close();
    }
  });

  it("enforces foreign keys in restored databases", () => {
    const handle = createTestDatabase();
    try {
      expect(() => insertTestTask(handle.db, {
        title: "Missing parent",
        parentTaskId: 999_999,
      })).toThrow();
    } finally {
      handle.close();
    }
  });
});
