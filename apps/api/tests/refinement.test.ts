import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DbHandle } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import * as schema from "../src/db/schema.js";
import {
  createProject,
  createTask,
  updateTask,
  moveSubtreeToProject,
} from "../src/domain/mutations.js";
import {
  getRefinementOwnerSizeCounts,
  getRefinementTasks,
} from "../src/repo/refinementRepo.js";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

/**
 * Direct repository-level tests for the refinement aggregation/listing
 * queries: owner inheritance, the shared/unassigned bucket, done/cancelled
 * exclusion, owner/project filters, and that reassignment/project moves are
 * reflected without any extra bookkeeping (owner is always recomputed live
 * via `effectiveRepo`'s CTE, never cached).
 */
describe("refinementRepo", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = openDb(":memory:");
    runMigrations(handle.db);
  });

  afterEach(() => {
    handle.close();
  });

  function createMember(name: string) {
    return handle.db
      .insert(schema.members)
      .values({ name, color: "#123456" })
      .returning()
      .get();
  }

  function countsFor(ownerId: number | null, rows: ReturnType<typeof getRefinementOwnerSizeCounts>) {
    return rows.find((r) => r.ownerId === ownerId)!;
  }

  it("aggregates open tasks by effective owner (project-inherited and parent-inherited) and size", () => {
    const owner = createMember("Projektinhaberin");
    const project = createProject(handle.db, { title: "Projekt", ownerMemberId: owner.id });
    const root = createTask(handle.db, {
      projectId: project.id,
      title: "Wurzel",
      size: "M",
      status: "actionable",
    });
    createTask(handle.db, {
      parentTaskId: root.id,
      title: "Kind",
      size: "S",
      status: "actionable",
    });
    createTask(handle.db, {
      projectId: project.id,
      title: "Ohne Größe",
      status: "actionable",
    });

    const counts = getRefinementOwnerSizeCounts(handle.db);
    const ownerCounts = countsFor(owner.id, counts);
    expect(ownerCounts.S).toBe(1);
    expect(ownerCounts.M).toBe(1);
    expect(ownerCounts.unestimated).toBe(1);
    expect(ownerCounts.total).toBe(3);
  });

  it("groups tasks with no effective owner (including opted-out) under the shared/null bucket", () => {
    createTask(handle.db, { title: "Ohne Zuständigkeit", size: "L", status: "actionable" });
    const owner = createMember("Jemand");
    const projectOwned = createProject(handle.db, {
      title: "Projekt",
      ownerMemberId: owner.id,
    });
    createTask(handle.db, {
      projectId: projectOwned.id,
      title: "Explizit ohne",
      size: "XL",
      status: "actionable",
      ownerInheritanceMode: "none",
    });

    const counts = getRefinementOwnerSizeCounts(handle.db);
    const shared = countsFor(null, counts);
    expect(shared.L).toBe(1);
    expect(shared.XL).toBe(1);
    expect(shared.total).toBe(2);
    // The owned project's own count stays unaffected by the opted-out task.
    expect(countsFor(owner.id, counts).total).toBe(0);
  });

  it("excludes done and cancelled tasks from both owner counts and task rows", () => {
    const owner = createMember("Erledigerin");
    const done = createTask(handle.db, {
      title: "Fertig",
      size: "S",
      status: "actionable",
      ownerMemberId: owner.id,
      ownerInheritanceMode: "explicit",
    });
    updateTask(handle.db, done.id, { status: "done" });
    const cancelled = createTask(handle.db, {
      title: "Verworfen",
      size: "M",
      status: "actionable",
      ownerMemberId: owner.id,
      ownerInheritanceMode: "explicit",
    });
    updateTask(handle.db, cancelled.id, { status: "cancelled" });
    createTask(handle.db, {
      title: "Offen",
      size: "L",
      status: "actionable",
      ownerMemberId: owner.id,
      ownerInheritanceMode: "explicit",
    });

    const counts = getRefinementOwnerSizeCounts(handle.db);
    const ownerCounts = countsFor(owner.id, counts);
    expect(ownerCounts.total).toBe(1);
    expect(ownerCounts.L).toBe(1);

    const rows = getRefinementTasks(handle.db);
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain(done.id);
    expect(ids).not.toContain(cancelled.id);
  });

  it("filters task rows and counts by ownerId (including the 'none'/shared bucket) and by projectId", () => {
    const alice = createMember("Alice");
    const bob = createMember("Bob");
    const projectA = createProject(handle.db, { title: "A", ownerMemberId: alice.id });
    const projectB = createProject(handle.db, { title: "B", ownerMemberId: bob.id });
    const taskA = createTask(handle.db, {
      projectId: projectA.id,
      title: "A-Aufgabe",
      status: "actionable",
      size: "S",
    });
    createTask(handle.db, {
      projectId: projectB.id,
      title: "B-Aufgabe",
      status: "actionable",
      size: "M",
    });
    const sharedTask = createTask(handle.db, {
      title: "Geteilt",
      status: "actionable",
      size: "L",
    });

    const aliceRows = getRefinementTasks(handle.db, { ownerId: alice.id });
    expect(aliceRows.map((r) => r.id)).toEqual([taskA.id]);

    const projectARows = getRefinementTasks(handle.db, { projectId: projectA.id });
    expect(projectARows.map((r) => r.id)).toEqual([taskA.id]);

    const sharedRows = getRefinementTasks(handle.db, { ownerId: null });
    expect(sharedRows.map((r) => r.id)).toEqual([sharedTask.id]);

    const aliceCounts = getRefinementOwnerSizeCounts(handle.db, { ownerId: alice.id });
    expect(countsFor(alice.id, aliceCounts).total).toBe(1);
    expect(countsFor(bob.id, aliceCounts).total).toBe(0);
    expect(countsFor(null, aliceCounts).total).toBe(0);
  });

  it("reflects reassignment: a task's owner bucket changes immediately after updateTask", () => {
    const alice = createMember("Alice");
    const bob = createMember("Bob");
    const task = createTask(handle.db, {
      title: "Wechselnd",
      status: "actionable",
      size: "M",
      ownerMemberId: alice.id,
      ownerInheritanceMode: "explicit",
    });

    let counts = getRefinementOwnerSizeCounts(handle.db);
    expect(countsFor(alice.id, counts).total).toBe(1);
    expect(countsFor(bob.id, counts).total).toBe(0);

    updateTask(handle.db, task.id, { ownerMemberId: bob.id });

    counts = getRefinementOwnerSizeCounts(handle.db);
    expect(countsFor(alice.id, counts).total).toBe(0);
    expect(countsFor(bob.id, counts).total).toBe(1);

    const rows = getRefinementTasks(handle.db);
    const row = rows.find((r) => r.id === task.id)!;
    expect(row.effectiveOwnerId).toBe(bob.id);
  });

  it("reflects project moves: moving a task to a project with a different owner updates its effective owner and project filter results", () => {
    const alice = createMember("Alice");
    const bob = createMember("Bob");
    const projectA = createProject(handle.db, { title: "A", ownerMemberId: alice.id });
    const projectB = createProject(handle.db, { title: "B", ownerMemberId: bob.id });
    const task = createTask(handle.db, {
      projectId: projectA.id,
      title: "Wandert",
      status: "actionable",
      size: "S",
    });

    expect(getRefinementTasks(handle.db, { projectId: projectA.id }).map((r) => r.id)).toEqual([
      task.id,
    ]);
    expect(countsFor(alice.id, getRefinementOwnerSizeCounts(handle.db)).total).toBe(1);

    moveSubtreeToProject(handle.db, task.id, projectB.id);

    expect(getRefinementTasks(handle.db, { projectId: projectA.id })).toEqual([]);
    expect(getRefinementTasks(handle.db, { projectId: projectB.id }).map((r) => r.id)).toEqual([
      task.id,
    ]);
    const counts = getRefinementOwnerSizeCounts(handle.db);
    expect(countsFor(alice.id, counts).total).toBe(0);
    expect(countsFor(bob.id, counts).total).toBe(1);
  });

  it("always includes every member plus a trailing shared row, even with all-zero counts", () => {
    const alice = createMember("Alice");
    const counts = getRefinementOwnerSizeCounts(handle.db);
    expect(counts).toHaveLength(2);
    expect(counts[0]).toMatchObject({ ownerId: alice.id, total: 0, S: 0, M: 0, L: 0, XL: 0, unestimated: 0 });
    expect(counts[1]).toMatchObject({ ownerId: null, total: 0 });
  });
});

/**
 * HTTP-level tests for the `/api/refinement/*` routes and the task
 * create/update `size` plumbing that backs the refinement UI's size-cycle
 * interactions.
 */
describe("refinement API routes", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await closeTestContext(ctx);
  });

  async function post(url: string, payload: Record<string, unknown>) {
    return ctx.app.inject({ method: "POST", url, payload });
  }

  async function patch(url: string, payload: Record<string, unknown>) {
    return ctx.app.inject({ method: "PATCH", url, payload });
  }

  it("creates a task with a size and returns 400 for an invalid size", async () => {
    const created = await post("/api/tasks", { title: "Größere Aufgabe", size: "L" });
    expect(created.statusCode).toBe(201);

    const invalid = await post("/api/tasks", { title: "Ungültig", size: "XXL" });
    expect(invalid.statusCode).toBe(400);
  });

  it("updates a task's size, including clearing it back to null", async () => {
    const created = (await post("/api/tasks", { title: "Aufgabe" })).json();

    const withSize = await patch(`/api/tasks/${created.id}`, { size: "XL" });
    expect(withSize.statusCode).toBe(200);

    const cleared = await patch(`/api/tasks/${created.id}`, { size: null });
    expect(cleared.statusCode).toBe(200);
  });

  it("GET /api/refinement/owners returns the owner x size matrix with a shared row", async () => {
    const memberRes = await ctx.app.inject({
      method: "POST",
      url: "/api/members",
      payload: { name: "Refinement-Mitglied" },
    });
    const member = memberRes.json();
    await post("/api/tasks", {
      title: "Zugeordnet",
      size: "S",
      status: "actionable",
      ownerMemberId: member.id,
      ownerInheritanceMode: "explicit",
    });
    await post("/api/tasks", { title: "Geteilt", size: "M", status: "actionable" });

    const res = await ctx.app.inject({ method: "GET", url: "/api/refinement/owners" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ ownerId: number | null; S: number; M: number; total: number }>;
    const ownerRow = body.find((r) => r.ownerId === member.id)!;
    expect(ownerRow.S).toBe(1);
    const sharedRow = body.find((r) => r.ownerId === null)!;
    expect(sharedRow.M).toBe(1);
  });

  it("GET /api/refinement/tasks supports ownerId=none and projectId filters, and rejects unknown owners", async () => {
    const projectRes = await ctx.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { title: "Refinement-Projekt" },
    });
    const project = projectRes.json();
    await post("/api/tasks", {
      title: "Im Projekt",
      projectId: project.id,
      status: "actionable",
      size: "S",
    });
    await post("/api/tasks", { title: "Geteilt", status: "actionable", size: "M" });

    const sharedRes = await ctx.app.inject({
      method: "GET",
      url: "/api/refinement/tasks?ownerId=none",
    });
    expect(sharedRes.statusCode).toBe(200);
    expect(sharedRes.json()).toHaveLength(2);

    const projectRowsRes = await ctx.app.inject({
      method: "GET",
      url: `/api/refinement/tasks?projectId=${project.id}`,
    });
    expect(projectRowsRes.json()).toHaveLength(1);

    const unknownOwnerRes = await ctx.app.inject({
      method: "GET",
      url: "/api/refinement/tasks?ownerId=999999",
    });
    expect(unknownOwnerRes.statusCode).toBe(404);
  });

  it("excludes done/cancelled tasks from /api/refinement/tasks", async () => {
    const created = await post("/api/tasks", { title: "Wird erledigt", status: "actionable" });
    const task = created.json();
    await ctx.app.inject({ method: "POST", url: `/api/tasks/${task.id}/complete`, payload: {} });

    const res = await ctx.app.inject({ method: "GET", url: "/api/refinement/tasks" });
    expect(res.json().map((r: { id: number }) => r.id)).not.toContain(task.id);
  });
});
