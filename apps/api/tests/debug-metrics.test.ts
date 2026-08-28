import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeTestContext,
  createTestContext,
  type TestContext,
} from "./helpers.js";

describe("debug metrics", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await closeTestContext(ctx);
  });

  it("reports database growth and bounded Graph.load runtime metrics", async () => {
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { title: "Measured task", status: "actionable" },
    });
    expect(created.statusCode).toBe(201);

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/debug/metrics",
    });
    expect(response.statusCode).toBe(200);

    const metrics = response.json();
    expect(metrics.database.counts.tasks).toBe(1);
    expect(metrics.database.taskStatusCounts.actionable).toBe(1);
    expect(metrics.database.allocatedBytes).toBeGreaterThan(0);
    expect(metrics.database.maxTaskDepth).toBe(0);
    expect(metrics.graphLoads.totalLoads).toBeGreaterThanOrEqual(1);
    expect(metrics.graphLoads.recentSamples).toBeLessThanOrEqual(200);
    expect(metrics.graphLoads.lastTaskCount).toBe(1);
  });
});
