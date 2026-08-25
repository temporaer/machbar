import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate.js";
import { seedDatabase } from "../src/db/seed.js";
import * as schema from "../src/db/schema.js";

/**
 * Exercises `seedDatabase` directly against the drizzle schema (no
 * Fastify app / domain layer involved) so this stays valid even while
 * downstream domain/route modules still need to catch up to the new
 * acceptance-criteria/size contract.
 */
describe("seed data (schema-level)", () => {
  let sqlite: Database.Database;

  afterEach(() => {
    sqlite.close();
  });

  function seed() {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    const db = drizzle(sqlite, { schema });
    runMigrations(db);
    seedDatabase(db);
    return db;
  }

  it("covers every project status: backlog, active, completed, archived", () => {
    const db = seed();
    const rows = db.select().from(schema.projects).all();
    const statuses = new Set(rows.map((p) => p.status));
    expect(statuses).toEqual(new Set(["backlog", "active", "completed", "archived"]));
  });

  it("stores acceptance criteria with both checked and unchecked rows, never as a project.description", () => {
    const db = seed();
    const projectColumns = sqlite
      .prepare("PRAGMA table_info(projects)")
      .all() as Array<{ name: string }>;
    expect(projectColumns.map((c) => c.name)).not.toContain("description");

    const criteria = db.select().from(schema.projectAcceptanceCriteria).all();
    expect(criteria.length).toBeGreaterThan(0);
    expect(criteria.some((c) => c.checked)).toBe(true);
    expect(criteria.some((c) => !c.checked)).toBe(true);
    // Positions are per-project, always starting at 0.
    const firstOfEachProject = new Map<number, number>();
    for (const c of criteria) {
      if (!firstOfEachProject.has(c.projectId)) {
        firstOfEachProject.set(c.projectId, c.position);
      }
    }
    for (const pos of firstOfEachProject.values()) expect(pos).toBe(0);
  });

  it("has both sized and unsized tasks", () => {
    const db = seed();
    const tasks = db.select().from(schema.tasks).all();
    const sizes = new Set(tasks.map((t) => t.size));
    expect(sizes.has(null)).toBe(true);
    expect(["S", "M", "L", "XL"].some((s) => sizes.has(s))).toBe(true);
  });

  it("has both driver (owned) and no-driver (unowned) projects", () => {
    const db = seed();
    const rows = db.select().from(schema.projects).all();
    expect(rows.some((p) => p.ownerMemberId !== null)).toBe(true);
    expect(rows.some((p) => p.ownerMemberId === null)).toBe(true);
  });

  it("includes an active project whose tasks are all done/cancelled (future completion_review case)", () => {
    const db = seed();
    const projects = db.select().from(schema.projects).all();
    const homeoffice = projects.find(
      (p) => p.title === "Homeoffice-Ecke einrichten",
    );
    expect(homeoffice?.status).toBe("active");
    const tasks = db
      .select()
      .from(schema.tasks)
      .all()
      .filter((t) => t.projectId === homeoffice?.id);
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks.every((t) => t.status === "done" || t.status === "cancelled")).toBe(
      true,
    );
  });

  it("preserves the existing agenda example projects and their task titles", () => {
    const db = seed();
    const projects = db.select().from(schema.projects).all();
    const titles = projects.map((p) => p.title);
    expect(titles).toEqual(
      expect.arrayContaining([
        "Umzug nach Leipzig",
        "Garten winterfest machen",
        "Steuererklärung 2025",
        "Küche renovieren",
        "Wartungsplan Auto",
        "Bücherregal aufbauen",
      ]),
    );
    const tasks = db.select().from(schema.tasks).all();
    const taskTitles = tasks.map((t) => t.title);
    expect(taskTitles).toEqual(
      expect.arrayContaining([
        "Kartons besorgen",
        "Leiter zurückbringen",
        "Nachbarn wegen Leiter fragen",
      ]),
    );
  });
});
