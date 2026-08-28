import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACTIVITY_ACTOR_HEADER } from "@machbar/shared";
import { resolveActivityActor } from "../src/activity/actor.js";
import * as schema from "../src/db/schema.js";
import {
  closeTestContext,
  createTestContext,
  type TestContext,
} from "./helpers.js";

describe("activity actor resolution", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
    ctx.app.get("/test/activity-actor", async (request) => request.activityActor);
  });

  afterEach(async () => {
    await closeTestContext(ctx);
  });

  it("resolves a selected local member from the dedicated header", async () => {
    const member = ctx.handle.db
      .insert(schema.members)
      .values({ name: "Mira", color: "#123456" })
      .returning()
      .get();

    const response = await ctx.app.inject({
      method: "GET",
      url: "/test/activity-actor",
      headers: { [ACTIVITY_ACTOR_HEADER]: String(member.id) },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ...member, pictureUrl: null });
  });

  it("always prefers the authenticated OIDC member over caller header input", () => {
    const authenticated = ctx.handle.db
      .insert(schema.members)
      .values({ name: "Hannes", color: "#abcdef" })
      .returning()
      .get();
    ctx.handle.db
      .insert(schema.members)
      .values({ name: "Other", color: "#123456" })
      .run();

    expect(
      resolveActivityActor(
        ctx.handle.db,
        { ...authenticated, pictureUrl: null, managedByOidc: true },
        "not-even-a-valid-id",
        true,
      ),
    ).toEqual({ ...authenticated, pictureUrl: null });
  });

  it("allows an omitted actor for compatible and system calls", async () => {
    const response = await ctx.app.inject({
      method: "GET",
      url: "/test/activity-actor",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toBeNull();
  });

  it.each(["", "abc", "1.5", "0", "-1", "1x"])(
    "rejects malformed local actor value %j with a client error",
    async (value) => {
      const response = await ctx.app.inject({
        method: "GET",
        url: "/test/activity-actor",
        headers: { [ACTIVITY_ACTOR_HEADER]: value },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: {
          code: "activity_actor_invalid",
          message: "The activity actor must be a valid member ID.",
          details: { value },
        },
      });
    },
  );

  it("rejects repeated local actor headers", () => {
    expect(() =>
      resolveActivityActor(ctx.handle.db, null, ["1", "2"], true),
    ).toThrow("The activity actor must be a valid member ID.");
  });

  it("rejects an unknown local actor with a clear client error", async () => {
    const response = await ctx.app.inject({
      method: "GET",
      url: "/test/activity-actor",
      headers: { [ACTIVITY_ACTOR_HEADER]: "999" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: "activity_actor_not_found",
        message: "The selected activity actor does not exist.",
        details: { memberId: 999 },
      },
    });
  });
});
