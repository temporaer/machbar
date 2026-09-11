import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createProject } from "../src/domain/storyCrud.js";
import { createTask } from "../src/domain/taskCrud.js";
import * as schema from "../src/db/schema.js";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

describe("project delete", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext({ seed: true });
  });

  afterEach(async () => {
    await closeTestContext(ctx);
  });

  function setup() {
    const project = createProject(ctx.handle.db, {
      title: "Küche renovieren",
      status: "backlog",
    });
    const step1 = createTask(ctx.handle.db, {
      title: "Fliesen aussuchen",
      projectId: project.id,
      status: "actionable",
    });
    const step2 = createTask(ctx.handle.db, {
      title: "Handwerker anfragen",
      projectId: project.id,
      status: "actionable",
    });
    return { project, step1, step2 };
  }

  it("keeps tasks by default, detaching them from the deleted project", async () => {
    const { project, step1, step2 } = setup();

    const response = await ctx.app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}`,
    });
    expect(response.statusCode).toBe(204);

    const remaining = ctx.handle.db
      .select({ id: schema.workItems.id, parentId: schema.workItems.parentId })
      .from(schema.workItems)
      .where(eq(schema.workItems.id, step1.id))
      .get();
    expect(remaining?.parentId).toBeNull();
    const remaining2 = ctx.handle.db
      .select({ id: schema.workItems.id, parentId: schema.workItems.parentId })
      .from(schema.workItems)
      .where(eq(schema.workItems.id, step2.id))
      .get();
    expect(remaining2?.parentId).toBeNull();

    const deletedProject = ctx.handle.db
      .select({ id: schema.workItems.id })
      .from(schema.workItems)
      .where(eq(schema.workItems.id, project.id))
      .get();
    expect(deletedProject).toBeUndefined();
  });

  it("deletes the whole task subtree when deleteTasks=true is requested", async () => {
    const { project, step1, step2 } = setup();

    const response = await ctx.app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}?deleteTasks=true`,
    });
    expect(response.statusCode).toBe(204);

    for (const id of [project.id, step1.id, step2.id]) {
      const row = ctx.handle.db
        .select({ id: schema.workItems.id })
        .from(schema.workItems)
        .where(eq(schema.workItems.id, id))
        .get();
      expect(row).toBeUndefined();
    }
  });

  it("deletes a project with no tasks the same way regardless of deleteTasks", async () => {
    const project = createProject(ctx.handle.db, {
      title: "Leeres Projekt",
      status: "backlog",
    });

    const response = await ctx.app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}?deleteTasks=true`,
    });
    expect(response.statusCode).toBe(204);
  });

  it("does not delete unrelated standalone tasks when deleting a project with deleteTasks=true", async () => {
    const { project } = setup();
    const unrelated = createTask(ctx.handle.db, { title: "Unabhängige Aufgabe" });

    await ctx.app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}?deleteTasks=true`,
    });

    const stillThere = ctx.handle.db
      .select({ id: schema.workItems.id })
      .from(schema.workItems)
      .where(eq(schema.workItems.id, unrelated.id))
      .get();
    expect(stillThere).toBeDefined();
  });
});
