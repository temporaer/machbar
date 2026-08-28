import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema.js";
import { getActivityPage } from "../src/repo/activityRepo.js";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

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
    const project = ctx.handle.db
      .insert(schema.projects)
      .values({ title: "Umzug" })
      .returning()
      .get();
    const otherProject = ctx.handle.db
      .insert(schema.projects)
      .values({ title: "Garten" })
      .returning()
      .get();
    const task = ctx.handle.db
      .insert(schema.tasks)
      .values({ title: "Kisten packen", projectId: project.id })
      .returning()
      .get();
    const otherTask = ctx.handle.db
      .insert(schema.tasks)
      .values({ title: "Rasen mähen", projectId: otherProject.id })
      .returning()
      .get();

    ctx.handle.db.insert(schema.activityEvents).values([
      {
        createdAt: "2026-08-27T18:00:00.000Z",
        actorMemberId: actor.id,
        kind: "project_updated",
        projectId: project.id,
        entityType: "project",
        entityTitle: project.title,
        metadata: { changedFields: ["notes"] },
      },
      {
        createdAt: "2026-08-27T18:00:00.000Z",
        actorMemberId: actor.id,
        kind: "task_updated",
        taskId: task.id,
        projectId: project.id,
        entityType: "task",
        entityTitle: task.title,
        metadata: { changedFields: ["scheduledDate"] },
      },
      {
        createdAt: "2026-08-27T17:00:00.000Z",
        actorMemberId: otherActor.id,
        kind: "task_status_changed",
        taskId: otherTask.id,
        projectId: otherProject.id,
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

    ctx.handle.db.delete(schema.tasks).where(eq(schema.tasks.id, task.id)).run();
    ctx.handle.db.delete(schema.projects).where(eq(schema.projects.id, project.id)).run();
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
      metadata: {},
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
          metadata: {},
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
