import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

describe("Fastify-level error handling", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await closeTestContext(ctx);
  });

  it("returns a calm German 400 (not a generic 500) for a request with Content-Type: application/json but no body", async () => {
    // Mirrors the real bug: the browser's fetch() call used to always send
    // `Content-Type: application/json` on DELETE, even without a body.
    // Fastify's json body parser rejects that combination itself, before any
    // route handler (or `AppError`) ever gets involved.
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/members",
      payload: { name: "Wird gelöscht" },
    });
    const member = created.json();

    const res = await ctx.app.inject({
      method: "DELETE",
      url: `/api/members/${member.id}`,
      headers: { "content-type": "application/json" },
      payload: "",
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: {
        code: "bad_request",
        message: "Die Anfrage konnte nicht verarbeitet werden.",
      },
    });
  });

  it("still deletes normally (204, no Content-Type) when the request omits the JSON content type", async () => {
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/members",
      payload: { name: "Bleibt gelöscht" },
    });
    const member = created.json();

    const res = await ctx.app.inject({ method: "DELETE", url: `/api/members/${member.id}` });

    expect(res.statusCode).toBe(204);
    expect(res.body).toBe("");

    const listRes = await ctx.app.inject({ method: "GET", url: "/api/members" });
    expect(listRes.json().map((m: { id: number }) => m.id)).not.toContain(member.id);
  });
});
