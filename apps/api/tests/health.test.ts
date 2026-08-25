import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

describe("health", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await closeTestContext(ctx);
  });

  it("responds with status ok", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("returns a German 404 body for unknown API routes", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/api/does-not-exist" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toContain("nicht gefunden");
  });
});
