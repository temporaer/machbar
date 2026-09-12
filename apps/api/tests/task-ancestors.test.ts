import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeTestContext,
  createTestContext,
  insertTestProject,
  insertTestTask,
  type TestContext,
} from "./helpers.js";

/**
 * `GET /api/tasks/:id` is the one detail response that carries the full
 * ordered ancestor chain (`Graph.taskAncestorsFor`) — list/tree endpoints
 * never do. See `docs/architecture.md`/`docs/architecture-rules.md`.
 */
describe("task detail ancestor breadcrumbs", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await closeTestContext(ctx);
  });

  it("returns project and task ancestors in outermost-first order for a nested task", async () => {
    const haus = insertTestProject(ctx.handle.db, { title: "Haus" });
    const urlaub = insertTestProject(ctx.handle.db, {
      title: "Urlaub",
      parentId: haus.id,
    });
    const autoPacken = insertTestTask(ctx.handle.db, {
      title: "Auto packen",
      projectId: urlaub.id,
    });
    const kofferEinladen = insertTestTask(ctx.handle.db, {
      title: "Koffer einladen",
      parentTaskId: autoPacken.id,
    });

    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/tasks/${kofferEinladen.id}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ancestors).toEqual([
      { id: haus.id, role: "story", title: "Haus" },
      { id: urlaub.id, role: "story", title: "Urlaub" },
      { id: autoPacken.id, role: "task", title: "Auto packen" },
    ]);
  });

  it("returns only task ancestors for a standalone nested task with no project", async () => {
    const parent = insertTestTask(ctx.handle.db, { title: "Elternaufgabe" });
    const child = insertTestTask(ctx.handle.db, {
      title: "Kindaufgabe",
      parentTaskId: parent.id,
    });

    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/tasks/${child.id}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ancestors).toEqual([
      { id: parent.id, role: "task", title: "Elternaufgabe" },
    ]);
  });

  it("returns no ancestors for a standalone root task", async () => {
    const root = insertTestTask(ctx.handle.db, { title: "Alleinstehend" });

    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/tasks/${root.id}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ancestors).toEqual([]);
  });

  it("returns the project as the sole ancestor for a root task directly under a project", async () => {
    const project = insertTestProject(ctx.handle.db, { title: "Umzug" });
    const rootTask = insertTestTask(ctx.handle.db, {
      title: "Kartons besorgen",
      projectId: project.id,
    });

    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/tasks/${rootTask.id}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ancestors).toEqual([
      { id: project.id, role: "story", title: "Umzug" },
    ]);
  });

  it("does not include an ancestor chain on the task list/tree endpoint", async () => {
    const project = insertTestProject(ctx.handle.db, { title: "Projekt" });
    const parent = insertTestTask(ctx.handle.db, {
      title: "Elternaufgabe",
      projectId: project.id,
    });
    insertTestTask(ctx.handle.db, {
      title: "Kindaufgabe",
      parentTaskId: parent.id,
    });

    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/projects/${project.id}`,
    });
    expect(res.statusCode).toBe(200);
    for (const task of res.json().tasks) {
      expect(task).not.toHaveProperty("ancestors");
    }
  });
});
