import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

describe("task CRUD and lifecycle (complete/reopen/cancel)", () => {
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

  it("creates, updates and deletes a task", async () => {
    const created = await createTask({ title: "Neue Aufgabe", notes: "Notiz" });
    expect(created.status).toBe("inbox");

    const updateRes = await ctx.app.inject({
      method: "PATCH",
      url: `/api/tasks/${created.id}`,
      payload: { title: "Geänderte Aufgabe", status: "actionable" },
    });
    expect(updateRes.json().title).toBe("Geänderte Aufgabe");
    expect(updateRes.json().status).toBe("actionable");

    const deleteRes = await ctx.app.inject({
      method: "DELETE",
      url: `/api/tasks/${created.id}`,
    });
    expect(deleteRes.statusCode).toBe(204);

    const getRes = await ctx.app.inject({ method: "GET", url: `/api/tasks/${created.id}` });
    expect(getRes.statusCode).toBe(404);
  });

  it("rejects an empty title", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { title: "" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("requires an explicit descendants policy before completing a task with open children", async () => {
    const parent = await createTask({ title: "Elternaufgabe", status: "actionable" });
    await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${parent.id}/children`,
      payload: { title: "Offenes Kind", status: "actionable" },
    });

    const withoutPolicy = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${parent.id}/complete`,
    });
    expect(withoutPolicy.statusCode).toBe(409);
    expect(withoutPolicy.json().error.details.options).toEqual([
      "leave_open",
      "complete_children",
    ]);

    // Still not completed after the rejected attempt.
    const stillOpen = await ctx.app.inject({ method: "GET", url: `/api/tasks/${parent.id}` });
    expect(stillOpen.json().status).toBe("actionable");
  });

  it("leaves children untouched when completing with leave_open", async () => {
    const parent = await createTask({ title: "Elternaufgabe 2", status: "actionable" });
    const childRes = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${parent.id}/children`,
      payload: { title: "Kind bleibt offen", status: "actionable" },
    });
    const child = childRes.json();

    const completeRes = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${parent.id}/complete`,
      payload: { descendantsPolicy: "leave_open" },
    });
    expect(completeRes.json().status).toBe("done");

    const childReloaded = await ctx.app.inject({ method: "GET", url: `/api/tasks/${child.id}` });
    expect(childReloaded.json().status).toBe("actionable");
  });

  it("cascades completion to children with complete_children", async () => {
    const parent = await createTask({ title: "Elternaufgabe 3", status: "actionable" });
    const childRes = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${parent.id}/children`,
      payload: { title: "Kind wird erledigt", status: "actionable" },
    });
    const child = childRes.json();

    await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${parent.id}/complete`,
      payload: { descendantsPolicy: "complete_children" },
    });

    const childReloaded = await ctx.app.inject({ method: "GET", url: `/api/tasks/${child.id}` });
    expect(childReloaded.json().status).toBe("done");
    expect(childReloaded.json().completedAt).not.toBeNull();
  });

  it("cascades cancellation to children with cancel_children, otherwise requires a policy", async () => {
    const parent = await createTask({ title: "Elternaufgabe 4", status: "actionable" });
    const childRes = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${parent.id}/children`,
      payload: { title: "Kind", status: "actionable" },
    });
    const child = childRes.json();

    const rejected = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${parent.id}/cancel`,
    });
    expect(rejected.statusCode).toBe(409);

    await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${parent.id}/cancel`,
      payload: { descendantsPolicy: "cancel_children" },
    });

    const childReloaded = await ctx.app.inject({ method: "GET", url: `/api/tasks/${child.id}` });
    expect(childReloaded.json().status).toBe("cancelled");
  });

  it("reopens a completed task back to actionable when it was already clarified", async () => {
    const task = await createTask({
      title: "Wird wiedereröffnet",
      status: "actionable",
      context: "Büro",
    });
    await ctx.app.inject({ method: "POST", url: `/api/tasks/${task.id}/complete` });
    const reopenRes = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/reopen`,
    });
    expect(reopenRes.json().status).toBe("actionable");
    expect(reopenRes.json().completedAt).toBeNull();
  });

  it("reopens a never-clarified task back to inbox", async () => {
    const task = await createTask({ title: "Ganz neu" });
    await ctx.app.inject({ method: "POST", url: `/api/tasks/${task.id}/cancel` });
    const reopenRes = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/reopen`,
    });
    expect(reopenRes.json().status).toBe("inbox");
    expect(reopenRes.json().cancelledAt).toBeNull();
  });

  it("creates a child task via the dedicated children endpoint", async () => {
    const parent = await createTask({ title: "Elternaufgabe 5" });
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${parent.id}/children`,
      payload: { title: "Kindaufgabe" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().parentTaskId).toBe(parent.id);
  });
});
