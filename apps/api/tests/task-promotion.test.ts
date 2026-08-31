import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../src/db/schema.js";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

describe("captured task promotion", () => {
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

  it("promotes a captured tree to an active project without a wrapper task", async () => {
    const member = (
      await post("/api/members", { name: "Mira" })
    ).json();
    const tag = (
      await post("/api/tags", { name: "zuhause", kind: "context" })
    ).json();
    const root = (
      await post("/api/tasks", {
        title: "Kinderzimmer renovieren",
        notes: "Farbe und Möbel abstimmen",
        status: "actionable",
        ownerMemberId: member.id,
        ownerInheritanceMode: "explicit",
        dueDate: "2026-10-10",
        scheduledDate: "2026-09-15",
        tagIds: [tag.id],
      })
    ).json();
    const firstChild = (
      await post(`/api/tasks/${root.id}/children`, {
        title: "Farbe aussuchen",
      })
    ).json();
    const secondChild = (
      await post(`/api/tasks/${root.id}/children`, {
        title: "Wand streichen",
      })
    ).json();
    const grandchild = (
      await post(`/api/tasks/${secondChild.id}/children`, {
        title: "Abkleben",
      })
    ).json();
    await ctx.app.inject({
      method: "PATCH",
      url: `/api/tasks/${root.id}`,
      payload: { status: "captured" },
    });

    const promoted = await post(`/api/tasks/${root.id}/promote-to-project`, {
      status: "active",
      title: "Kinderzimmer fertig renovieren",
      notes: "Aktualisierte Notizen",
      expectedRevision: 2,
    });

    expect(promoted.statusCode).toBe(201);
    expect(promoted.json()).toMatchObject({
      title: "Kinderzimmer fertig renovieren",
      notes: "Aktualisierte Notizen",
      status: "active",
      ownerMemberId: member.id,
      dueDate: "2026-10-10",
      scheduledDate: "2026-09-15",
      tags: [expect.objectContaining({ id: tag.id })],
    });

    const project = (
      await ctx.app.inject({
        method: "GET",
        url: `/api/projects/${promoted.json().id}`,
      })
    ).json();
    expect(project.tasks.map((task: { id: number }) => task.id)).toEqual([
      firstChild.id,
      secondChild.id,
    ]);
    expect(project.tasks[1]).toMatchObject({
      id: secondChild.id,
      parentTaskId: null,
      children: [expect.objectContaining({ id: grandchild.id })],
    });
    expect(
      await ctx.app.inject({ method: "GET", url: `/api/tasks/${root.id}` }),
    ).toMatchObject({ statusCode: 404 });

    const activity = ctx.handle.db.select().from(schema.activityEvents).all();
    expect(activity.at(-1)).toMatchObject({
      kind: "project_created",
      projectId: promoted.json().id,
      entityTitle: "Kinderzimmer fertig renovieren",
      metadata: expect.objectContaining({
        changedFields: ["promotedFromCapture"],
        relatedTaskIds: [root.id],
        affectedCount: 3,
      }),
    });
  });

  it("promotes a capture to the project backlog", async () => {
    const root = (await post("/api/tasks", { title: "Vielleicht umziehen" })).json();
    const promoted = await post(`/api/tasks/${root.id}/promote-to-project`, {
      status: "backlog",
      expectedRevision: root.revision,
    });

    expect(promoted.statusCode).toBe(201);
    expect(promoted.json()).toMatchObject({
      title: "Vielleicht umziehen",
      status: "backlog",
    });

    const projects = (
      await ctx.app.inject({ method: "GET", url: "/api/projects" })
    ).json();
    expect(projects).toContainEqual(
      expect.objectContaining({ id: promoted.json().id, status: "backlog" }),
    );
  });

  it("requires an explicit owner when promoting a capture to an active project", async () => {
    const root = (await post("/api/tasks", { title: "Keller aufräumen" })).json();
    const activePromotion = await post(
      `/api/tasks/${root.id}/promote-to-project`,
      {
        status: "active",
        expectedRevision: root.revision,
      },
    );

    expect(activePromotion.statusCode).toBe(409);
    expect(activePromotion.json().error.code).toBe("project_driver_required");
    expect(
      await ctx.app.inject({ method: "GET", url: `/api/tasks/${root.id}` }),
    ).toMatchObject({ statusCode: 200 });
  });

  it("rejects non-root, classified, and task-only promotion states", async () => {
    const capturedWithReminder = await post("/api/tasks", {
      title: "Mit Erinnerung",
      reminderAt: "2030-01-01T09:00:00.000Z",
    });
    expect(capturedWithReminder.statusCode).toBe(409);
    expect(capturedWithReminder.json().error.code).toBe(
      "task_promotion_invalid",
    );

    const actionable = (
      await post("/api/tasks", { title: "Schon Aufgabe", status: "actionable" })
    ).json();
    const classified = await post(
      `/api/tasks/${actionable.id}/promote-to-project`,
      { status: "active" },
    );
    expect(classified.statusCode).toBe(409);
    expect(classified.json().error.code).toBe("task_promotion_invalid");

    const captured = (await post("/api/tasks", { title: "Noch offen" })).json();
    const recurrence = await ctx.app.inject({
      method: "PATCH",
      url: `/api/tasks/${captured.id}`,
      payload: { repeatAfterDays: 7 },
    });
    expect(recurrence.statusCode).toBe(409);
    expect(recurrence.json().error.code).toBe("task_promotion_invalid");

    const blocker = (
      await post("/api/tasks", { title: "Voraussetzung", status: "actionable" })
    ).json();
    const dependency = await post(`/api/tasks/${captured.id}/dependencies`, {
      dependsOnTaskId: blocker.id,
    });
    expect(dependency.statusCode).toBe(201);
    const dependencyPromotion = await post(
      `/api/tasks/${captured.id}/promote-to-project`,
      { status: "backlog" },
    );
    expect(dependencyPromotion.statusCode).toBe(409);
    expect(dependencyPromotion.json().error.code).toBe(
      "task_promotion_invalid",
    );

    const child = await post(`/api/tasks/${captured.id}/children`, {
      title: "Unzulässiger Schritt",
    });
    expect(child.statusCode).toBe(409);
    expect(child.json().error.code).toBe("task_promotion_invalid");
  });
});
