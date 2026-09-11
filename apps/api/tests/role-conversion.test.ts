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

  it("converts a captured tree to an active story without a wrapper task", async () => {
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

    const converted = await post(`/api/tasks/${root.id}/convert-to-story`, {
      status: "active",
      title: "Kinderzimmer fertig renovieren",
      notes: "Aktualisierte Notizen",
      expectedRevision: 2,
    });

    expect(converted.statusCode).toBe(201);
    expect(converted.json()).toMatchObject({
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
        url: `/api/projects/${converted.json().id}`,
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
      entityId: converted.json().id,
      entityType: "project",
      entityTitle: "Kinderzimmer fertig renovieren",
      metadata: expect.objectContaining({
        changedFields: ["role"],
      }),
    });
  });

  it("converts a captured root task to the story backlog", async () => {
    const root = (await post("/api/tasks", { title: "Vielleicht umziehen" })).json();
    const converted = await post(`/api/tasks/${root.id}/convert-to-story`, {
      status: "backlog",
      expectedRevision: root.revision,
    });

    expect(converted.statusCode).toBe(201);
    expect(converted.json()).toMatchObject({
      id: root.id,
      title: "Vielleicht umziehen",
      status: "backlog",
    });

    const projects = (
      await ctx.app.inject({ method: "GET", url: "/api/projects" })
    ).json();
    expect(projects).toContainEqual(
      expect.objectContaining({ id: converted.json().id, status: "backlog" }),
    );
  });

  it("converts actionable and someday standalone tasks to backlog stories", async () => {
    const actionable = (
      await post("/api/tasks", {
        title: "Actionable wird Projekt",
        status: "actionable",
      })
    ).json();
    const someday = (
      await post("/api/tasks", {
        title: "Someday wird Projekt",
        status: "someday",
      })
    ).json();

    const actionableStory = await post(
      `/api/tasks/${actionable.id}/convert-to-story`,
      { status: "backlog", expectedRevision: actionable.revision },
    );
    const somedayStory = await post(
      `/api/tasks/${someday.id}/convert-to-story`,
      { status: "backlog", expectedRevision: someday.revision },
    );

    expect(actionableStory.statusCode).toBe(201);
    expect(actionableStory.json()).toMatchObject({
      id: actionable.id,
      status: "backlog",
      title: "Actionable wird Projekt",
    });
    expect(somedayStory.statusCode).toBe(201);
    expect(somedayStory.json()).toMatchObject({
      id: someday.id,
      status: "backlog",
      title: "Someday wird Projekt",
    });
  });

  it("preserves hierarchy, compatible metadata, and activity identity", async () => {
    const member = (await post("/api/members", { name: "Hannes" })).json();
    const tag = (await post("/api/tags", { name: "keller", kind: "plain" })).json();
    const context = ctx.handle.db
      .insert(schema.physicalContexts)
      .values({
        source: "home_assistant",
        externalId: "basement",
        name: "Keller",
      })
      .returning()
      .get();
    const root = (
      await post("/api/tasks", {
        title: "Keller organisieren",
        notes: "Regale und Kisten",
        status: "actionable",
        ownerMemberId: member.id,
        ownerInheritanceMode: "explicit",
        dueDate: "2026-10-10",
        scheduledDate: "2026-09-15",
        tagIds: [tag.id],
        contextInheritanceMode: "explicit",
        contextIds: [context.id],
      })
    ).json();
    const first = (
      await post(`/api/tasks/${root.id}/children`, { title: "Regale ausmessen" })
    ).json();
    const second = (
      await post(`/api/tasks/${root.id}/children`, { title: "Kisten kaufen" })
    ).json();
    const grandchild = (
      await post(`/api/tasks/${first.id}/children`, { title: "Maßband suchen" })
    ).json();

    const converted = await post(`/api/tasks/${root.id}/convert-to-story`, {
      status: "backlog",
      expectedRevision: root.revision,
    });

    expect(converted.statusCode).toBe(201);
    expect(converted.json()).toMatchObject({
      id: root.id,
      revision: root.revision + 1,
      title: "Keller organisieren",
      notes: "Regale und Kisten",
      status: "backlog",
      ownerMemberId: member.id,
      dueDate: "2026-10-10",
      scheduledDate: "2026-09-15",
      tags: [expect.objectContaining({ id: tag.id })],
      contexts: [expect.objectContaining({ id: context.id })],
    });
    const project = (
      await ctx.app.inject({ method: "GET", url: `/api/projects/${root.id}` })
    ).json();
    expect(project.tasks.map((task: { id: number }) => task.id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(project.tasks[0]).toMatchObject({
      id: first.id,
      parentTaskId: null,
      children: [expect.objectContaining({ id: grandchild.id })],
    });
    const rows = ctx.handle.db
      .select({
        id: schema.workItems.id,
        parentId: schema.workItems.parentId,
        role: schema.workItems.role,
        position: schema.workItems.position,
      })
      .from(schema.workItems)
      .where(eq(schema.workItems.id, first.id))
      .all();
    expect(rows).toEqual([
      {
        id: first.id,
        parentId: root.id,
        role: "task",
        position: first.position,
      },
    ]);
    expect(
      ctx.handle.db
        .select()
        .from(schema.workItems)
        .where(eq(schema.workItems.id, grandchild.id))
        .get(),
    ).toMatchObject({ parentId: first.id, role: "task" });
    const activity = ctx.handle.db.select().from(schema.activityEvents).all();
    expect(activity.at(-1)).toMatchObject({
      kind: "work_item_role_converted",
      entityId: root.id,
      entityType: "project",
    });
    expect(activity.some((event) => event.kind === "project_deleted")).toBe(false);
    expect(activity.filter((event) => event.kind === "project_created")).toHaveLength(0);
  });

  it("requires an explicit owner when converting to an active project", async () => {
    const root = (await post("/api/tasks", { title: "Keller aufräumen" })).json();
    const activePromotion = await post(
      `/api/tasks/${root.id}/convert-to-story`,
      {
        status: "active",
        expectedRevision: root.revision,
      },
    );

    expect(activePromotion.statusCode).toBe(400);
    expect(activePromotion.json().error.code).toBe("project_driver_required");
    expect(
      await ctx.app.inject({ method: "GET", url: `/api/tasks/${root.id}` }),
    ).toMatchObject({ statusCode: 200 });
  });

  it("rejects an active conversion with a driver but no progress path atomically", async () => {
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

  it("converts an actionable root with a driver and viable child next action to active", async () => {
    const member = (await post("/api/members", { name: "Active owner" })).json();
    const root = (
      await post("/api/tasks", {
        title: "Keller organisieren",
        status: "actionable",
        ownerMemberId: member.id,
        ownerInheritanceMode: "explicit",
      })
    ).json();
    await post(`/api/tasks/${root.id}/children`, {
      title: "Regale ausmessen",
    });

    const response = await post(`/api/tasks/${root.id}/convert-to-story`, {
      status: "active",
      expectedRevision: root.revision,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      id: root.id,
      status: "active",
      ownerMemberId: member.id,
    });
  });

  it("allows backlog conversion without activation readiness", async () => {
    const root = (
      await post("/api/tasks", {
        title: "Noch nicht reif",
        status: "actionable",
      })
    ).json();

    const response = await post(`/api/tasks/${root.id}/convert-to-story`, {
      status: "backlog",
      expectedRevision: root.revision,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      id: root.id,
      status: "backlog",
      ownerMemberId: null,
    });
  });

  it("rejects subtasks, project-contained tasks, and unsupported terminal states", async () => {
    const root = (
      await post("/api/tasks", { title: "Root", status: "actionable" })
    ).json();
    const child = (await post(`/api/tasks/${root.id}/children`, { title: "Child" })).json();
    const storyRoot = (await post("/api/tasks", { title: "Story root" })).json();
    const story = (
      await post(`/api/tasks/${storyRoot.id}/convert-to-story`, {
        status: "backlog",
        expectedRevision: storyRoot.revision,
      })
    ).json();
    const insideStory = (
      await post("/api/tasks", {
        title: "Inside story",
        projectId: story.id,
      })
    ).json();
    const done = (
      await post("/api/tasks", {
        title: "Done task",
        status: "done",
      })
    ).json();
    const cancelled = (
      await post("/api/tasks", {
        title: "Cancelled task",
        status: "cancelled",
      })
    ).json();

    const childConversion = await post(`/api/tasks/${child.id}/convert-to-story`, {
      status: "backlog",
      expectedRevision: child.revision,
    });
    const storyContainedConversion = await post(
      `/api/tasks/${insideStory.id}/convert-to-story`,
      { status: "backlog", expectedRevision: insideStory.revision },
    );
    const doneConversion = await post(`/api/tasks/${done.id}/convert-to-story`, {
      status: "backlog",
      expectedRevision: done.revision,
    });
    const cancelledConversion = await post(
      `/api/tasks/${cancelled.id}/convert-to-story`,
      { status: "backlog", expectedRevision: cancelled.revision },
    );

    expect(childConversion.statusCode).toBe(409);
    expect(childConversion.json().error).toMatchObject({
      code: "role_conversion_invalid",
      details: { reason: "not_root" },
    });
    expect(storyContainedConversion.statusCode).toBe(409);
    expect(storyContainedConversion.json().error).toMatchObject({
      code: "role_conversion_invalid",
      details: { reason: "inside_story" },
    });
    expect(doneConversion.statusCode).toBe(409);
    expect(doneConversion.json().error).toMatchObject({
      code: "role_conversion_invalid",
      details: { reason: "unsupported_status" },
    });
    expect(cancelledConversion.statusCode).toBe(409);
    expect(cancelledConversion.json().error).toMatchObject({
      code: "role_conversion_invalid",
      details: { reason: "unsupported_status" },
    });
  });

  it("rejects task-only relations before converting a task to a story", async () => {
    const waiting = (
      await post("/api/tasks", { title: "Wartet extern", status: "actionable" })
    ).json();
    await ctx.app.inject({
      method: "PUT",
      url: `/api/tasks/${waiting.id}/external-wait`,
      payload: {
        expectedRevision: waiting.revision,
        waitingFor: "Antwort",
      },
    });

    const dependencyTask = (
      await post("/api/tasks", { title: "Mit Abhängigkeit", status: "actionable" })
    ).json();
    const blocker = (
      await post("/api/tasks", { title: "Voraussetzung", status: "actionable" })
    ).json();
    expect(
      await post(`/api/tasks/${dependencyTask.id}/dependencies`, {
        dependsOnTaskId: blocker.id,
      }),
    ).toMatchObject({ statusCode: 201 });

    const recurring = (
      await post("/api/tasks", {
        title: "Wiederholt",
        status: "actionable",
      })
    ).json();
    ctx.handle.db
      .update(schema.workItems)
      .set({ repeatAfterDays: 7 })
      .where(eq(schema.workItems.id, recurring.id))
      .run();
    const reminder = (
      await post("/api/tasks", {
        title: "Mit Erinnerung",
        status: "actionable",
      })
    ).json();
    ctx.handle.db
      .insert(schema.taskReminders)
      .values({
        taskId: reminder.id,
        kind: "absolute",
        at: "2030-01-01T09:00:00.000Z",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run();

    for (const task of [waiting, dependencyTask, blocker, recurring, reminder]) {
      const response = await post(`/api/tasks/${task.id}/convert-to-story`, {
        status: "backlog",
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toMatchObject({
        code: "role_conversion_invalid",
        details: { reason: "task_only_relations" },
      });
    }
  });

  it("converts a story back to a task, preserving identity and history, when the story has no children or acceptance criteria", async () => {
    const root = (await post("/api/tasks", { title: "Wieder zur Aufgabe" })).json();
    const converted = (
      await post(`/api/tasks/${root.id}/convert-to-story`, {
        status: "backlog",
        expectedRevision: root.revision,
      })
    ).json();
    expect(converted.id).toBe(root.id);
    const reverted = await post(`/api/projects/${converted.id}/convert-to-task`, {
      expectedRevision: converted.revision,
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
        url: `/api/projects/${converted.id}`,
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
    const converted = (
      await post(`/api/tasks/${root.id}/convert-to-story`, { status: "backlog" })
    ).json();
    await post(`/api/tasks`, { title: "Schritt", projectId: converted.id });

    const withChildren = await post(
      `/api/projects/${converted.id}/convert-to-task`,
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
