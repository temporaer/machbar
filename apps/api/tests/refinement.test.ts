import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { ACTIVITY_ACTOR_HEADER } from "@machbar/shared";
import * as schema from "../src/db/schema.js";
import { createProject as createProjectMutation } from "../src/domain/storyCrud.js";
import { createTask, updateTask } from "../src/domain/taskCrud.js";
import {
  getRefinementOwnerSizeCounts,
  getRefinementTasks,
} from "../src/repo/refinementRepo.js";
import {
  closeTestContext,
  createTestContext,
  insertTestTask,
  type TestContext,
} from "./helpers.js";

describe("secondary refinement planning APIs", () => {
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
    const requestedActive = input.status === "active" ||
      (input.status === undefined && input.scope !== "work" && input.ownerMemberId != null);
    const project = createProjectMutation(
      db,
      requestedActive ? { ...input, status: "backlog", ownerMemberId: null } : input,
      context,
    );
    if (!requestedActive) return project;
    db.update(schema.workItems)
      .set({ status: "active", ownerMemberId: input.ownerMemberId ?? null })
      .where(eq(schema.workItems.id, project.id))
      .run();
    return { ...project, status: "active" };
  }

  it("groups open planning work by effective owner and size", () => {
    const owner = ctx.handle.db
      .insert(schema.members)
      .values({ name: "Mira", color: "#123456" })
      .returning()
      .get();
    const project = createProject(ctx.handle.db, {
      title: "Plan",
      status: "active",
      ownerMemberId: owner.id,
    });
    createTask(ctx.handle.db, {
      projectId: project.id,
      title: "Owned",
      status: "actionable",
      size: "M",
    });
    const done = createTask(ctx.handle.db, {
      title: "Done",
      status: "actionable",
      size: "S",
    });
    updateTask(ctx.handle.db, done.id, { status: "done" });

    expect(
      getRefinementOwnerSizeCounts(ctx.handle.db).find(
        (row) => row.ownerId === owner.id,
      ),
    ).toMatchObject({ M: 1, total: 1 });
    expect(getRefinementTasks(ctx.handle.db).map((task) => task.id)).not.toContain(
      done.id,
    );
  });

  it("keeps owner/task filter routes and removes the obsolete issues route", async () => {
    const task = createTask(ctx.handle.db, {
      title: "Shared",
      status: "actionable",
      size: "L",
    });
    const owners = await ctx.app.inject({
      method: "GET",
      url: "/api/refinement/owners",
    });
    const tasks = await ctx.app.inject({
      method: "GET",
      url: "/api/refinement/tasks?ownerId=none",
    });
    const obsolete = await ctx.app.inject({
      method: "GET",
      url: "/api/refinement/issues",
    });

    expect(owners.statusCode).toBe(200);
    expect(tasks.statusCode).toBe(200);
    expect(tasks.json().map((row: { id: number }) => row.id)).toEqual([
      task.id,
    ]);
    expect(obsolete.statusCode).toBe(404);
  });

  it("omits descendants of parked tasks from inbox and both refinement projections", async () => {
    const parent = insertTestTask(ctx.handle.db, { title: "Later", status: "someday" });
    const child = insertTestTask(ctx.handle.db, { title: "Child", status: "captured", parentTaskId: parent.id, size: "M" });
    const independent = insertTestTask(ctx.handle.db, { title: "Independent", status: "captured", size: "M" });
    const inbox = await ctx.app.inject({ method: "GET", url: "/api/inbox?scope=all" });
    expect(inbox.statusCode).toBe(200);
    expect(JSON.stringify(inbox.json())).not.toContain('"title":"Child"');
    expect(JSON.stringify(inbox.json())).toContain('"title":"Independent"');
    expect(getRefinementTasks(ctx.handle.db).map((task) => task.id)).not.toContain(child.id);
    expect(getRefinementTasks(ctx.handle.db).map((task) => task.id)).toContain(independent.id);
    expect(getRefinementOwnerSizeCounts(ctx.handle.db).find((row) => row.ownerId === null)).toMatchObject({ M: 1 });
  });

  it("resurfaces explicit clarification dates independently of parking without changing lifecycle", async () => {
    const db = ctx.handle.db;
    const parent = db.insert(schema.workItems).values({ role: "story", title: "Later project", status: "backlog" }).returning().get();
    const reached = db.insert(schema.workItems).values({ role: "task", title: "Reached", status: "captured", needsClarification: true, parentId: parent.id, clarificationRevisitDate: "2000-01-01" }).returning().get();
    const future = db.insert(schema.workItems).values({ role: "task", title: "Future", status: "captured", needsClarification: true, parentId: parent.id, clarificationRevisitDate: "2999-01-01" }).returning().get();
    const undated = db.insert(schema.workItems).values({ role: "task", title: "Undated", status: "captured", needsClarification: true, parentId: parent.id }).returning().get();
    const selfParked = db.insert(schema.workItems).values({ role: "task", title: "Self parked", status: "backlog", needsClarification: true, clarificationRevisitDate: "2000-01-01" }).returning().get();
    const archived = db.insert(schema.workItems).values({ role: "story", title: "Archived", status: "backlog", archivedAt: "2000-01-01T00:00:00Z" }).returning().get();
    const terminalChild = db.insert(schema.workItems).values({ role: "task", title: "Terminal child", status: "captured", needsClarification: true, parentId: archived.id, clarificationRevisitDate: "2000-01-01" }).returning().get();
    const before = ctx.handle.sqlite.serialize();
    const response = await ctx.app.inject({ method: "GET", url: "/api/inbox?scope=all" });
    expect(response.statusCode).toBe(200);
    const ids = response.json().map((task: { id: number }) => task.id);
    expect(ids).toEqual(expect.arrayContaining([reached.id, selfParked.id]));
    expect(ids).not.toContain(future.id);
    expect(ids).not.toContain(undated.id);
    expect(ids).not.toContain(terminalChild.id);
    expect(getRefinementTasks(db).map((task) => task.id)).not.toContain(reached.id);
    expect(ctx.handle.sqlite.serialize()).toEqual(before);
  });

  it("does not reveal a hidden ancestor's status when a clarification date is reached", async () => {
    const db = ctx.handle.db;
    const owner = db.insert(schema.members).values({ name: "Owner", color: "#123456" }).returning().get();
    const other = db.insert(schema.members).values({ name: "Other", color: "#654321" }).returning().get();
    const parent = db.insert(schema.workItems).values({ role: "story", title: "Hidden", status: "backlog", scope: "work", ownerMemberId: owner.id }).returning().get();
    const child = db.insert(schema.workItems).values({ role: "task", title: "Visible", status: "captured", needsClarification: true, parentId: parent.id, scope: "household", clarificationRevisitDate: "2000-01-01" }).returning().get();
    const read = async (viewer?: number) => {
      const response = await ctx.app.inject({ method: "GET", url: "/api/inbox?scope=all", headers: viewer === undefined ? {} : { [ACTIVITY_ACTOR_HEADER]: String(viewer) } });
      expect(response.statusCode).toBe(200);
      return response.json();
    };
    const otherParked = await read(other.id);
    const unknownParked = await read();
    expect(otherParked.map((task: { id: number }) => task.id)).toContain(child.id);
    expect(unknownParked.map((task: { id: number }) => task.id)).toContain(child.id);
    db.update(schema.workItems).set({ status: "active" }).where(eq(schema.workItems.id, parent.id)).run();
    expect(await read(other.id)).toEqual(otherParked);
    expect(await read()).toEqual(unknownParked);
  });
});
