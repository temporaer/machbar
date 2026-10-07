import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

describe("household AI context", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await closeTestContext(ctx);
  });

  it("starts empty and trims values while converting blanks to null", async () => {
    const initial = await ctx.app.inject({ method: "GET", url: "/api/settings/ai-context" });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual({
      householdDescription: null,
      longTermDirection: null,
      suggestionGuidance: null,
    });

    const saved = await ctx.app.inject({
      method: "PUT",
      url: "/api/settings/ai-context",
      payload: {
        householdDescription: "  Personen und Orte  ",
        longTermDirection: "  ",
        suggestionGuidance: null,
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({
      householdDescription: "Personen und Orte",
      longTermDirection: null,
      suggestionGuidance: null,
    });
  });

  it("rejects unknown fields and overlong values", async () => {
    const unknown = await ctx.app.inject({
      method: "PUT",
      url: "/api/settings/ai-context",
      payload: { householdDescription: "ok", extra: "no" },
    });
    expect(unknown.statusCode).toBe(400);

    const tooLong = await ctx.app.inject({
      method: "PUT",
      url: "/api/settings/ai-context",
      payload: { longTermDirection: "x".repeat(2001) },
    });
    expect(tooLong.statusCode).toBe(400);
  });
});
