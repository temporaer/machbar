import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

describe("task.additionalNextAction opt-in", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await closeTestContext(ctx);
  });

  async function createTask(payload: Record<string, unknown>) {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { status: "actionable", ...payload },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  async function createProject(payload: Record<string, unknown>) {
    const requestedActive = payload.status === "active";
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: requestedActive ? { ...payload, status: "backlog" } : payload,
    });
    expect(res.statusCode).toBe(201);
    const project = res.json();
    if (requestedActive) {
      ctx.handle.sqlite
        .prepare("UPDATE work_items SET status = 'active' WHERE id = ?")
        .run(project.id);
    }
    return project;
  }

  async function patchTask(id: number, payload: Record<string, unknown>) {
    const res = await ctx.app.inject({
      method: "PATCH",
      url: `/api/tasks/${id}`,
      payload,
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  async function getTask(id: number) {
    const res = await ctx.app.inject({ method: "GET", url: `/api/tasks/${id}` });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  async function addExternalWait(taskId: number, revisitDate?: string) {
    const res = await ctx.app.inject({
      method: "PUT",
      url: `/api/tasks/${taskId}/external-wait`,
      payload: { waitingFor: "Antwort", revisitDate },
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  async function unscheduledTitles(): Promise<string[]> {
    const res = await ctx.app.inject({ method: "GET", url: "/api/agenda/today" });
    expect(res.statusCode).toBe(200);
    const agenda = res.json();
    return [...agenda.shared, ...agenda.unscheduled].map(
      (t: { title: string }) => t.title,
    );
  }

  it("defaults additionalNextAction to false and does not change canonical single-next-action selection", async () => {
    const project = await createProject({ title: "Projekt A", status: "active" });
    const first = await createTask({
      title: "Erste Aufgabe",
      projectId: project.id,
    });
    const second = await createTask({
      title: "Zweite Aufgabe",
      projectId: project.id,
    });
    expect(first.additionalNextAction).toBe(false);
    expect(second.additionalNextAction).toBe(false);

    const titles = await unscheduledTitles();
    expect(titles).toContain("Erste Aufgabe");
    expect(titles).not.toContain("Zweite Aufgabe");
  });

  it("includes a genuinely eligible task marked additionalNextAction alongside the canonical next action", async () => {
    const project = await createProject({ title: "Projekt B", status: "active" });
    await createTask({ title: "Kanonische Aufgabe", projectId: project.id });
    const second = await createTask({
      title: "Zusätzliche Aufgabe",
      projectId: project.id,
    });

    const updated = await patchTask(second.id, { additionalNextAction: true });
    expect(updated.additionalNextAction).toBe(true);

    const titles = await unscheduledTitles();
    expect(titles).toContain("Kanonische Aufgabe");
    expect(titles).toContain("Zusätzliche Aufgabe");
  });

  it("does not surface a marked task that is blocked by an external wait", async () => {
    const project = await createProject({ title: "Projekt C", status: "active" });
    await createTask({ title: "Kanonische Aufgabe C", projectId: project.id });
    const second = await createTask({
      title: "Wartende Aufgabe",
      projectId: project.id,
    });
    await patchTask(second.id, { additionalNextAction: true });
    await addExternalWait(second.id);

    const titles = await unscheduledTitles();
    expect(titles).toContain("Kanonische Aufgabe C");
    expect(titles).not.toContain("Wartende Aufgabe");
  });

  it("does not surface a marked task that is done", async () => {
    const project = await createProject({ title: "Projekt D", status: "active" });
    await createTask({ title: "Kanonische Aufgabe D", projectId: project.id });
    const second = await createTask({
      title: "Erledigte Aufgabe",
      projectId: project.id,
    });
    await patchTask(second.id, { additionalNextAction: true });
    const completeRes = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${second.id}/complete`,
      payload: {},
    });
    expect(completeRes.statusCode).toBe(200);

    const titles = await unscheduledTitles();
    expect(titles).toContain("Kanonische Aufgabe D");
    expect(titles).not.toContain("Erledigte Aufgabe");
  });

  it("does not surface a marked task that is cancelled", async () => {
    const project = await createProject({ title: "Projekt E", status: "active" });
    await createTask({ title: "Kanonische Aufgabe E", projectId: project.id });
    const second = await createTask({
      title: "Abgebrochene Aufgabe",
      projectId: project.id,
    });
    await patchTask(second.id, { additionalNextAction: true });
    const cancelRes = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${second.id}/cancel`,
      payload: {},
    });
    expect(cancelRes.statusCode).toBe(200);

    const titles = await unscheduledTitles();
    expect(titles).toContain("Kanonische Aufgabe E");
    expect(titles).not.toContain("Abgebrochene Aufgabe");
  });

  it("does not surface a marked task that is someday (not actionable)", async () => {
    const project = await createProject({ title: "Projekt F", status: "active" });
    await createTask({ title: "Kanonische Aufgabe F", projectId: project.id });
    const second = await createTask({
      title: "Irgendwann-Aufgabe",
      projectId: project.id,
      status: "someday",
    });
    await patchTask(second.id, { additionalNextAction: true });

    const titles = await unscheduledTitles();
    expect(titles).toContain("Kanonische Aufgabe F");
    expect(titles).not.toContain("Irgendwann-Aufgabe");
  });

  it("persists the flag across reorder / blocking-state changes (patch + refetch round-trip)", async () => {
    const project = await createProject({ title: "Projekt G", status: "active" });
    const task = await createTask({ title: "Persistente Aufgabe", projectId: project.id });

    await patchTask(task.id, { additionalNextAction: true });
    expect((await getTask(task.id)).additionalNextAction).toBe(true);

    // Unrelated state changes (blocking, then unblocking) must not reset it.
    await addExternalWait(task.id, "2099-01-01");
    expect((await getTask(task.id)).additionalNextAction).toBe(true);

    const clearWaitRes = await ctx.app.inject({
      method: "DELETE",
      url: `/api/tasks/${task.id}/external-wait`,
    });
    expect(clearWaitRes.statusCode).toBe(200);
    expect((await getTask(task.id)).additionalNextAction).toBe(true);

    // Reorder via the canonical move endpoint.
    const beforeMove = await getTask(task.id);
    const moveRes = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/move`,
      payload: {
        projectId: project.id,
        parentTaskId: null,
        position: 0,
        expectedRevision: beforeMove.revision,
      },
    });
    expect(moveRes.statusCode).toBe(200);
    expect((await getTask(task.id)).additionalNextAction).toBe(true);

    // Explicitly clearing it back to false round-trips too.
    await patchTask(task.id, { additionalNextAction: false });
    expect((await getTask(task.id)).additionalNextAction).toBe(false);
  });

  async function getProject(id: number) {
    const res = await ctx.app.inject({ method: "GET", url: `/api/projects/${id}` });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  it("exposes currently eligible additional next actions on the project detail response", async () => {
    const project = await createProject({ title: "Projekt H", status: "active" });
    const canonical = await createTask({
      title: "Kanonische Aufgabe H",
      projectId: project.id,
    });
    const eligible = await createTask({
      title: "Zusätzliche Aufgabe H",
      projectId: project.id,
    });
    const blocked = await createTask({
      title: "Blockierte Aufgabe H",
      projectId: project.id,
    });
    await patchTask(eligible.id, { additionalNextAction: true });
    await patchTask(blocked.id, { additionalNextAction: true });
    await addExternalWait(blocked.id);

    const detail = await getProject(project.id);
    expect(detail.nextAction.id).toBe(canonical.id);
    expect(detail.additionalNextActions.map((t: { id: number }) => t.id)).toEqual([
      eligible.id,
    ]);

    // Stored intent survives even though the blocked task isn't currently selected.
    expect((await getTask(blocked.id)).additionalNextAction).toBe(true);
  });
});
