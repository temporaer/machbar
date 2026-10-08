import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema.js";
import { getActivityPage } from "../src/repo/activityRepo.js";
import {
  closeTestContext,
  createTestContext,
  insertTestProject,
  insertTestTask,
  type TestContext,
} from "./helpers.js";

describe("activity repository", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await closeTestContext(ctx);
  });

  function seedActivity() {
    const actor = ctx.handle.db
      .insert(schema.members)
      .values({ name: "Mira", color: "#123456" })
      .returning()
      .get();
    const otherActor = ctx.handle.db
      .insert(schema.members)
      .values({ name: "Lea", color: "#abcdef" })
      .returning()
      .get();
    const project = insertTestProject(ctx.handle.db, { title: "Umzug" });
    const otherProject = insertTestProject(ctx.handle.db, { title: "Garten" });
    const task = insertTestTask(ctx.handle.db, { title: "Kisten packen", projectId: project.id });
    const otherTask = insertTestTask(ctx.handle.db, { title: "Rasen mähen", projectId: otherProject.id });

    ctx.handle.db.insert(schema.activityEvents).values([
      {
        createdAt: "2026-08-27T18:00:00.000Z",
        actorMemberId: actor.id,
        kind: "project_updated",
        entityId: project.id,
        entityType: "project",
        entityTitle: project.title,
        metadata: { changedFields: ["notes"] },
      },
      {
        createdAt: "2026-08-27T18:00:00.000Z",
        actorMemberId: actor.id,
        kind: "task_updated",
        entityId: task.id,
        entityType: "task",
        entityTitle: task.title,
        metadata: { changedFields: ["scheduledDate"] },
      },
      {
        createdAt: "2026-08-27T17:00:00.000Z",
        actorMemberId: otherActor.id,
        kind: "task_status_changed",
        entityId: otherTask.id,
        entityType: "task",
        entityTitle: otherTask.title,
        metadata: { previousStatus: "actionable", nextStatus: "done" },
      },
    ]).run();

    return { actor, otherActor, project, otherProject, task, otherTask };
  }

  it("paginates newest-first deterministically when timestamps are equal", () => {
    seedActivity();

    const first = getActivityPage(ctx.handle.db, { limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.items[0]?.kind).toBe("task_updated");
    expect(first.nextCursor).not.toBeNull();

    const second = getActivityPage(ctx.handle.db, {
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(second.items[0]?.kind).toBe("project_updated");
    expect(second.nextCursor).not.toBeNull();

    const third = getActivityPage(ctx.handle.db, {
      limit: 1,
      cursor: second.nextCursor!,
    });
    expect(third.items[0]?.kind).toBe("task_status_changed");
    expect(third.nextCursor).toBeNull();
  });

  it("applies actor, task, and recorded project-context filters", () => {
    const { actor, project, task } = seedActivity();

    expect(
      getActivityPage(ctx.handle.db, { limit: 50, actorId: actor.id }).items,
    ).toHaveLength(2);
    expect(
      getActivityPage(ctx.handle.db, { limit: 50, taskId: task.id }).items.map(
        (event) => event.kind,
      ),
    ).toEqual(["task_updated"]);
    expect(
      getActivityPage(ctx.handle.db, {
        limit: 50,
        projectId: project.id,
      }).items.map((event) => event.kind),
    ).toEqual(["task_updated", "project_updated"]);
  });

  it("resolves actors while preserving snapshots and nullable deleted refs", () => {
    const { actor, project, task } = seedActivity();
    const beforeDelete = getActivityPage(ctx.handle.db, {
      limit: 50,
      taskId: task.id,
    }).items[0]!;
    expect(beforeDelete.actor).toEqual({
      id: actor.id,
      name: "Mira",
      color: "#123456",
      pictureUrl: null,
    });

    ctx.handle.db.delete(schema.workItems).where(eq(schema.workItems.id, task.id)).run();
    ctx.handle.db.delete(schema.workItems).where(eq(schema.workItems.id, project.id)).run();
    ctx.handle.db.delete(schema.members).where(eq(schema.members.id, actor.id)).run();

    const events = getActivityPage(ctx.handle.db, { limit: 50 }).items.filter(
      (event) => event.entity.title === "Kisten packen" || event.entity.title === "Umzug",
    );
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.actor === null)).toBe(true);
    expect(events.find((event) => event.entity.type === "task")?.entity).toEqual({
      type: "task",
      title: "Kisten packen",
      taskId: null,
      projectId: null,
    });
    expect(events.find((event) => event.entity.type === "project")?.entity).toEqual({
      type: "project",
      title: "Umzug",
      taskId: null,
      projectId: null,
    });
  });

  it("filters private work activity to the effective owner when a viewer is supplied", () => {
    const owner = ctx.handle.db
      .insert(schema.members)
      .values({ name: "Owner", color: "#111111" })
      .returning()
      .get();
    const other = ctx.handle.db
      .insert(schema.members)
      .values({ name: "Other", color: "#222222" })
      .returning()
      .get();
    const task = insertTestTask(ctx.handle.db, {
      title: "Private task",
      scope: "work",
      ownerMemberId: owner.id,
      ownerInheritanceMode: "explicit",
    });
    ctx.handle.db.insert(schema.activityEvents).values({
      actorMemberId: other.id,
      kind: "task_updated",
      entityId: task.id,
      entityType: "task",
      entityTitle: task.title,
      metadata: {
        scope: "work",
        after: { effectiveOwnerId: owner.id },
      },
    }).run();

    expect(
      getActivityPage(ctx.handle.db, {
        limit: 50,
        viewerMemberId: owner.id,
      }).items.some((event) => event.entity.title === task.title),
    ).toBe(true);
    expect(
      getActivityPage(ctx.handle.db, {
        limit: 50,
        viewerMemberId: other.id,
      }).items.some((event) => event.entity.title === task.title),
    ).toBe(false);
  });

  it("fills a visible page past invisible private events without leaking them", () => {
    const viewer = ctx.handle.db
      .insert(schema.members)
      .values({ name: "Viewer", color: "#111111" })
      .returning()
      .get();
    const owner = ctx.handle.db
      .insert(schema.members)
      .values({ name: "Owner", color: "#222222" })
      .returning()
      .get();
    const visibleIds = [1, 2].map((index) =>
      ctx.handle.db
        .insert(schema.activityEvents)
        .values({
          kind: "task_created",
          entityType: "task",
          entityTitle: `Shared ${index}`,
          metadata: { scope: "household" },
        })
        .returning({ id: schema.activityEvents.id })
        .get().id,
    );
    for (let index = 0; index < 60; index += 1) {
      ctx.handle.db.insert(schema.activityEvents).values({
        kind: "task_created",
        entityType: "task",
        entityTitle: `Private ${index}`,
        metadata: {
          scope: "work",
          after: { effectiveOwnerId: owner.id },
        },
      }).run();
    }

    const first = getActivityPage(ctx.handle.db, {
      limit: 2,
      viewerMemberId: viewer.id,
    });
    expect(first.items.map((event) => event.id)).toEqual(visibleIds.reverse());
    expect(first.items.map((event) => event.entity.title)).not.toContain("Private 0");
    expect(first.nextCursor).toBeNull();
  });

  it("suppresses legacy deleted events whose scope cannot be established", () => {
    const viewer = ctx.handle.db
      .insert(schema.members)
      .values({ name: "Viewer", color: "#111111" })
      .returning()
      .get();
    ctx.handle.db.insert(schema.activityEvents).values({
      kind: "task_deleted",
      entityType: "task",
      entityTitle: "Unbekannt privat",
      entityId: null,
      metadata: {},
    }).run();

    expect(getActivityPage(ctx.handle.db, {
      limit: 50,
      viewerMemberId: viewer.id,
    }).items).toEqual([]);
  });
});

describe("GET /api/activity", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
    ctx.handle.db.insert(schema.activityEvents).values({
      createdAt: "2026-08-27T18:00:00.000Z",
      kind: "task_created",
      entityType: "task",
      entityTitle: "Erfasst",
      metadata: { scope: "household" },
    }).run();
  });

  afterEach(async () => {
    await closeTestContext(ctx);
  });

  it("returns the shared paginated response contract", async () => {
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/activity?limit=1",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [
        {
          id: 1,
          createdAt: "2026-08-27T18:00:00.000Z",
          kind: "task_created",
          actor: null,
          entity: {
            type: "task",
            title: "Erfasst",
            taskId: null,
            projectId: null,
          },
          metadata: { scope: "household" },
        },
      ],
      nextCursor: null,
    });
  });

  it.each([
    "/api/activity?cursor=not-a-cursor",
    "/api/activity?limit=0",
    "/api/activity?limit=101",
    "/api/activity?actorId=0",
    "/api/activity?taskId=nope",
    "/api/activity?projectId=-1",
  ])("rejects invalid query parameters: %s", async (url) => {
    const response = await ctx.app.inject({ method: "GET", url });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe(
      url.includes("cursor=")
        ? "activity_cursor_invalid"
        : "activity_query_invalid",
    );
  });
});
