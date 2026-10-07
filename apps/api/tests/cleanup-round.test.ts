import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { cleanupProposalKinds, cleanupResolutionSurfaces } from "@machbar/shared";
import * as schema from "../src/db/schema.js";
import { Graph } from "../src/domain/graph.js";
import { projectContext, sampleCleanupCandidates, selectCleanupBatch, taskContext } from "../src/cleanupRound/sampler.js";
import { validateCleanupRoundResponse } from "../src/cleanupRound/validate.js";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

const OLD = "2026-01-01T00:00:00.000Z";

function triage(targetType: "task" | "project", targetId: number, overrides: Record<string, unknown> = {}) {
  return {
    targetType,
    targetId,
    proposal: "rename_for_actionability",
    resolutionSurface: "rename_item",
    inferredWorkType: "normal",
    inferredFlow: "uphill",
    confidence: "medium",
    reason: "Der Titel sagt nicht, was zu tun ist.",
    question: "Was genau ist der erste Schritt?",
    suggestedDefault: null,
    suggestedTitle: "Werkzeugkiste im Keller sortieren",
    suggestedShape: null,
    ...overrides,
  };
}

describe("cleanup response validation", () => {
  const sampled = [
    { targetType: "task" as const, targetId: 1 },
    { targetType: "project" as const, targetId: 2 },
  ];

  it("accepts a valid response and keeps sampled order", () => {
    const outcome = validateCleanupRoundResponse({
      summary: "Zwei Dinge",
      results: [triage("project", 2, { proposal: "clarify_goal", resolutionSurface: "edit_done_when" }), triage("task", 1)],
      warnings: [],
    }, sampled);
    expect(outcome.issues).toEqual([]);
    expect(outcome.response?.results.map((result) => result.targetId)).toEqual([1, 2]);
  });

  it("ignores unknown proposals, surfaces, IDs, and type mismatches with warnings", () => {
    const outcome = validateCleanupRoundResponse({
      summary: "x",
      results: [
        triage("task", 1, { proposal: "make_a_plan" }),
        triage("task", 1, { resolutionSurface: "auto_apply" }),
        triage("task", 99),
        triage("task", 2),
        triage("project", 2),
        "garbage",
      ],
      warnings: [],
    }, sampled);
    expect(outcome.response?.results.map((result) => result.targetId)).toEqual([2]);
    expect(outcome.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "schema_invalid",
      "unknown_target",
      "target_type_mismatch",
      "missing_target",
    ]));
    expect(outcome.missingTargets).toEqual([{ targetType: "task", targetId: 1 }]);
    expect(outcome.response!.warnings.length).toBeGreaterThan(0);
  });

  it.each([
    ["inferredWorkType", "chore"],
    ["inferredFlow", "sideways"],
    ["confidence", "certain"],
    ["suggestedShape", "checklist"],
    ["targetType", "story"],
  ])("rejects an unknown %s value now that Home Assistant passes vocabularies through", (field, value) => {
    const outcome = validateCleanupRoundResponse({
      summary: "x",
      results: [triage("task", 1, { [field]: value }), triage("project", 2)],
      warnings: [],
    }, sampled);
    expect(outcome.response?.results.map((result) => result.targetId)).toEqual([2]);
    expect(outcome.issues.some((issue) => issue.code === "schema_invalid")).toBe(true);
  });

  it("normalizes spelling and truncates excessive text", () => {
    const outcome = validateCleanupRoundResponse({
      summary: "s",
      results: [triage("task", 1, {
        targetId: "1",
        proposal: " Rename_For_Actionability ",
        reason: "x".repeat(2_000),
        suggestedDefault: "null",
        suggestedShape: "none",
      })],
      warnings: [{ message: "y".repeat(1_000) }],
    }, [sampled[0]!]);
    const [result] = outcome.response!.results;
    expect(result!.reason.length).toBeLessThanOrEqual(500);
    expect(result!.suggestedDefault).toBeNull();
    expect(result!.suggestedShape).toBeNull();
    expect(outcome.response!.warnings.every((warning) => warning.message.length <= 300)).toBe(true);
    expect(outcome.issues).toEqual([]);
  });

  it("rejects a response without results", () => {
    expect(validateCleanupRoundResponse({ summary: "x" }, sampled).response).toBeNull();
    expect(validateCleanupRoundResponse("nope", sampled).response).toBeNull();
  });
});

describe("cleanup rounds", () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = createTestContext(); });
  afterEach(async () => { await closeTestContext(ctx); });

  async function pair() {
    const code = (await ctx.app.inject({ method: "POST", url: "/api/integrations/home-assistant/pairing-code" })).json().code as string;
    const token = (await ctx.app.inject({
      method: "POST",
      url: "/api/integrations/home-assistant/pair",
      payload: { pairingCode: code, protocolVersion: 3 },
    })).json().token as string;
    await ctx.app.inject({
      method: "POST",
      url: "/api/integrations/home-assistant/context",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        protocolVersion: 3,
        observedAt: new Date().toISOString(),
        contexts: [],
        people: [],
        intake: {
          aiTask: { entityId: "ai_task.test", state: "ok", supportsAttachments: false },
          calendar: { entityId: null, state: "not_configured" },
        },
      },
    });
    return token;
  }

  async function task(title: string, extra: Record<string, unknown> = {}) {
    const response = await ctx.app.inject({ method: "POST", url: "/api/tasks", payload: { title, status: "actionable", ...extra } });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().id as number;
  }

  async function project(title: string, extra: Record<string, unknown> = {}) {
    const response = await ctx.app.inject({ method: "POST", url: "/api/projects", payload: { title, ...extra } });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().id as number;
  }

  function age(id: number, updatedAt = OLD, reviewedAt: string | null = null) {
    ctx.handle.db.update(schema.workItems).set({ updatedAt, reviewedAt }).where(eq(schema.workItems.id, id)).run();
  }

  async function lease(token: string) {
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/integrations/home-assistant/requests/next?protocolVersion=3&waitSeconds=0",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    return response.json() as { id: string; leaseToken: string; kind: string; payload: { cleanupRoundId: string; instructions: string; items: Array<{ targetType: "task" | "project"; targetId: number }> } };
  }

  async function complete(token: string, leased: { id: string; leaseToken: string }, body: Record<string, unknown>) {
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/integrations/home-assistant/requests/${leased.id}/complete`,
      headers: { authorization: `Bearer ${token}` },
      payload: { leaseToken: leased.leaseToken, ...body },
    });
    expect(response.statusCode, response.body).toBe(204);
  }

  async function createRound() {
    const response = await ctx.app.inject({ method: "POST", url: "/api/cleanup-rounds", payload: {} });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().id as string;
  }

  it("requires a connected Home Assistant", async () => {
    await task("Keller");
    const response = await ctx.app.inject({ method: "POST", url: "/api/cleanup-rounds", payload: {} });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("home_assistant_not_connected");
  });

  it("reports when nothing can be sampled", async () => {
    await pair();
    const response = await ctx.app.inject({ method: "POST", url: "/api/cleanup-rounds", payload: {} });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("cleanup_round_no_candidates");
  });

  it("samples open work only, skips recently reviewed items, and stores a pending job", async () => {
    const token = await pair();
    const keller = await task("Keller");
    const done = await task("Erledigt");
    await ctx.app.inject({ method: "POST", url: `/api/tasks/${done}/complete`, payload: {} });
    const reviewed = await task("Gerade angeschaut");
    age(reviewed, OLD, new Date().toISOString());
    const haustuer = await project("Haustür");
    const finished = await project("Fertig");
    ctx.handle.db.update(schema.workItems).set({ status: "done" }).where(eq(schema.workItems.id, finished)).run();
    const archived = await project("Archiv");
    ctx.handle.db.update(schema.workItems).set({ archivedAt: OLD }).where(eq(schema.workItems.id, archived)).run();
    age(keller);
    age(haustuer);

    const id = await createRound();
    const round = (await ctx.app.inject({ method: "GET", url: `/api/cleanup-rounds/${id}` })).json();
    expect(round.status).toBe("queued");
    const targets = round.items.map((item: { targetType: string; targetId: number }) => `${item.targetType}:${item.targetId}`);
    expect(targets).toEqual(expect.arrayContaining([`task:${keller}`, `project:${haustuer}`]));
    for (const excluded of [`task:${done}`, `task:${reviewed}`, `project:${finished}`, `project:${archived}`]) {
      expect(targets).not.toContain(excluded);
    }
    expect(round.items.every((item: { status: string }) => item.status === "pending")).toBe(true);

    const leased = await lease(token);
    expect(leased.kind).toBe("cleanup_round_analyze");
    expect(leased.payload.cleanupRoundId).toBe(id);
    expect(leased.payload.items).toHaveLength(round.items.length);
    expect(leased.payload.instructions).toContain("tired human");
    expect((await ctx.app.inject({ method: "GET", url: `/api/cleanup-rounds/${id}` })).json().status).toBe("analyzing");
  });

  it("does not resample items that are already in an active round", async () => {
    await pair();
    await task("Keller");
    await createRound();
    const response = await ctx.app.inject({ method: "POST", url: "/api/cleanup-rounds", payload: {} });
    expect(response.json().error.code).toBe("cleanup_round_no_candidates");
  });

  it.each(["dismissing the round", "resolving every card"])(
    "keeps failed items of a partial round reserved until %s",
    async (release) => {
      const token = await pair();
      const keller = await task("Keller");
      const backup = await task("Backup");
      const id = await createRound();
      await complete(token, await lease(token), {
        outcome: "succeeded",
        result: { summary: "x", results: [triage("task", keller)], warnings: [] },
      });
      const first = (await ctx.app.inject({ method: "GET", url: `/api/cleanup-rounds/${id}` })).json();
      expect(first.status).toBe("partial");
      const failed = first.items.find((item: { targetId: number }) => item.targetId === backup);
      expect(failed.status).toBe("failed");

      const blocked = await ctx.app.inject({ method: "POST", url: "/api/cleanup-rounds", payload: {} });
      expect(blocked.json().error.code).toBe("cleanup_round_no_candidates");

      if (release === "dismissing the round") {
        await ctx.app.inject({ method: "POST", url: `/api/cleanup-rounds/${id}/dismiss`, payload: {} });
      } else {
        for (const item of first.items as Array<{ id: string }>) {
          await ctx.app.inject({ method: "POST", url: `/api/cleanup-rounds/${id}/items/${item.id}/dismiss`, payload: {} });
        }
        expect((await ctx.app.inject({ method: "GET", url: `/api/cleanup-rounds/${id}` })).json().status).toBe("completed");
      }
      const next = (await ctx.app.inject({ method: "GET", url: `/api/cleanup-rounds/${await createRound()}` })).json();
      expect(next.items.map((item: { targetId: number }) => item.targetId)).toContain(backup);
    },
  );

  it("stores valid results as ready without mutating work items", async () => {
    const token = await pair();
    const keller = await task("Keller");
    const before = ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.id, keller)).get()!;
    const id = await createRound();
    const leased = await lease(token);
    await complete(token, leased, {
      outcome: "succeeded",
      result: { summary: "Eine Sache", results: [triage("task", keller)], warnings: [] },
    });
    const round = (await ctx.app.inject({ method: "GET", url: `/api/cleanup-rounds/${id}` })).json();
    expect(round.status).toBe("ready");
    expect(round.summary).toBe("Eine Sache");
    expect(round.items[0]).toMatchObject({ status: "ready", title: "Keller", result: { proposal: "rename_for_actionability" } });
    const after = ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.id, keller)).get()!;
    expect(after).toEqual(before);
    const stored = ctx.handle.db.select().from(schema.cleanupRounds).where(eq(schema.cleanupRounds.id, id)).get()!;
    expect(JSON.parse(stored.rawResponseJson!).summary).toBe("Eine Sache");
  });

  it("withdraws analysis when a round is dismissed so late results cannot revive it", async () => {
    const token = await pair();
    const keller = await task("Keller");
    const id = await createRound();
    const leased = await lease(token);
    const dismissed = await ctx.app.inject({ method: "POST", url: `/api/cleanup-rounds/${id}/dismiss`, payload: {} });
    expect(dismissed.json().status).toBe("dismissed");

    const late = await ctx.app.inject({
      method: "POST",
      url: `/api/integrations/home-assistant/requests/${leased.id}/complete`,
      headers: { authorization: `Bearer ${token}` },
      payload: { leaseToken: leased.leaseToken, outcome: "succeeded", result: { summary: "x", results: [triage("task", keller)], warnings: [] } },
    });
    expect(late.statusCode).toBe(409);
    expect((await ctx.app.inject({ method: "GET", url: `/api/cleanup-rounds/${id}` })).json().status).toBe("dismissed");
    // The dismissed round no longer reserves its items.
    await createRound();
  });

  it("marks partial responses, rejects unknown IDs, and retries with feedback", async () => {
    const token = await pair();
    const a = await task("Keller");
    const b = await task("Backup");
    const id = await createRound();
    const leased = await lease(token);
    await complete(token, leased, {
      outcome: "succeeded",
      result: { summary: "x", results: [triage("task", a), triage("task", 4242)], warnings: [] },
    });
    let round = (await ctx.app.inject({ method: "GET", url: `/api/cleanup-rounds/${id}` })).json();
    expect(round.status).toBe("partial");
    expect(round.items.find((item: { targetId: number }) => item.targetId === a).status).toBe("ready");
    expect(round.items.find((item: { targetId: number }) => item.targetId === b).status).toBe("failed");
    expect(round.warnings.some((warning: { message: string }) => warning.message.includes("4242"))).toBe(true);

    const retried = await ctx.app.inject({ method: "POST", url: `/api/cleanup-rounds/${id}/retry`, payload: {} });
    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json().status).toBe("queued");
    const second = await lease(token);
    expect(second.payload.instructions).toContain("unknown_target");
    // Only the failed item is re-analyzed; the accepted card is kept.
    expect(second.payload.items.map((item: { targetId: number }) => item.targetId)).toEqual([b]);
    await complete(token, second, {
      outcome: "succeeded",
      result: { summary: "y", results: [triage("task", b, { proposal: "define_check_or_rhythm", resolutionSurface: "define_rhythm_or_revisit" })], warnings: [] },
    });
    round = (await ctx.app.inject({ method: "GET", url: `/api/cleanup-rounds/${id}` })).json();
    expect(round.status).toBe("ready");
    expect(round.summary).toBe("x");
    expect(round.items.find((item: { targetId: number }) => item.targetId === a).result.proposal)
      .toBe("rename_for_actionability");
    expect(round.items.find((item: { targetId: number }) => item.targetId === b).result.proposal)
      .toBe("define_check_or_rhythm");
  });

  it("treats an incomplete entry from Home Assistant as one bad entry, not a failed round", async () => {
    const token = await pair();
    const a = await task("Keller");
    const b = await task("Backup");
    const id = await createRound();
    // Shape the HA adapter now forwards: a complete entry plus an entry with
    // only target fields (and strict-provider nulls).
    await complete(token, await lease(token), {
      outcome: "succeeded",
      result: {
        summary: "x",
        results: [triage("task", a), { targetType: "task", targetId: b, proposal: null, reason: null }],
        warnings: [],
      },
    });
    const round = (await ctx.app.inject({ method: "GET", url: `/api/cleanup-rounds/${id}` })).json();
    expect(round.status).toBe("partial");
    expect(round.error.details.issues.map((issue: { code: string }) => issue.code)).toContain("schema_invalid");
    expect(round.items.find((item: { targetId: number }) => item.targetId === a).status).toBe("ready");
    expect(round.items.find((item: { targetId: number }) => item.targetId === b).status).toBe("failed");
  });

  it("keeps accepted cards when retrying the missing items fails again", async () => {
    const token = await pair();
    const a = await task("Keller");
    const b = await task("Backup");
    const id = await createRound();
    await complete(token, await lease(token), {
      outcome: "succeeded",
      result: { summary: "x", results: [triage("task", a)], warnings: [] },
    });
    await ctx.app.inject({ method: "POST", url: `/api/cleanup-rounds/${id}/retry`, payload: {} });
    await complete(token, await lease(token), {
      outcome: "failed",
      error: { code: "ai_task_failed", message: "Timeout" },
    });
    let round = (await ctx.app.inject({ method: "GET", url: `/api/cleanup-rounds/${id}` })).json();
    expect(round.status).toBe("partial");
    expect(round.items.find((item: { targetId: number }) => item.targetId === a).status).toBe("ready");
    expect(round.items.find((item: { targetId: number }) => item.targetId === b).status).toBe("failed");

    await ctx.app.inject({ method: "POST", url: `/api/cleanup-rounds/${id}/retry`, payload: {} });
    await complete(token, await lease(token), {
      outcome: "succeeded",
      result: { summary: "y", results: [triage("task", 4242)], warnings: [] },
    });
    round = (await ctx.app.inject({ method: "GET", url: `/api/cleanup-rounds/${id}` })).json();
    expect(round.status).toBe("partial");
    expect(round.summary).toBe("x");

    const itemB = round.items.find((item: { targetId: number }) => item.targetId === b);
    await ctx.app.inject({ method: "POST", url: `/api/cleanup-rounds/${id}/items/${itemB.id}/dismiss`, payload: {} });
    const noFailed = await ctx.app.inject({ method: "POST", url: `/api/cleanup-rounds/${id}/retry`, payload: {} });
    expect(noFailed.statusCode).toBe(409);
    expect(noFailed.json().error.code).toBe("cleanup_round_state_conflict");
  });

  it("fails when no result is usable or the adapter fails", async () => {
    const token = await pair();
    await task("Keller");
    const id = await createRound();
    await complete(token, await lease(token), {
      outcome: "succeeded",
      result: { summary: "x", results: [triage("task", 999)], warnings: [] },
    });
    expect((await ctx.app.inject({ method: "GET", url: `/api/cleanup-rounds/${id}` })).json().status).toBe("failed");

    await ctx.app.inject({ method: "POST", url: `/api/cleanup-rounds/${id}/retry`, payload: {} });
    await complete(token, await lease(token), {
      outcome: "failed",
      error: { code: "unsupported_request", message: "Unsupported request" },
    });
    const round = (await ctx.app.inject({ method: "GET", url: `/api/cleanup-rounds/${id}` })).json();
    expect(round.status).toBe("failed");
    expect(round.error.code).toBe("unsupported_request");
  });

  it("marks the target reviewed, dismisses cards, and completes the round", async () => {
    const token = await pair();
    const keller = await task("Keller");
    const haustuer = await project("Haustür");
    const id = await createRound();
    await complete(token, await lease(token), {
      outcome: "succeeded",
      result: {
        summary: "x",
        results: [triage("task", keller), triage("project", haustuer, { proposal: "clarify_goal", resolutionSurface: "edit_done_when" })],
        warnings: [],
      },
    });
    const round = (await ctx.app.inject({ method: "GET", url: `/api/cleanup-rounds/${id}` })).json();
    const taskItem = round.items.find((item: { targetType: string }) => item.targetType === "task");
    const projectItem = round.items.find((item: { targetType: string }) => item.targetType === "project");

    const reviewed = await ctx.app.inject({ method: "POST", url: `/api/cleanup-rounds/${id}/items/${taskItem.id}/mark-reviewed`, payload: {} });
    expect(reviewed.statusCode, reviewed.body).toBe(200);
    expect(ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.id, keller)).get()!.reviewedAt).not.toBeNull();
    const again = await ctx.app.inject({ method: "POST", url: `/api/cleanup-rounds/${id}/items/${taskItem.id}/mark-reviewed`, payload: {} });
    expect(again.statusCode).toBe(409);

    const dismissed = await ctx.app.inject({ method: "POST", url: `/api/cleanup-rounds/${id}/items/${projectItem.id}/dismiss`, payload: {} });
    expect(dismissed.json().status).toBe("completed");
    expect(ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.id, haustuer)).get()!.reviewedAt).toBeNull();
  });

  it("hides rounds from other viewers", async () => {
    await pair();
    await task("Keller");
    const id = await createRound();
    const member = (await ctx.app.inject({ method: "POST", url: "/api/members", payload: { name: "Kim" } })).json().id as number;
    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/cleanup-rounds/${id}`,
      headers: { "x-machbar-actor-member-id": String(member) },
    });
    expect(response.statusCode).toBe(404);
  });

  it("caps the sample size and clusters per project", async () => {
    const big = await project("Großprojekt");
    for (let index = 0; index < 8; index += 1) await task(`Aufgabe ${index}`, { projectId: big });
    for (let index = 0; index < 6; index += 1) await task(`Lose Sache ${index}`);
    const graph = Graph.load(ctx.handle.db);
    const sample = sampleCleanupCandidates(graph, { scope: "household", excludedKeys: new Set(), random: () => 0.5 });
    expect(sample).toHaveLength(5);
    const inBig = sample.filter((item) => item.targetType === "project" ? item.targetId === big : graph.tasksById.get(item.targetId)?.projectId === big);
    expect(inBig.length).toBeLessThanOrEqual(2);
    expect(sample.some((item) => item.targetType === "project")).toBe(true);
    expect(sample.some((item) => item.targetType === "task")).toBe(true);
  });

  it("adds sparse planning context for open, waiting, done, next-action, and criteria evidence", async () => {
    const backup = await project("Backup Konzept");
    const open = await task("Restore-Test durchführen", { projectId: backup, notes: "Mit einer echten Sicherung testen." });
    const waiting = await task("Antwort Versicherung abwarten", { projectId: backup });
    ctx.handle.db.insert(schema.taskExternalWaits).values({
      taskId: waiting,
      waitingFor: "Versicherung",
      revisitDate: null,
    }).run();
    const done = await task("Angebote eingeholt", { projectId: backup });
    await ctx.app.inject({ method: "POST", url: `/api/tasks/${done}/complete`, payload: {} });
    await ctx.app.inject({ method: "POST", url: `/api/projects/${backup}/criteria`, payload: { text: "Restore-Test erfolgreich dokumentiert" } });

    const graph = Graph.load(ctx.handle.db);
    const context = projectContext(graph, backup)!;
    expect(context.planningContext?.currentNextAction).toMatchObject({ id: open, title: "Restore-Test durchführen" });
    expect(context.planningContext?.openChildren).toContainEqual(expect.objectContaining({ title: "Restore-Test durchführen" }));
    expect(context.planningContext?.waitingChildren).toContainEqual(expect.objectContaining({
      title: "Antwort Versicherung abwarten",
      externalWait: expect.objectContaining({ label: "Versicherung" }),
    }));
    expect(context.planningContext?.doneChildren?.map((child) => child.title)).toContain("Angebote eingeholt");
    expect(context.planningContext?.existingAcceptanceCriteria).toEqual(["Restore-Test erfolgreich dokumentiert"]);
    expect(context.planningContext?.openChildren?.length).toBeLessThanOrEqual(8);
    expect(context.planningContext?.waitingChildren?.length).toBeLessThanOrEqual(5);
    expect(context.planningContext?.doneChildren?.length).toBeLessThanOrEqual(5);

    const serialized = JSON.stringify(context.planningContext);
    expect(serialized).not.toContain('"dueDate":null');
    expect(serialized).not.toContain('"blocked":false');
    expect(serialized).not.toContain('"openChildren":[]');
    expect(serialized).not.toContain('"externalWait":{}');
  });

  it("omits planning context when there is no useful structured evidence", async () => {
    const id = await task("Klarer Einzelschritt");
    const context = taskContext(Graph.load(ctx.handle.db), Graph.load(ctx.handle.db).tasksById.get(id)!);
    expect(context.planningContext).toBeUndefined();
  });

  it("keeps the cluster cap when swapping in the missing shape", () => {
    const candidate = (targetType: "task" | "project", cluster: string, score: number) =>
      ({ targetType, cluster, score });
    // Two tasks already fill project:1; the only project candidate is project 1
    // itself, so replacing the last (unrelated) task would put three items in
    // that cluster.
    const batch = selectCleanupBatch([
      candidate("task", "project:1", 10),
      candidate("task", "project:1", 9),
      candidate("task", "task:3", 8),
      candidate("task", "task:4", 7),
      candidate("project", "project:1", 1),
    ], 4);
    const perCluster = new Map<string, number>();
    for (const picked of batch) perCluster.set(picked.cluster, (perCluster.get(picked.cluster) ?? 0) + 1);
    expect(Math.max(...perCluster.values())).toBeLessThanOrEqual(2);
    expect(batch).toHaveLength(4);
    // The swap evicts a same-cluster task instead, keeping the batch mixed.
    expect(batch.some((picked) => picked.targetType === "project")).toBe(true);
    expect(batch.filter((picked) => picked.cluster === "project:1")).toHaveLength(2);
  });

  it("evicts a same-cluster pick when that is the only swap within the cap", () => {
    const batch = selectCleanupBatch([
      { targetType: "task" as const, cluster: "project:1", score: 10 },
      { targetType: "task" as const, cluster: "project:1", score: 9 },
      { targetType: "project" as const, cluster: "project:1", score: 1 },
    ], 2);
    expect(batch.map((picked) => picked.targetType)).toEqual(["task", "project"]);
    expect(batch.filter((picked) => picked.cluster === "project:1")).toHaveLength(2);
  });

  it("exposes a closed vocabulary", () => {
    expect(cleanupProposalKinds).toContain("leave_alone");
    expect(cleanupResolutionSurfaces).toContain("mark_reviewed");
  });
});
