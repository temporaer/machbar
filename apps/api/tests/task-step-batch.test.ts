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
    expect((await ctx.app.inject({ method: "GET", url: `/api/tasks/${parent.id}` })).json().status).toBe("someday");
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

  it("keeps the captured task and creates no children when its existing relations block conversion", async () => {
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
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("role_conversion_invalid");
    expect((await ctx.app.inject({ method: "GET", url: `/api/tasks/${capture.id}` })).json()).toMatchObject({
      status: "captured", kind: "action", children: [],
    });
  });
});
