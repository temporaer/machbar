import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import * as schema from "../src/db/schema.js";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

type Target = { type: "task" | "project"; id: number };

describe("cleanup round micro-flow actions", () => {
  let ctx: TestContext;
  let token: string;
  beforeEach(async () => {
    ctx = createTestContext();
    const code = (await ctx.app.inject({ method: "POST", url: "/api/integrations/home-assistant/pairing-code" })).json().code as string;
    token = (await ctx.app.inject({
      method: "POST",
      url: "/api/integrations/home-assistant/pair",
      payload: { pairingCode: code, protocolVersion: 3 },
    })).json().token as string;
  });
  afterEach(async () => { await closeTestContext(ctx); });

  const auth = () => ({ authorization: 'Bear' + 'er ' + token });

  async function task(title: string, extra: Record<string, unknown> = {}) {
    const response = await ctx.app.inject({ method: "POST", url: "/api/tasks", payload: { title, status: "actionable", ...extra } });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().id as number;
  }

  async function project(title: string) {
    const response = await ctx.app.inject({ method: "POST", url: "/api/projects", payload: { title } });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().id as number;
  }

  function row(id: number) {
    return ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.id, id)).get();
  }

  /** Creates a round over `target` whose single card is ready. */
  async function readyCard(target: Target) {
    const created = await ctx.app.inject({ method: "POST", url: "/api/cleanup-rounds", payload: {} });
    expect(created.statusCode, created.body).toBe(201);
    const roundId = created.json().id as string;
    const leased = (await ctx.app.inject({
      method: "GET",
      url: "/api/integrations/home-assistant/requests/next?protocolVersion=3&waitSeconds=0",
      headers: auth(),
    })).json() as { id: string; leaseToken: string; payload: { items: Array<{ targetType: string; targetId: number }> } };
    const results = leased.payload.items.map((item) => ({
      targetType: item.targetType,
      targetId: item.targetId,
      proposal: "rename_for_actionability",
      resolutionSurface: "rename_item",
      inferredWorkType: "normal",
      inferredFlow: "uphill",
      confidence: "medium",
      reason: "Der Titel sagt nicht, was zu tun ist.",
      question: "Was genau?",
      suggestedDefault: null,
      suggestedTitle: null,
      suggestedShape: null,
    }));
    const done = await ctx.app.inject({
      method: "POST",
      url: `/api/integrations/home-assistant/requests/${leased.id}/complete`,
      headers: auth(),
      payload: { leaseToken: leased.leaseToken, outcome: "succeeded", result: { summary: "x", results, warnings: [] } },
    });
    expect(done.statusCode, done.body).toBe(204);
    const round = (await ctx.app.inject({ method: "GET", url: `/api/cleanup-rounds/${roundId}` })).json();
    const item = round.items.find((candidate: { targetType: string; targetId: number }) =>
      candidate.targetType === target.type && candidate.targetId === target.id);
    expect(item?.status).toBe("ready");
    return { roundId, itemId: item.id as string };
  }

  function act(card: { roundId: string; itemId: string }, action: string, payload: unknown) {
    return ctx.app.inject({
      method: "POST",
      url: `/api/cleanup-rounds/${card.roundId}/items/${card.itemId}/actions/${action}`,
      payload: payload as Record<string, unknown>,
    });
  }

  function cardStatus(card: { itemId: string }) {
    return ctx.handle.db.select().from(schema.cleanupRoundItems)
      .where(eq(schema.cleanupRoundItems.id, card.itemId)).get()!.status;
  }

  function children(parentId: number) {
    return ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.parentId, parentId)).all();
  }

  it("renames a task and dismisses the card in one step without reviewing it", async () => {
    const keller = await task("Keller");
    const card = await readyCard({ type: "task", id: keller });
    const response = await act(card, "rename", { title: "  Werkzeugecke sortieren ", expectedRevision: row(keller)!.revision });
    expect(response.statusCode, response.body).toBe(200);
    const round = response.json();
    expect(round.items.find((item: { id: string }) => item.id === card.itemId).status).toBe("dismissed");
    expect(round.status).toBe("completed");
    expect(row(keller)).toMatchObject({ title: "Werkzeugecke sortieren", reviewedAt: null });
  });

  it("renames a project through the canonical project update", async () => {
    const haustuer = await project("Haustür");
    const card = await readyCard({ type: "project", id: haustuer });
    const response = await act(card, "rename", { title: "Neue Haustür auswählen" });
    expect(response.statusCode, response.body).toBe(200);
    expect(row(haustuer)).toMatchObject({ title: "Neue Haustür auswählen", reviewedAt: null });
    expect(cardStatus(card)).toBe("dismissed");
  });

  it("rejects a stale revision without renaming or dismissing", async () => {
    const keller = await task("Keller");
    const card = await readyCard({ type: "task", id: keller });
    const revision = row(keller)!.revision;
    await ctx.app.inject({ method: "PATCH", url: `/api/tasks/${keller}`, payload: { notes: "parallel" } });
    const response = await act(card, "rename", { title: "Werkzeugecke sortieren", expectedRevision: revision });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("stale_write_conflict");
    expect(row(keller)!.title).toBe("Keller");
    expect(cardStatus(card)).toBe("ready");
  });

  it.each([
    ["rename", {}],
    ["rename", { title: "   " }],
    ["create-task", { title: "", purpose: "decision" }],
    ["create-task", { title: "x", purpose: "anything" }],
    ["add-done-when", { text: " " }],
    ["rename", { title: "x", operation: "delete" }],
  ])("rejects an invalid %s payload %j", async (action, payload) => {
    const keller = await task("Keller");
    const card = await readyCard({ type: "task", id: keller });
    const response = await act(card, action, payload);
    expect(response.statusCode).toBe(400);
    expect(row(keller)!.title).toBe("Keller");
    expect(children(keller)).toHaveLength(0);
    expect(cardStatus(card)).toBe("ready");
  });

  it.each([
    ["rename", { title: "Keller" }],
    ["clarify-admin", { title: "Keller", notes: "  " }],
    ["clarify-admin", {}],
  ])("rejects a %s that changes nothing", async (action, payload) => {
    const keller = await task("Keller");
    const card = await readyCard({ type: "task", id: keller });
    const response = await act(card, action, payload);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("cleanup_round_action_no_change");
    expect(cardStatus(card)).toBe("ready");
  });

  it("creates a child task under a task target and inherits from it", async () => {
    const member = (await ctx.app.inject({ method: "POST", url: "/api/members", payload: { name: "Kim" } })).json().id as number;
    const keller = await task("Keller", { ownerMemberId: member, ownerInheritanceMode: "explicit" });
    const card = await readyCard({ type: "task", id: keller });
    const response = await act(card, "create-task", { title: "Entscheiden: Welche Ecke zuerst?", purpose: "decision" });
    expect(response.statusCode, response.body).toBe(200);
    const [child] = children(keller);
    const detail = (await ctx.app.inject({ method: "GET", url: `/api/tasks/${child!.id}` })).json();
    expect(detail).toMatchObject({ title: "Entscheiden: Welche Ecke zuerst?", status: "actionable", parentTaskId: keller });
    expect(detail).toMatchObject({ effectiveOwnerId: member, effectiveOwnerSource: "parent" });
    expect(row(keller)!.reviewedAt).toBeNull();
    expect(cardStatus(card)).toBe("dismissed");
  });

  it("creates a project task under a project target", async () => {
    const haustuer = await project("Haustür");
    const card = await readyCard({ type: "project", id: haustuer });
    const response = await act(card, "create-task", { title: "Angebote vergleichen", purpose: "firstSlice" });
    expect(response.statusCode, response.body).toBe(200);
    const created = ctx.handle.db.select().from(schema.workItems)
      .where(eq(schema.workItems.title, "Angebote vergleichen")).get();
    const detail = (await ctx.app.inject({ method: "GET", url: `/api/tasks/${created!.id}` })).json();
    expect(detail).toMatchObject({ projectId: haustuer, parentTaskId: null });
    expect(row(haustuer)!.reviewedAt).toBeNull();
    expect(cardStatus(card)).toBe("dismissed");
  });

  it("keeps the card when the canonical creation rejects the change", async () => {
    const captured = await task("Keller", { status: "captured" });
    const card = await readyCard({ type: "task", id: captured });
    const response = await act(card, "create-task", { title: "Ecke sortieren", purpose: "firstSlice" });
    expect(response.statusCode).toBe(409);
    expect(children(captured)).toHaveLength(0);
    expect(cardStatus(card)).toBe("ready");
  });

  it("adds a done-when criterion to a project", async () => {
    const haustuer = await project("Haustür");
    const card = await readyCard({ type: "project", id: haustuer });
    const response = await act(card, "add-done-when", { text: "Tür ist montiert." });
    expect(response.statusCode, response.body).toBe(200);
    const criteria = ctx.handle.db.select().from(schema.workItemAcceptanceCriteria)
      .where(eq(schema.workItemAcceptanceCriteria.workItemId, haustuer)).all();
    expect(criteria.map((criterion) => criterion.text)).toEqual(["Tür ist montiert."]);
    expect(row(haustuer)!.reviewedAt).toBeNull();
    expect(cardStatus(card)).toBe("dismissed");
  });

  it("appends done-when text to task notes, preserving existing notes", async () => {
    const backup = await task("Backup prüfen", { notes: "Alt" });
    const card = await readyCard({ type: "task", id: backup });
    const response = await act(card, "add-done-when", { text: "Erledigt, wenn: PBS grün." });
    expect(response.statusCode, response.body).toBe(200);
    expect(row(backup)!.notes).toContain("Alt");
    expect(row(backup)!.notes).toContain("Erledigt, wenn: PBS grün.");
    expect(row(backup)!.reviewedAt).toBeNull();
    expect(cardStatus(card)).toBe("dismissed");
  });

  it("clarifies an admin step by renaming and appending notes together", async () => {
    const kur = await task("Kur-Nachweis");
    const card = await readyCard({ type: "task", id: kur });
    const response = await act(card, "clarify-admin", {
      title: "Kur-Nachweis an Minijob-Zentrale einreichen",
      notes: "Empfänger: Minijob-Zentrale",
      expectedRevision: row(kur)!.revision,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(row(kur)).toMatchObject({ title: "Kur-Nachweis an Minijob-Zentrale einreichen", notes: "Empfänger: Minijob-Zentrale", reviewedAt: null });
    expect(cardStatus(card)).toBe("dismissed");
  });

  it("clarifies an admin step with notes only", async () => {
    const kur = await task("Kur-Nachweis einreichen");
    const card = await readyCard({ type: "task", id: kur });
    const response = await act(card, "clarify-admin", { title: "Kur-Nachweis einreichen", notes: "Dokument: Nachweis" });
    expect(response.statusCode, response.body).toBe(200);
    expect(row(kur)).toMatchObject({ title: "Kur-Nachweis einreichen", notes: "Dokument: Nachweis" });
  });

  it("rejects a stale clarify-admin revision before writing anything", async () => {
    const kur = await task("Kur-Nachweis");
    const card = await readyCard({ type: "task", id: kur });
    const revision = row(kur)!.revision;
    await ctx.app.inject({ method: "PATCH", url: `/api/tasks/${kur}`, payload: { priority: 2 } });
    const response = await act(card, "clarify-admin", { notes: "Empfänger", expectedRevision: revision });
    expect(response.statusCode).toBe(409);
    expect(row(kur)!.notes).toBe("");
    expect(cardStatus(card)).toBe("ready");
  });

  it("rejects a card whose target changed type", async () => {
    const haustuer = await task("Haustür");
    const card = await readyCard({ type: "task", id: haustuer });
    const converted = await ctx.app.inject({ method: "POST", url: `/api/tasks/${haustuer}/convert-to-story`, payload: { status: "backlog" } });
    expect(converted.statusCode, converted.body).toBe(201);
    const response = await act(card, "rename", { title: "Neue Haustür" });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("cleanup_round_target_mismatch");
    expect(row(haustuer)!.title).toBe("Haustür");
    expect(cardStatus(card)).toBe("ready");
  });

  it("rejects already-handled cards and closed rounds", async () => {
    const keller = await task("Keller");
    const backup = await task("Backup");
    const card = await readyCard({ type: "task", id: keller });
    const other = ctx.handle.db.select().from(schema.cleanupRoundItems)
      .where(eq(schema.cleanupRoundItems.cleanupRoundId, card.roundId)).all()
      .find((item) => item.targetId === backup)!;

    expect((await act(card, "rename", { title: "Ecke sortieren" })).statusCode).toBe(200);
    const handled = await act(card, "rename", { title: "Noch einmal" });
    expect(handled.statusCode).toBe(409);
    expect(handled.json().error.code).toBe("cleanup_round_state_conflict");
    expect(row(keller)!.title).toBe("Ecke sortieren");

    await ctx.app.inject({ method: "POST", url: `/api/cleanup-rounds/${card.roundId}/dismiss`, payload: {} });
    const closed = await act({ roundId: card.roundId, itemId: other.id }, "rename", { title: "Backup-Status prüfen" });
    expect(closed.statusCode).toBe(409);
    expect(closed.json().error.code).toBe("cleanup_round_state_conflict");
    expect(row(backup)!.title).toBe("Backup");
  });

  it("rejects unknown cards, other viewers, and expired rounds", async () => {
    const keller = await task("Keller");
    const card = await readyCard({ type: "task", id: keller });
    expect((await act({ ...card, itemId: "missing" }, "rename", { title: "x" })).statusCode).toBe(404);
    const member = (await ctx.app.inject({ method: "POST", url: "/api/members", payload: { name: "Kim" } })).json().id as number;
    const foreign = await ctx.app.inject({
      method: "POST",
      url: `/api/cleanup-rounds/${card.roundId}/items/${card.itemId}/actions/rename`,
      headers: { "x-machbar-actor-member-id": String(member) },
      payload: { title: "Fremd" },
    });
    expect(foreign.statusCode).toBe(404);
    ctx.handle.db.update(schema.cleanupRounds).set({ expiresAt: "2000-01-01T00:00:00.000Z" })
      .where(eq(schema.cleanupRounds.id, card.roundId)).run();
    expect((await act(card, "rename", { title: "Abgelaufen" })).statusCode).toBe(410);
    expect(row(keller)!.title).toBe("Keller");
  });

  it("rolls the mutation back when the card cannot be dismissed", async () => {
    const keller = await task("Keller");
    const card = await readyCard({ type: "task", id: keller });
    ctx.handle.db.run(sql.raw(`
      CREATE TRIGGER fail_card_dismissal BEFORE UPDATE OF status ON cleanup_round_items
      WHEN NEW.status = 'dismissed' BEGIN SELECT RAISE(ABORT, 'dismissal failed'); END
    `));
    const response = await act(card, "create-task", { title: "Ecke sortieren", purpose: "firstSlice" });
    expect(response.statusCode).toBeGreaterThanOrEqual(500);
    expect(children(keller)).toHaveLength(0);
    const renamed = await act(card, "rename", { title: "Ecke sortieren" });
    expect(renamed.statusCode).toBeGreaterThanOrEqual(500);
    expect(row(keller)!.title).toBe("Keller");
    expect(cardStatus(card)).toBe("ready");
  });
});
