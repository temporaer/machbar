import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
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

    const explicit = await ctx.app.inject({
      method: "PATCH",
      url: `/api/tasks/${child.id}`,
      payload: {
        contextInheritanceMode: "explicit",
        contextIds: [context.id],
        expectedRevision: child.revision,
      },
    });
    expect(explicit.json().explicitContexts).toEqual([
      expect.objectContaining({ id: context.id }),
    ]);

    const cleared = await ctx.app.inject({
      method: "PATCH",
      url: `/api/tasks/${child.id}`,
      payload: {
        contextInheritanceMode: "none",
        contextIds: [],
        expectedRevision: explicit.json().revision,
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

    let snapshotSequence = 0;
    const snapshot = (contexts: string[]) =>
      post(
        "/api/integrations/home-assistant/context",
        {
          protocolVersion: 1,
          observedAt: new Date(Date.now() + snapshotSequence++).toISOString(),
          contexts: [
            { externalId: "zone.home", name: "Zuhause" },
            { externalId: "zone.shop", name: "Laden" },
          ],
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
      .where(eq(schema.physicalContexts.externalId, "zone.shop"))
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

    await snapshot(["zone.shop"]);
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
    expect(ctx.handle.db.select().from(schema.notificationEvents).all()).toEqual([
      expect.objectContaining({
        kind: "context_entered",
        recipientMemberId: member.id,
        entityId: task.id,
        entityTitle: "Laden: Keller aufräumen",
      }),
    ]);
    const homeContext = ctx.handle.db
      .select()
      .from(schema.physicalContexts)
      .where(eq(schema.physicalContexts.externalId, "zone.home"))
      .get()!;
    await post("/api/tasks", {
      title: "Zuhause erledigen",
      status: "actionable",
      ownerMemberId: member.id,
      ownerInheritanceMode: "explicit",
      contextInheritanceMode: "explicit",
      contextIds: [homeContext.id],
    });
    await snapshot(["zone.home"]);
    expect(ctx.handle.db.select().from(schema.notificationEvents).all()).toHaveLength(1);
    await snapshot(["zone.shop"]);
    expect(ctx.handle.db.select().from(schema.notificationEvents).all()).toHaveLength(2);
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
