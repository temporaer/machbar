import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../src/db/schema.js";
import {
  closeTestContext,
  createTestContext,
  insertTestProject,
  insertTestTask,
  type TestContext,
} from "./helpers.js";

describe("GET /api/views/more-counts", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await closeTestContext(ctx);
  });

  it("counts the consolidated derived review queue", async () => {
    const member = ctx.handle.db
      .insert(schema.members)
      .values({ name: "Mira", color: "#123456" })
      .returning()
      .get();
    insertTestProject(ctx.handle.db, { title: "Later", status: "backlog" });
    const healthy = insertTestProject(ctx.handle.db, {
        title: "Healthy",
        status: "active",
        ownerMemberId: member.id,
      });
    ctx.handle.db.insert(schema.workItemAcceptanceCriteria).values({
      workItemId: healthy.id,
      text: "Done",
    }).run();
    insertTestTask(ctx.handle.db, {
      projectId: healthy.id,
      title: "Do it",
      status: "actionable",
    });
    insertTestProject(ctx.handle.db, { title: "Needs decisions", status: "active" });

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/views/more-counts",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ review: 2 });
  });
});
