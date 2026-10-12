import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema.js";
import { createProject as createProjectMutation } from "../src/domain/storyCrud.js";
import { createTask } from "../src/domain/taskCrud.js";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

describe("capture query views", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await closeTestContext(ctx);
  });

  function createProject(
    ...args: Parameters<typeof createProjectMutation>
  ): ReturnType<typeof createProjectMutation> {
    const [db, input, context] = args;
    const requestedActive = input.status === "active";
    const project = createProjectMutation(
      db,
      requestedActive ? { ...input, status: "backlog" } : input,
      context,
    );
    if (!requestedActive) return project;
    db.update(schema.workItems)
      .set({ status: "active" })
      .where(eq(schema.workItems.id, project.id))
      .run();
    return { ...project, status: "active" };
  }

  it("/api/inbox selects captured tasks from active projects", async () => {
    const project = createProject(ctx.handle.db, {
      title: "Capture-Projekt",
      status: "active",
    });
    const inProject = createTask(ctx.handle.db, {
      projectId: project.id,
      title: "Im Projekt erfasst",
      status: "captured",
    });
    const topLevel = createTask(ctx.handle.db, {
      title: "Geklärter Eingangskandidat",
      status: "actionable",
      needsClarification: false,
    });

    const response = await ctx.app.inject({ method: "GET", url: "/api/inbox" });
    expect(response.statusCode).toBe(200);
    const ids = response.json().map((task: { id: number }) => task.id);
    expect(ids).toContain(inProject.id);
    expect(ids).not.toContain(topLevel.id);
  });

  it("keeps a re-clarification independent of active commitments and honors an explicit later revisit", async () => {
    const scheduledDate = new Date().toISOString().slice(0, 10);
    const task = createTask(ctx.handle.db, {
      title: "Aktive Aufgabe erneut klären",
      status: "actionable",
      scheduledDate,
    });
    const requested = await ctx.app.inject({
      method: "PATCH",
      url: `/api/tasks/${task.id}`,
      payload: { expectedRevision: task.revision, needsClarification: true },
    });
    expect(requested.statusCode).toBe(200);
    expect(requested.json()).toMatchObject({
      status: "actionable",
      scheduledDate,
      needsClarification: true,
    });
    const inbox = await ctx.app.inject({ method: "GET", url: "/api/inbox" });
    expect(inbox.json().map((item: { id: number }) => item.id)).toContain(task.id);
    const agenda = await ctx.app.inject({ method: "GET", url: `/api/agenda/today?date=${scheduledDate}` });
    expect(JSON.stringify(agenda.json())).toContain("Aktive Aufgabe erneut klären");

    const deferred = await ctx.app.inject({
      method: "PATCH",
      url: `/api/tasks/${task.id}`,
      payload: {
        expectedRevision: requested.json().revision,
        revisitAt: "2999-01-01T09:00:00.000Z",
      },
    });
    expect(deferred.statusCode).toBe(200);
    expect(deferred.json()).toMatchObject({ status: "actionable", scheduledDate: null, needsClarification: true });
    const deferredInbox = await ctx.app.inject({ method: "GET", url: "/api/inbox" });
    expect(deferredInbox.json().map((item: { id: number }) => item.id)).not.toContain(task.id);
  });

  it("lists and toggles discussion nominations for both work-item roles without changing lifecycle", async () => {
    const task = createTask(ctx.handle.db, { title: "Task to discuss", status: "actionable" });
    const project = createProject(ctx.handle.db, { title: "Project to discuss", status: "backlog" });

    for (const [role, item] of [["task", task], ["project", project]] as const) {
      const path = role === "task" ? `/api/tasks/${item.id}` : `/api/projects/${item.id}`;
      const response = await ctx.app.inject({
        method: "PATCH",
        url: path,
        payload: { expectedRevision: item.revision, discussionRequested: true },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: item.status, discussionRequested: true });
    }

    const listed = await ctx.app.inject({ method: "GET", url: "/api/discussion" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().tasks.map((item: { id: number }) => item.id)).toContain(task.id);
    expect(listed.json().projects.map((item: { id: number }) => item.id)).toContain(project.id);

    const cleared = await ctx.app.inject({
      method: "PATCH",
      url: `/api/tasks/${task.id}`,
      payload: { expectedRevision: listed.json().tasks[0].revision, discussionRequested: false },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({ status: "actionable", discussionRequested: false });
  });

  it("does not let an unauthenticated forged member id reveal private discussion items", async () => {
    const owner = ctx.handle.db
      .insert(schema.members)
      .values({ name: "Privater Besitzer", color: "#123456" })
      .returning()
      .get();
    const privateTask = createTask(ctx.handle.db, {
      title: "Private Besprechung",
      status: "actionable",
      scope: "work",
      ownerMemberId: owner.id,
    });
    ctx.handle.db.update(schema.workItems)
      .set({ discussionRequested: true })
      .where(eq(schema.workItems.id, privateTask.id))
      .run();
    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/discussion?memberId=${owner.id}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().tasks.map((item: { id: number }) => item.id)).not.toContain(privateTask.id);
  });

  it("/api/inbox returns remaining captured items after child creation classifies their parents", async () => {
    const project = createProject(ctx.handle.db, {
      title: "Baum-Projekt",
      status: "active",
    });
    const capturedParent = createTask(ctx.handle.db, {
      projectId: project.id,
      title: "Erfasster Elternteil",
      needsClarification: true,
    });
    const capturedChild = createTask(ctx.handle.db, {
      parentTaskId: capturedParent.id,
      title: "Erfasstes Kind",
      needsClarification: true,
    });
    const clarifiedChild = createTask(ctx.handle.db, {
      parentTaskId: capturedParent.id,
      title: "Geklärtes Kind",
      needsClarification: false,
    });
    const capturedGrandchild = createTask(ctx.handle.db, {
      parentTaskId: clarifiedChild.id,
      title: "Erfasster Enkel",
      needsClarification: true,
    });

    const response = await ctx.app.inject({ method: "GET", url: "/api/inbox" });
    expect(response.statusCode).toBe(200);
    const tasks = response.json() as Array<{
      id: number;
      children: Array<{ id: number }>;
    }>;

    expect(tasks.map((task) => task.id)).toEqual(
      expect.arrayContaining([capturedChild.id, capturedGrandchild.id]),
    );
    expect(tasks.map((task) => task.id)).not.toContain(capturedParent.id);
    expect(tasks.find((task) => task.id === capturedChild.id)?.children).toEqual([]);
    expect(
      tasks.flatMap((task) => task.children).some((task) => task.id === clarifiedChild.id),
    ).toBe(false);
  });

  it("keeps a re-clarified active action as a valid project progress path", async () => {
    const project = createProject(ctx.handle.db, {
      title: "Nur Capture",
      status: "active",
    });
    createTask(ctx.handle.db, {
      projectId: project.id,
      title: "Erst klären",
      status: "actionable",
      needsClarification: true,
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/review",
    });
    expect(response.statusCode).toBe(200);
    expect(
      (response.json() as Array<{ entityId: number; reason: string }>).some(
        (row) => row.entityId === project.id && row.reason === "no_viable_progress_path",
      ),
    ).toBe(false);
  });

  it("does not use captured unassigned work to classify a mixed project as unassigned", async () => {
    const owner = ctx.handle.db
      .insert(schema.members)
      .values({ name: "Zuständige", color: "#123456" })
      .returning()
      .get();
    const project = createProject(ctx.handle.db, {
      title: "Gemischt",
      status: "active",
      ownerMemberId: owner.id,
    });
    createTask(ctx.handle.db, {
      projectId: project.id,
      title: "Erfasst und gemeinsam",
      status: "actionable",
      needsClarification: true,
      ownerInheritanceMode: "none",
    });
    createTask(ctx.handle.db, {
      projectId: project.id,
      title: "Geklärt und zuständig",
      status: "actionable",
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/review",
    });
    expect(
      (response.json() as Array<{ projectId: number; reason: string }>).some(
        (row) =>
          row.projectId === project.id &&
          row.reason === "no_viable_progress_path",
      ),
    ).toBe(false);
  });
});
