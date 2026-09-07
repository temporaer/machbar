import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema.js";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

describe("task <-> story role conversion", () => {
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
      await post("/api/tags", { name: "zuhause", kind: "plain" })
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

    const promoted = await post(`/api/tasks/${root.id}/convert-to-story`, {
      status: "active",
      title: "Kinderzimmer fertig renovieren",
      notes: "Aktualisierte Notizen",
      expectedRevision: 2,
    });

    expect(promoted.statusCode).toBe(201);
    expect(promoted.json()).toMatchObject({
      id: root.id,
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
      kind: "work_item_role_converted",
      entityId: promoted.json().id,
      entityType: "project",
      entityTitle: "Kinderzimmer fertig renovieren",
      metadata: expect.objectContaining({
        changedFields: ["role"],
      }),
    });
  });

  it("promotes a capture to the project backlog", async () => {
    const root = (await post("/api/tasks", { title: "Vielleicht umziehen" })).json();
    const promoted = await post(`/api/tasks/${root.id}/convert-to-story`, {
      status: "backlog",
      expectedRevision: root.revision,
    });

    expect(promoted.statusCode).toBe(201);
    expect(promoted.json()).toMatchObject({
      id: root.id,
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
      `/api/tasks/${root.id}/convert-to-story`,
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

  it("rejects an active promotion with a driver but no progress path atomically", async () => {
    const member = (await post("/api/members", { name: "No path owner" })).json();
    const root = (
      await post("/api/tasks", {
        title: "Project-shaped capture",
        ownerMemberId: member.id,
        ownerInheritanceMode: "explicit",
      })
    ).json();
    const response = await post(
      `/api/tasks/${root.id}/convert-to-story`,
      { status: "active", expectedRevision: root.revision },
    );

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("project_activation_not_ready");
    expect(
      await ctx.app.inject({ method: "GET", url: `/api/tasks/${root.id}` }),
    ).toMatchObject({ statusCode: 200 });
    expect(
      ctx.handle.db
        .select()
        .from(schema.workItems)
        .where(eq(schema.workItems.role, "story"))
        .all(),
    ).toEqual([]);
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
      `/api/tasks/${actionable.id}/convert-to-story`,
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
      `/api/tasks/${captured.id}/convert-to-story`,
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

  it("converts a story back to a task, preserving identity and history, when the story has no children or acceptance criteria", async () => {
    const root = (await post("/api/tasks", { title: "Wieder zur Aufgabe" })).json();
    const promoted = (
      await post(`/api/tasks/${root.id}/convert-to-story`, {
        status: "backlog",
        expectedRevision: root.revision,
      })
    ).json();
    expect(promoted.id).toBe(root.id);

    const reverted = await post(`/api/projects/${promoted.id}/convert-to-task`, {
      expectedRevision: promoted.revision,
    });
    expect(reverted.statusCode).toBe(201);
    expect(reverted.json()).toMatchObject({
      id: root.id,
      title: "Wieder zur Aufgabe",
      status: "someday",
    });
    expect(
      await ctx.app.inject({
        method: "GET",
        url: `/api/projects/${promoted.id}`,
      }),
    ).toMatchObject({ statusCode: 404 });

    const activity = ctx.handle.db
      .select()
      .from(schema.activityEvents)
      .all();
    expect(activity.filter((e) => e.kind === "work_item_role_converted")).toHaveLength(
      2,
    );
  });

  it("rejects converting a story with tasks or acceptance criteria back to a task", async () => {
    const root = (await post("/api/tasks", { title: "Mit Unterschritten" })).json();
    const promoted = (
      await post(`/api/tasks/${root.id}/convert-to-story`, { status: "backlog" })
    ).json();
    await post(`/api/tasks`, { title: "Schritt", projectId: promoted.id });

    const withChildren = await post(
      `/api/projects/${promoted.id}/convert-to-task`,
      {},
    );
    expect(withChildren.statusCode).toBe(409);
    expect(withChildren.json().error.code).toBe("role_conversion_invalid");

    const emptyRoot = (
      await post("/api/tasks", { title: "Ohne Unterschritte" })
    ).json();
    const emptyPromoted = (
      await post(`/api/tasks/${emptyRoot.id}/convert-to-story`, {
        status: "backlog",
      })
    ).json();
    await post(`/api/projects/${emptyPromoted.id}/criteria`, {
      text: "Fertig, wenn alles sauber ist",
    });

    const withCriteria = await post(
      `/api/projects/${emptyPromoted.id}/convert-to-task`,
      {},
    );
    expect(withCriteria.statusCode).toBe(409);
    expect(withCriteria.json().error.code).toBe("role_conversion_invalid");
  });
});
