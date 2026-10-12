import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

describe("atomic task step batches", () => {
  let ctx: TestContext;

  beforeEach(() => { ctx = createTestContext(); });
  afterEach(async () => { await closeTestContext(ctx); });

  async function createTask(payload: Record<string, unknown>) {
    const response = await ctx.app.inject({ method: "POST", url: "/api/tasks", payload });
    expect(response.statusCode).toBe(201);
    return response.json();
  }

  async function createProject(payload: Record<string, unknown>) {
    const response = await ctx.app.inject({ method: "POST", url: "/api/projects", payload });
    expect(response.statusCode).toBe(201);
    return response.json();
  }

  it("classifies an Inbox parent together with its first child batch", async () => {
    const parent = await createTask({ title: "Kita-Formular" });
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${parent.id}/children/batch`,
      payload: {
        expectedRevision: parent.revision,
        expectedProjectRevisions: [],
        steps: [{ title: "Formular ausfüllen" }, { title: "Im Sekretariat abgeben" }],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().tasks).toHaveLength(2);
    expect(response.json().tasks.map((task: { title: string }) => task.title)).toEqual([
      "Formular ausfüllen",
      "Im Sekretariat abgeben",
    ]);
    expect((await ctx.app.inject({ method: "GET", url: `/api/tasks/${parent.id}` })).json())
      .toMatchObject({ status: "actionable", needsClarification: false });
  });

  it("leaves a Someday parent parked when the batch has no execution commitment", async () => {
    const parent = await createTask({ title: "Irgendwann Dachboden", status: "someday" });
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${parent.id}/children/batch`,
      payload: { expectedRevision: parent.revision, expectedProjectRevisions: [], steps: [{ title: "Kisten sichten" }] },
    });

    expect(response.statusCode).toBe(201);
    const updatedParent = (await ctx.app.inject({ method: "GET", url: `/api/tasks/${parent.id}` })).json();
    expect(updatedParent.status).toBe("someday");
    expect(updatedParent.children).toMatchObject([{ title: "Kisten sichten", status: "someday" }]);
    const agenda = await ctx.app.inject({ method: "GET", url: "/api/agenda/today?scope=all&date=2026-10-12" });
    expect(JSON.stringify(agenda.json())).not.toContain("Irgendwann Dachboden");
    expect(JSON.stringify(agenda.json())).not.toContain("Kisten sichten");

    const committed = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${parent.id}/children/batch`,
      payload: {
        expectedRevision: response.json().parent.revision,
        expectedProjectRevisions: [],
        steps: [{ title: "Kisten sortieren", scheduledDate: "2027-01-15" }],
      },
    });
    expect(committed.statusCode).toBe(201);
    expect(committed.json().parent).toMatchObject({ status: "someday" });
    expect(committed.json().tasks).toMatchObject([{ status: "actionable", scheduledDate: "2027-01-15" }]);
    const futureAgenda = await ctx.app.inject({ method: "GET", url: "/api/agenda/today?scope=all&date=2026-10-12" });
    expect(JSON.stringify(futureAgenda.json())).not.toContain("Irgendwann Dachboden");
    expect(JSON.stringify(futureAgenda.json())).not.toContain("Kisten sortieren");
  });

  it("classifies the first Inbox action child through every canonical create entry point", async () => {
    const viaGeneralCreate = await createTask({ title: "Posteingang A" });
    const viaGeneralChildCreate = await ctx.app.inject({
      method: "POST", url: "/api/tasks", payload: { title: "Erster Schritt A", parentTaskId: viaGeneralCreate.id },
    });
    expect(viaGeneralChildCreate.statusCode).toBe(201);
    expect((await ctx.app.inject({ method: "GET", url: `/api/tasks/${viaGeneralCreate.id}` })).json())
      .toMatchObject({ status: "actionable", needsClarification: false });

    const viaChildRoute = await createTask({ title: "Posteingang B" });
    const childRoute = await ctx.app.inject({
      method: "POST", url: `/api/tasks/${viaChildRoute.id}/children`, payload: { title: "Erster Schritt B" },
    });
    expect(childRoute.statusCode).toBe(201);
    expect((await ctx.app.inject({ method: "GET", url: `/api/tasks/${viaChildRoute.id}` })).json())
      .toMatchObject({ status: "actionable", needsClarification: false });

    const viaBatch = await createTask({ title: "Posteingang C" });
    const batch = await ctx.app.inject({
      method: "POST", url: `/api/tasks/${viaBatch.id}/children/batch`,
      payload: { expectedRevision: viaBatch.revision, expectedProjectRevisions: [], steps: [{ title: "Erster Schritt C" }] },
    });
    expect(batch.statusCode).toBe(201);
    expect(batch.json().parent).toMatchObject({ status: "actionable", needsClarification: false });
  });

  it("rolls back first-child classification when the child is invalid", async () => {
    const parent = await createTask({ title: "Unvollständige Inbox-Aufgabe" });
    const response = await ctx.app.inject({
      method: "POST", url: "/api/tasks", payload: {
        title: "Ungültiges Kind", parentTaskId: parent.id, contextIds: [99999],
      },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("physical_context_not_found");
    expect((await ctx.app.inject({ method: "GET", url: `/api/tasks/${parent.id}` })).json())
      .toMatchObject({ status: "captured", needsClarification: true, children: [] });
  });

  it("retries a dated successor with explicit project activation decisions exactly once", async () => {
    const member = (await ctx.app.inject({ method: "POST", url: "/api/members", payload: { name: "Mira" } })).json();
    const project = await createProject({ title: "Sommerfest", status: "backlog" });
    const predecessor = await createTask({ title: "Termin abstimmen", projectId: project.id, status: "actionable" });
    const payload = { title: "Angebot vergleichen", scheduledDate: "2027-03-12", status: "actionable" };

    const blocked = await ctx.app.inject({ method: "POST", url: `/api/tasks/${predecessor.id}/successors`, payload });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe("project_commitment_resolution_required");
    expect((await ctx.app.inject({ method: "GET", url: `/api/projects/${project.id}` })).json().tasks)
      .not.toContainEqual(expect.objectContaining({ title: "Angebot vergleichen" }));

    const requirements = blocked.json().error.details;
    const activationResolution = {
      expectedProjects: requirements.expectedProjects,
      drivers: requirements.projects
        .filter((entry: { required: string[] }) => entry.required.includes("driver"))
        .map((entry: { projectId: number }) => ({ projectId: entry.projectId, ownerMemberId: member.id })),
      ...(requirements.projects.some((entry: { required: string[] }) => entry.required.includes("progressPath"))
        ? { nextActionTitle: "Termin abstimmen" }
        : {}),
    };
    const applied = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${predecessor.id}/successors`,
      payload: { ...payload, activationResolution },
    });
    expect(applied.statusCode, applied.body).toBe(201);
    expect(applied.json()).toMatchObject({ title: "Angebot vergleichen", scheduledDate: "2027-03-12" });

    const updatedProject = (await ctx.app.inject({ method: "GET", url: `/api/projects/${project.id}` })).json();
    expect(updatedProject.status).toBe("active");
    expect(updatedProject.tasks.filter((task: { title: string }) => task.title === "Angebot vergleichen")).toHaveLength(1);
  });

  it("rolls back every child when dated work needs decisions, then applies one complete retry", async () => {
    const memberResponse = await ctx.app.inject({ method: "POST", url: "/api/members", payload: { name: "Mira" } });
    const member = memberResponse.json();
    const project = await createProject({ title: "Dachfenster", status: "backlog" });
    const parent = await createTask({ title: "Dachfenster planen", projectId: project.id, status: "actionable" });
    const initialProject = await ctx.app.inject({ method: "GET", url: `/api/projects/${project.id}` });
    const chain = [{ projectId: project.id, revision: initialProject.json().revision }];
    const payload = {
      expectedRevision: parent.revision,
      expectedProjectRevisions: chain,
      steps: [
        { title: "Maße prüfen", scheduledDate: "2027-01-15" },
        { title: "Angebot vergleichen" },
      ],
    };

    const needsDecisions = await ctx.app.inject({
      method: "POST", url: `/api/tasks/${parent.id}/children/batch`, payload,
    });
    expect(needsDecisions.statusCode).toBe(409);
    expect(needsDecisions.json().error.code).toBe("project_commitment_resolution_required");
    expect((await ctx.app.inject({ method: "GET", url: `/api/tasks/${parent.id}` })).json().children).toHaveLength(0);
    expect((await ctx.app.inject({ method: "GET", url: `/api/projects/${project.id}` })).json().status).toBe("backlog");

    const requirements = needsDecisions.json().error.details;
    const resolution = {
      expectedProjects: requirements.expectedProjects,
      drivers: requirements.projects
        .filter((entry: { required: string[] }) => entry.required.includes("driver"))
        .map((entry: { projectId: number }) => ({ projectId: entry.projectId, ownerMemberId: member.id })),
      ...(requirements.projects.some((entry: { required: string[] }) => entry.required.includes("progressPath"))
        ? { nextActionTitle: "Maße prüfen" }
        : {}),
    };
    const retry = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${parent.id}/children/batch`,
      payload: { ...payload, activationResolution: resolution },
    });
    expect(retry.statusCode).toBe(201);
    expect(retry.json().tasks).toHaveLength(2);
    expect((await ctx.app.inject({ method: "GET", url: `/api/projects/${project.id}` })).json().status).toBe("active");
  });

  it("rejects an invalid child in the submitted batch without creating earlier entries", async () => {
    const parent = await createTask({ title: "Projekt" });
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${parent.id}/children/batch`,
      payload: {
        expectedRevision: parent.revision,
        expectedProjectRevisions: [],
        steps: [{ title: "Gültig" }, { title: "Ungültiges Datum", dueDate: "morgen" }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect((await ctx.app.inject({ method: "GET", url: `/api/tasks/${parent.id}` })).json().children).toHaveLength(0);
    expect((await ctx.app.inject({ method: "GET", url: `/api/tasks/${parent.id}` })).json().status).toBe("captured");
  });

  it("rejects stale parent and project-chain revisions before writing", async () => {
    const ancestor = await createProject({ title: "Umbau" });
    const destination = await createProject({ title: "Bad renovieren", parentId: ancestor.id });
    const parent = await createTask({ title: "Wand streichen", projectId: destination.id, status: "actionable" });
    const projectBefore = await ctx.app.inject({ method: "GET", url: `/api/projects/${destination.id}` });
    const ancestorBefore = projectBefore.json().ancestors.find((entry: { id: number }) => entry.id === ancestor.id);
    await ctx.app.inject({ method: "PATCH", url: `/api/projects/${ancestor.id}`, payload: { notes: "Aktualisiert" } });

    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${parent.id}/children/batch`,
      payload: {
        expectedRevision: parent.revision,
        expectedProjectRevisions: [
          { projectId: ancestor.id, revision: ancestorBefore.revision },
          { projectId: destination.id, revision: projectBefore.json().revision },
        ],
        steps: [{ title: "Kanten abkleben" }],
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("stale_write_conflict");
    expect((await ctx.app.inject({ method: "GET", url: `/api/tasks/${parent.id}` })).json().children).toHaveLength(0);
  });

  it("rejects a changed task parent and creates no children", async () => {
    const parent = await createTask({ title: "Angebot planen", status: "actionable" });
    await ctx.app.inject({ method: "PATCH", url: `/api/tasks/${parent.id}`, payload: { title: "Angebot planen lassen" } });
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${parent.id}/children/batch`,
      payload: {
        expectedRevision: parent.revision,
        expectedProjectRevisions: [],
        steps: [{ title: "Anbieter anrufen" }],
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("stale_write_conflict");
    expect((await ctx.app.inject({ method: "GET", url: `/api/tasks/${parent.id}` })).json()).toMatchObject({
      title: "Angebot planen lassen", children: [],
    });
  });

  it("uses the existing task-to-project conversion atomically when requested", async () => {
    const capture = await createTask({ title: "Kita-Platz" });
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${capture.id}/children/batch`,
      payload: {
        expectedRevision: capture.revision,
        expectedProjectRevisions: [],
        convertParentToProject: true,
        steps: [{ title: "Unterlagen zusammenstellen" }],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().convertedProject).toMatchObject({ id: capture.id, title: "Kita-Platz", status: "backlog" });
    const project = await ctx.app.inject({ method: "GET", url: `/api/projects/${capture.id}` });
    expect(project.statusCode).toBe(200);
    expect(project.json().tasks.map((task: { title: string }) => task.title)).toEqual(["Unterlagen zusammenstellen"]);
  });

  it("preserves an external wait when converting a task before adding batch steps", async () => {
    const capture = await createTask({ title: "Versicherung anrufen", status: "actionable" });
    const withWait = await ctx.app.inject({ method: "PATCH", url: `/api/tasks/${capture.id}`, payload: { externalWait: { waitingFor: "Versicherung" } } });
    expect(withWait.statusCode).toBe(200);
    ctx.handle.sqlite.prepare("UPDATE work_items SET status = 'captured' WHERE id = ?").run(capture.id);
    const current = (await ctx.app.inject({ method: "GET", url: `/api/tasks/${capture.id}` })).json();
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${capture.id}/children/batch`,
      payload: {
        expectedRevision: current.revision,
        expectedProjectRevisions: [],
        convertParentToProject: true,
        steps: [{ title: "Rückruf vorbereiten" }],
      },
    });
    expect(response.statusCode).toBe(201);
    const project = (await ctx.app.inject({ method: "GET", url: `/api/projects/${capture.id}` })).json();
    expect(project.tasks.map((task: { title: string }) => task.title)).toEqual([
      capture.title,
      "Rückruf vorbereiten",
    ]);
    expect(project.tasks[0]).toMatchObject({ status: "actionable", externalWait: { waitingFor: "Versicherung" } });
  });
});
