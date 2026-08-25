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

  it("creates global captures as actionable and needing clarification", async () => {
    const created = await createTask({ title: "Neue Aufgabe", notes: "Notiz" });
    expect(created.status).toBe("actionable");
    expect(created.needsClarification).toBe(true);

    const updateRes = await ctx.app.inject({
      method: "PATCH",
      url: `/api/tasks/${created.id}`,
      payload: { title: "Geänderte Aufgabe", status: "actionable" },
    });
    expect(updateRes.json().title).toBe("Geänderte Aufgabe");
    expect(updateRes.json().status).toBe("actionable");
    expect(updateRes.json().needsClarification).toBe(false);

    const deleteRes = await ctx.app.inject({
      method: "DELETE",
      url: `/api/tasks/${created.id}`,
    });
    expect(deleteRes.statusCode).toBe(204);

    const getRes = await ctx.app.inject({ method: "GET", url: `/api/tasks/${created.id}` });
    expect(getRes.statusCode).toBe(404);
  });

  it("defaults project and child tasks to clarified actionable tasks", async () => {
    const projectRes = await ctx.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { title: "Projekt" },
    });
    const projectTask = await createTask({
      projectId: projectRes.json().id,
      title: "Projektaufgabe",
    });
    expect(projectTask.status).toBe("actionable");
    expect(projectTask.needsClarification).toBe(false);

    const childRes = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${projectTask.id}/children`,
      payload: { title: "Kindaufgabe" },
    });
    expect(childRes.json().status).toBe("actionable");
    expect(childRes.json().needsClarification).toBe(false);
  });

  it("honors explicit clarification input over creation defaults", async () => {
    const clarifiedCapture = await createTask({
      title: "Schon geklärt",
      needsClarification: false,
    });
    expect(clarifiedCapture.needsClarification).toBe(false);

    const projectRes = await ctx.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { title: "Sammelprojekt" },
    });
    const projectCapture = await createTask({
      projectId: projectRes.json().id,
      title: "Noch zu klären",
      needsClarification: true,
    });
    expect(projectCapture.needsClarification).toBe(true);
  });

  it.each(["actionable", "waiting", "someday", "done", "cancelled"])(
    "clears capture when deliberately transitioning to %s",
    async (status) => {
      const task = await createTask({ title: `Status ${status}` });
      const res = await ctx.app.inject({
        method: "PATCH",
        url: `/api/tasks/${task.id}`,
        payload: { status },
      });
      expect(res.json().status).toBe(status);
      expect(res.json().needsClarification).toBe(false);
    },
  );

  it("does not clear capture for metadata updates or refiling", async () => {
    const task = await createTask({ title: "Ungeklärte Aufgabe" });
    const metadataRes = await ctx.app.inject({
      method: "PATCH",
      url: `/api/tasks/${task.id}`,
      payload: { notes: "Zusätzliche Notiz" },
    });
    expect(metadataRes.json().needsClarification).toBe(true);

    const projectRes = await ctx.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { title: "Neues Projekt" },
    });
    const moveRes = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/move`,
      payload: { projectId: projectRes.json().id },
    });
    expect(moveRes.json().needsClarification).toBe(true);
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
    expect(completeRes.json().needsClarification).toBe(false);

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
    expect(reopenRes.json().needsClarification).toBe(false);
    expect(reopenRes.json().completedAt).toBeNull();
  });

  it("reopens a never-clarified task as clarified actionable", async () => {
    const task = await createTask({ title: "Ganz neu" });
    await ctx.app.inject({ method: "POST", url: `/api/tasks/${task.id}/cancel` });
    const reopenRes = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/reopen`,
    });
    expect(reopenRes.json().status).toBe("actionable");
    expect(reopenRes.json().needsClarification).toBe(false);
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
