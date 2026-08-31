import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

describe("dependency blocking and cycle prevention", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await closeTestContext(ctx);
  });

  async function createTask(payload: Record<string, unknown>) {
    const res = await ctx.app.inject({ method: "POST", url: "/api/tasks", payload });
    return res.json();
  }

  it("marks a task blocked while its dependency is open and unblocks it once resolved", async () => {
    const dependsOn = await createTask({ title: "Vorher erledigen", status: "actionable" });
    const task = await createTask({ title: "Danach", status: "actionable" });

    const addDep = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/dependencies`,
      payload: { dependsOnTaskId: dependsOn.id },
    });
    expect(addDep.statusCode).toBe(201);
    expect(addDep.json().blocked).toBe(true);
    expect(addDep.json().dependencies[0].resolved).toBe(false);

    await ctx.app.inject({ method: "POST", url: `/api/tasks/${dependsOn.id}/complete` });

    const reloaded = await ctx.app.inject({ method: "GET", url: `/api/tasks/${task.id}` });
    expect(reloaded.json().blocked).toBe(false);
    expect(reloaded.json().dependencies[0].resolved).toBe(true);
  });

  it("rejects a task depending on itself", async () => {
    const task = await createTask({ title: "Selbstbezug" });
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/dependencies`,
      payload: { dependsOnTaskId: task.id },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: "task_dependency_self",
      details: { taskId: task.id },
    });
  });

  it("rejects a dependency cycle across three tasks", async () => {
    const a = await createTask({ title: "A" });
    const b = await createTask({ title: "B" });
    const c = await createTask({ title: "C" });

    await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${a.id}/dependencies`,
      payload: { dependsOnTaskId: b.id },
    });
    await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${b.id}/dependencies`,
      payload: { dependsOnTaskId: c.id },
    });

    // C -> A would close the loop A -> B -> C -> A.
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${c.id}/dependencies`,
      payload: { dependsOnTaskId: a.id },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: "task_dependency_cycle",
      details: { taskId: c.id, dependsOnTaskId: a.id },
    });
  });

  it("rejects setting a task's parent to one of its own descendants", async () => {
    const grandparent = await createTask({
      title: "Großelternaufgabe",
      status: "actionable",
    });
    const parentRes = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${grandparent.id}/children`,
      payload: { title: "Elternaufgabe" },
    });
    const parent = parentRes.json();
    const childRes = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${parent.id}/children`,
      payload: { title: "Kindaufgabe" },
    });
    const child = childRes.json();

    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${grandparent.id}/parent`,
      payload: { parentTaskId: child.id },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: "task_hierarchy_cycle",
      details: { taskId: grandparent.id, parentTaskId: child.id },
    });
  });

  it("rejects a task becoming its own parent", async () => {
    const task = await createTask({ title: "Selbst" });
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/parent`,
      payload: { parentTaskId: task.id },
    });
    expect(res.statusCode).toBe(409);
  });
});
