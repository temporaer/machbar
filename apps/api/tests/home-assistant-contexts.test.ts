import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../src/db/schema.js";
import {
  HOME_ASSISTANT_STALE_MS,
  contextAvailabilityForMember,
} from "../src/integrations/homeAssistant.js";
import {
  closeTestContext,
  createTestContext,
  type TestContext,
} from "./helpers.js";

describe("Home Assistant physical contexts", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await closeTestContext(ctx);
  });

  async function post(
    url: string,
    payload?: Record<string, unknown>,
    token?: string,
  ) {
    return await ctx.app.inject({
      method: "POST",
      url,
      ...(payload === undefined ? {} : { payload }),
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    });
  }

  async function connect() {
    const pairing = (
      await post("/api/integrations/home-assistant/pairing-code")
    ).json();
    return (
      await post("/api/integrations/home-assistant/pair", {
        pairingCode: pairing.code,
        protocolVersion: 1,
      })
    ).json() as { token: string };
  }

  it("inherits, overrides, and clears project context requirements", async () => {
    const context = ctx.handle.db
      .insert(schema.physicalContexts)
      .values({
        source: "home_assistant",
        externalId: "zone.home",
        name: "Zuhause",
      })
      .returning()
      .get();
    const project = (
      await post("/api/projects", {
        title: "Garten",
        contextIds: [context.id],
      })
    ).json();
    const parent = (
      await post("/api/tasks", { title: "Planen", projectId: project.id })
    ).json();
    const child = (
      await post(`/api/tasks/${parent.id}/children`, { title: "Einkaufen" })
    ).json();

    expect(parent.effectiveContexts).toEqual([
      expect.objectContaining({ id: context.id }),
    ]);
    expect(child.effectiveContexts).toEqual([
      expect.objectContaining({ id: context.id }),
    ]);

    const cleared = await ctx.app.inject({
      method: "PATCH",
      url: `/api/tasks/${child.id}`,
      payload: {
        contextInheritanceMode: "none",
        contextIds: [],
        expectedRevision: child.revision,
      },
    });
    expect(cleared.json().effectiveContexts).toEqual([]);
  });

  it("pairs once, stores only hashes, and moves work between Today and Waiting", async () => {
    const member = (
      await post("/api/members", { name: "Mira" })
    ).json() as { id: number };
    const pairing = (
      await post("/api/integrations/home-assistant/pairing-code")
    ).json() as { code: string };
    const paired = (
      await post("/api/integrations/home-assistant/pair", {
        pairingCode: pairing.code,
        protocolVersion: 1,
      })
    ).json() as { token: string };
    expect(
      ctx.handle.db.select().from(schema.homeAssistantPairingCodes).get()
        ?.codeHash,
    ).not.toContain(pairing.code);
    expect(
      ctx.handle.db.select().from(schema.homeAssistantIntegrations).get()
        ?.tokenHash,
    ).not.toContain(paired.token);
    expect(
      (
        await post("/api/integrations/home-assistant/pair", {
          pairingCode: pairing.code,
          protocolVersion: 1,
        })
      ).statusCode,
    ).toBe(401);

    const snapshot = (contexts: string[]) =>
      post(
        "/api/integrations/home-assistant/context",
        {
          protocolVersion: 1,
          observedAt: new Date().toISOString(),
          contexts: [{ externalId: "zone.home", name: "Zuhause" }],
          people: [
            {
              externalId: "person.mira",
              name: "Mira",
              state: "known",
              contexts,
            },
          ],
        },
        paired.token,
      );
    await snapshot([]);
    await ctx.app.inject({
      method: "PUT",
      url: "/api/integrations/home-assistant/people/person.mira/mapping",
      payload: { memberId: member.id },
    });
    const context = ctx.handle.db
      .select()
      .from(schema.physicalContexts)
      .get()!;
    const task = (
      await post("/api/tasks", {
        title: "Keller aufräumen",
        status: "actionable",
        ownerMemberId: member.id,
        ownerInheritanceMode: "explicit",
        contextInheritanceMode: "explicit",
        contextIds: [context.id],
      })
    ).json();

    const date = new Date().toISOString().slice(0, 10);
    const unavailableAgenda = (
      await ctx.app.inject({
        method: "GET",
        url: `/api/agenda/today?scope=mine&memberId=${member.id}&date=${date}`,
      })
    ).json();
    expect(unavailableAgenda.unscheduled).toEqual([]);
    const waiting = (
      await ctx.app.inject({
        method: "GET",
        url: `/api/waiting?scope=mine&memberId=${member.id}`,
      })
    ).json();
    expect(waiting[0]).toMatchObject({
      task: { id: task.id },
      reasons: [{ type: "context" }],
    });

    await snapshot(["zone.home"]);
    const availableAgenda = (
      await ctx.app.inject({
        method: "GET",
        url: `/api/agenda/today?scope=mine&memberId=${member.id}&date=${date}`,
      })
    ).json();
    expect(availableAgenda.unscheduled).toEqual([
      expect.objectContaining({ id: task.id }),
    ]);
    expect(
      (
        await ctx.app.inject({
          method: "GET",
          url: `/api/waiting?scope=mine&memberId=${member.id}`,
        })
      ).json(),
    ).toEqual([]);
    const available = contextAvailabilityForMember(
      ctx.handle.db,
      [context],
      member.id,
    );
    expect(available.status).toBe("available");
    expect(
      contextAvailabilityForMember(
        ctx.handle.db,
        [context],
        member.id,
        new Date(Date.now() + HOME_ASSISTANT_STALE_MS + 1),
      ).status,
    ).toBe("unknown");
  });

  it("keeps snapshot ingestion machine-authenticated in development mode", async () => {
    expect(
      (
        await post("/api/integrations/home-assistant/context", {
          protocolVersion: 1,
          observedAt: new Date().toISOString(),
          contexts: [],
          people: [],
        })
      ).statusCode,
    ).toBe(401);
    const { token } = await connect();
    expect(
      (
        await post(
          "/api/integrations/home-assistant/context",
          {
            protocolVersion: 1,
            observedAt: new Date().toISOString(),
            contexts: [],
            people: [],
          },
          token,
        )
      ).statusCode,
    ).toBe(204);
  });
});
