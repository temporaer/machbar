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

  it("creates an ordered project task sequence atomically", async () => {
    const projectRes = await ctx.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { title: "Heizung reparieren" },
    });
    const projectId = projectRes.json().id;

    const sequenceRes = await ctx.app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/task-sequence`,
      payload: {
        titles: [
          "Angebot einholen",
          "Termin vereinbaren",
          "Rechnung bezahlen",
        ],
      },
    });

    expect(sequenceRes.statusCode).toBe(201);
    const tasks = sequenceRes.json();
    expect(tasks.map((task: { title: string }) => task.title)).toEqual([
      "Angebot einholen",
      "Termin vereinbaren",
      "Rechnung bezahlen",
    ]);
    expect(tasks[0].dependencies).toEqual([]);
    expect(tasks[1].dependencies).toEqual([
      expect.objectContaining({ dependsOnTaskId: tasks[0].id }),
    ]);
    expect(tasks[2].dependencies).toEqual([
      expect.objectContaining({ dependsOnTaskId: tasks[1].id }),
    ]);
    expect(
      tasks.every(
        (task: { status: string; needsClarification: boolean }) =>
          task.status === "actionable" && task.needsClarification === false,
      ),
    ).toBe(true);
  });

  it("does not leave a partial task sequence when validation fails", async () => {
    const projectRes = await ctx.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { title: "Leeres Projekt" },
    });
    const projectId = projectRes.json().id;

    const sequenceRes = await ctx.app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/task-sequence`,
      payload: { titles: ["Erster Schritt", ""] },
    });
    expect(sequenceRes.statusCode).toBe(400);

    const detailRes = await ctx.app.inject({
      method: "GET",
      url: `/api/projects/${projectId}`,
    });
    expect(detailRes.json().tasks).toEqual([]);
  });

  it("creates a successor at the same outline level with an atomic dependency", async () => {
    const projectRes = await ctx.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { title: "Steuerunterlagen" },
    });
    const root = await createTask({
      projectId: projectRes.json().id,
      title: "Rechnungen sammeln",
    });
    const childRes = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${root.id}/children`,
      payload: { title: "Handwerkerrechnung suchen" },
    });
    const child = childRes.json();
    await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${root.id}/children`,
      payload: { title: "Späterer bestehender Schritt" },
    });

    const successorRes = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${child.id}/successors`,
      payload: { title: "Rechnung archivieren" },
    });

    expect(successorRes.statusCode).toBe(201);
    expect(successorRes.json()).toMatchObject({
      title: "Rechnung archivieren",
      projectId: projectRes.json().id,
      parentTaskId: root.id,
      status: "actionable",
      needsClarification: false,
      dependencies: [
        expect.objectContaining({ dependsOnTaskId: child.id }),
      ],
    });

    const projectDetail = await ctx.app.inject({
      method: "GET",
      url: `/api/projects/${projectRes.json().id}`,
    });
    expect(
      projectDetail
        .json()
        .tasks[0].children.map((task: { title: string }) => task.title),
    ).toEqual([
      "Handwerkerrechnung suchen",
      "Rechnung archivieren",
      "Späterer bestehender Schritt",
    ]);

    await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${child.id}/complete`,
      payload: {},
    });
    const unlockedRes = await ctx.app.inject({
      method: "GET",
      url: `/api/tasks/${successorRes.json().id}`,
    });
    expect(unlockedRes.json().blocked).toBe(false);
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

  it("keeps terminal timestamps coherent for atomic status patches", async () => {
    const task = await createTask({ title: "Statuswechsel", status: "actionable" });

    const doneRes = await ctx.app.inject({
      method: "PATCH",
      url: `/api/tasks/${task.id}`,
      payload: { status: "done" },
    });

    expect(doneRes.json().completedAt).not.toBeNull();
    expect(doneRes.json().cancelledAt).toBeNull();

    const cancelledRes = await ctx.app.inject({
      method: "PATCH",
      url: `/api/tasks/${task.id}`,
      payload: { status: "cancelled" },
    });
    expect(cancelledRes.json().completedAt).toBeNull();
    expect(cancelledRes.json().cancelledAt).not.toBeNull();

    const waitingRes = await ctx.app.inject({
      method: "PATCH",
      url: `/api/tasks/${task.id}`,
      payload: { status: "waiting" },
    });
    expect(waitingRes.json().completedAt).toBeNull();
    expect(waitingRes.json().cancelledAt).toBeNull();
  });

  it("provides an explicit atomic endpoint for direct status transitions", async () => {
    const task = await createTask({ title: "Direkter Status", status: "done" });
    const transitionRes = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/status`,
      payload: { status: "waiting" },
    });

    expect(transitionRes.statusCode).toBe(200);
    expect(transitionRes.json()).toMatchObject({
      status: "waiting",
      completedAt: null,
      cancelledAt: null,
      needsClarification: false,
    });
  });

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
