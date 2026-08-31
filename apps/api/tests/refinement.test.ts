import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema.js";
import {
  createProject as createProjectMutation,
  createTask,
  updateTask,
} from "../src/domain/mutations.js";
import {
  getRefinementOwnerSizeCounts,
  getRefinementTasks,
} from "../src/repo/refinementRepo.js";
import {
  closeTestContext,
  createTestContext,
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
    const requestedActive = input.status === "active";
    const project = createProjectMutation(
      db,
      requestedActive ? { ...input, status: "backlog" } : input,
      context,
    );
    if (!requestedActive) return project;
    db.update(schema.projects)
      .set({ status: "active" })
      .where(eq(schema.projects.id, project.id))
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
});
