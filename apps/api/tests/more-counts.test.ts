import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../src/db/schema.js";
import {
  closeTestContext,
  createTestContext,
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
    ctx.handle.db
      .insert(schema.projects)
      .values({ title: "Later", status: "backlog" })
      .run();
    const healthy = ctx.handle.db
      .insert(schema.projects)
      .values({
        title: "Healthy",
        status: "active",
        ownerMemberId: member.id,
      })
      .returning()
      .get();
    ctx.handle.db.insert(schema.projectAcceptanceCriteria).values({
      projectId: healthy.id,
      text: "Done",
    }).run();
    ctx.handle.db.insert(schema.tasks).values({
      projectId: healthy.id,
      title: "Do it",
      status: "actionable",
    }).run();
    ctx.handle.db
      .insert(schema.projects)
      .values({ title: "Needs decisions", status: "active" })
      .run();

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/views/more-counts",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ review: 2 });
  });
});
