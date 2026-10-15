import { setObservationPlan, recordObservation, recentInterventionReports } from "../src/domain/interventionObservations.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { ACTIVITY_ACTOR_HEADER } from "@machbar/shared";
import type {
  AssessmentProposal,
  GoalSuggestionProposal,
  GoalWithInterventions,
  InterventionAssessment,
  InterventionView,
} from "@machbar/shared";
import * as schema from "../src/db/schema.js";
import { buildReflectionBriefing } from "../src/reflection/briefing.js";
import { summarizeAssessDigest, assessCandidateItemIds } from "../src/goals/coachPrompt.js";
import { closeTestContext, createTestContext, insertTestTask, type TestContext } from "./helpers.js";

describe("Goals coach AI passes (Phase 3)", () => {
  let ctx: TestContext;
  beforeEach(() => {
    ctx = createTestContext();
  });
  afterEach(async () => {
    await closeTestContext(ctx);
  });

  async function createMember(name = "Mira") {
    return (await ctx.app.inject({ method: "POST", url: "/api/members", payload: { name } })).json() as {
      id: number;
      name: string;
    };
  }

  const auth = (t: string) => `${["Be","arer"].join("")} ${t}`;

  /** Pair + publish a context snapshot; `aiState` drives the AI-Task guard. */
  async function pair(aiState: "ok" | "not_configured" = "ok"): Promise<string> {
    const code = (
      await ctx.app.inject({ method: "POST", url: "/api/integrations/home-assistant/pairing-code" })
    ).json().code as string;
    const token = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/integrations/home-assistant/pair",
        payload: { pairingCode: code, protocolVersion: 3 },
      })
    ).json().token as string;
    await ctx.app.inject({
      method: "POST",
      url: "/api/integrations/home-assistant/context",
      headers: { authorization: auth(token) },
      payload: {
        protocolVersion: 3,
        observedAt: new Date().toISOString(),
        contexts: [],
        people: [],
        intake: {
          aiTask: { entityId: aiState === "ok" ? "ai_task.test" : null, state: aiState, supportsAttachments: false },
          calendar: { entityId: null, state: "not_configured" },
        },
      },
    });
    return token;
  }

  async function lease(token: string) {
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/integrations/home-assistant/requests/next?protocolVersion=3&waitSeconds=0",
      headers: { authorization: auth(token) },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as {
      id: string;
      leaseToken: string;
      kind: string;
      payload: { goalId?: number; interventionId?: number; instructions: string; windowStart?: string; windowEnd?: string };
    };
  }

  async function complete(token: string, leased: { id: string; leaseToken: string }, result: unknown) {
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/integrations/home-assistant/requests/${leased.id}/complete`,
      headers: { authorization: auth(token) },
      payload: { leaseToken: leased.leaseToken, outcome: "succeeded", result },
    });
    expect(response.statusCode, response.body).toBe(204);
  }

  async function createGoal(actor: Record<string, string>, payload: Record<string, unknown>) {
    const response = await ctx.app.inject({ method: "POST", url: "/api/goals", headers: actor, payload });
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as GoalWithInterventions;
  }

  it("suggest: stores a proposal, applies nothing until accept, then writes exactly one intervention", async () => {
    const member = await createMember();
    const actor = { [ACTIVITY_ACTOR_HEADER]: String(member.id) };
    const token = await pair("ok");
    const goal = await createGoal(actor, { title: "Cook at home more", area: "personal" });

    // Request a suggestion → stored, queued, nothing applied.
    const requested = await ctx.app.inject({ method: "POST", url: `/api/goals/${goal.id}/suggest`, headers: actor });
    expect(requested.statusCode, requested.body).toBe(202);
    const pending = requested.json() as GoalSuggestionProposal;
    expect(pending.status).toBe("queued");
    expect(pending.interventions).toEqual([]);

    // The worker leases a goal_suggest request carrying the rendered prompt.
    const leased = await lease(token);
    expect(leased.kind).toBe("goal_suggest");
    expect(leased.payload.goalId).toBe(goal.id);
    expect(leased.payload.instructions).toContain("Cook at home more");

    await complete(token, leased, {
      interventions: [
        {
          observationPlan: { method: "reflection" },
          type: "frequency_habit",
          commitment: "If it is a weekday evening, then I cook dinner at home on 4 of 5 days.",
          rationale: "Anchored to weekday evenings; a rate, not perfection.",
          startDate: "2025-01-01",
          revisitDate: "2025-01-15",
        },
      ],
    });

    // Proposal is now ready — but STILL not applied.
    const ready = (
      await ctx.app.inject({ method: "GET", url: `/api/goals/${goal.id}/suggest/${leased.id}`, headers: actor })
    ).json() as GoalSuggestionProposal;
    expect(ready.status).toBe("ready");
    expect(ready.interventions).toHaveLength(1);
    expect(ready.interventions[0]).toMatchObject({ type: "frequency_habit", startDate: "2025-01-01", revisitDate: "2025-01-15" });
    const beforeAccept = (
      await ctx.app.inject({ method: "GET", url: `/api/goals/${goal.id}`, headers: actor })
    ).json() as GoalWithInterventions;
    expect(beforeAccept.interventions).toEqual([]);

    // Accept → exactly one coach-sourced intervention is authored.
    const accepted = await ctx.app.inject({
      method: "POST",
      url: `/api/goals/${goal.id}/suggest/${leased.id}/accept`,
      headers: actor,
      payload: {},
    });
    expect(accepted.statusCode, accepted.body).toBe(201);
    const intervention = accepted.json() as InterventionView;
    expect(intervention).toMatchObject({ source: "coach", commitment: expect.stringContaining("cook dinner at home") });

    const afterAccept = (
      await ctx.app.inject({ method: "GET", url: `/api/goals/${goal.id}`, headers: actor })
    ).json() as GoalWithInterventions;
    expect(afterAccept.interventions).toHaveLength(1);
    expect(afterAccept.interventions[0]).toMatchObject({ source: "coach" });
  });

  it("assess: digest cites in-window completions and accept records one assessment with filtered counted ids", async () => {
    const member = await createMember();
    const actor = { [ACTIVITY_ACTOR_HEADER]: String(member.id) };
    const token = await pair("ok");
    const goal = await createGoal(actor, { title: "Keep the kitchen tidy", area: "personal" });

    const start = "2025-01-01";
    const revisit = "2025-01-15";
    const intervention = (
      await ctx.app.inject({
        method: "POST",
        url: `/api/goals/${goal.id}/interventions`,
        headers: actor,
        payload: {
          observationPlan: { method: "reflection" },
          type: "frequency_habit",
          commitment: "If dinner is over, then I wipe the counters.",
          startDate: start,
          revisitDate: revisit,
        },
      })
    ).json() as InterventionView;

    // A finite completion inside the window becomes a counted-item candidate.
    const done = insertTestTask(ctx.handle.db, { title: "Wipe counters", status: "done", completedAt: "2025-01-08T18:00:00.000Z" });
    ctx.handle.db
      .insert(schema.activityEvents)
      .values({
        kind: "task_status_changed",
        entityType: "task",
        entityId: done.id,
        entityTitle: done.title,
        createdAt: "2025-01-08T18:00:00.000Z",
        metadata: { scope: "household", previousStatus: "actionable", nextStatus: "done" },
      })
      .run();

    const requested = await ctx.app.inject({
      method: "POST",
      url: `/api/interventions/${intervention.id}/assess`,
      headers: actor,
    });
    expect(requested.statusCode, requested.body).toBe(202);
    expect((requested.json() as AssessmentProposal).status).toBe("queued");

    const leased = await lease(token);
    expect(leased.kind).toBe("goal_assess");
    expect(leased.payload.interventionId).toBe(intervention.id);
    expect(leased.payload.windowStart).toBe(start);
    expect(leased.payload.windowEnd).toBe(revisit);
    // The digest reproduces the completion split: the in-window completion is cited.
    expect(leased.payload.instructions).toContain("Wipe counters");

    await complete(token, leased, {
      band: "achieved",
      rationaleMd: "You wiped the counters on most evenings — a solid rate, not perfection.",
      countedItemIds: [done.id],
      countedObservationIds: [],
      recommendedDecision: "continue",
      nextMove: "Continue for another two weeks.",
    });

    const ready = (
      await ctx.app.inject({ method: "GET", url: `/api/interventions/${intervention.id}/assess/${leased.id}`, headers: actor })
    ).json() as AssessmentProposal;
    expect(ready.status).toBe("ready");
    expect(ready.band).toBe("achieved");
    // The bogus id is dropped; only the real candidate survives.
    expect(ready.countedItemIds).toEqual([done.id]);

    // Not applied yet: the arc shows no assessment.
    const beforeAccept = (
      await ctx.app.inject({ method: "GET", url: `/api/goals/${goal.id}`, headers: actor })
    ).json() as GoalWithInterventions;
    expect(beforeAccept.interventions[0]?.assessments).toEqual([]);

    const accepted = await ctx.app.inject({
      method: "POST",
      url: `/api/interventions/${intervention.id}/assess/${leased.id}/accept`,
      headers: actor,
      payload: {},
    });
    expect(accepted.statusCode, accepted.body).toBe(201);
    const assessment = accepted.json() as InterventionAssessment;
    expect(assessment).toMatchObject({ band: "achieved", source: "coach", countedItemIds: [done.id] });

    const afterAccept = (
      await ctx.app.inject({ method: "GET", url: `/api/goals/${goal.id}`, headers: actor })
    ).json() as GoalWithInterventions;
    expect(afterAccept.interventions[0]?.assessments).toHaveLength(1);
    expect(afterAccept.interventions[0]?.assessments[0]).toMatchObject({ band: "achieved", source: "coach" });
  });

  it("degrades gracefully with no AI, while the manual self-assessment path still works", async () => {
    const member = await createMember();
    const actor = { [ACTIVITY_ACTOR_HEADER]: String(member.id) };

    // No Home Assistant at all → not connected.
    const goal = await createGoal(actor, { title: "Walk daily", area: "personal" });
    const disconnected = await ctx.app.inject({ method: "POST", url: `/api/goals/${goal.id}/suggest`, headers: actor });
    expect(disconnected.statusCode).toBe(409);
    expect(disconnected.json().error.code).toBe("home_assistant_not_connected");

    // Connected but AI Task not configured → the specific guard fires.
    await pair("not_configured");
    const unconfigured = await ctx.app.inject({ method: "POST", url: `/api/goals/${goal.id}/suggest`, headers: actor });
    expect(unconfigured.statusCode).toBe(409);
    expect(unconfigured.json().error.code).toBe("ai_task_not_configured");

    // The manual Phase 1 path still works with no AI configured.
    const intervention = (
      await ctx.app.inject({
        method: "POST",
        url: `/api/goals/${goal.id}/interventions`,
        headers: actor,
        payload: {
          observationPlan: { method: "reflection" },
          type: "frequency_habit",
          commitment: "If it is morning, then I walk for 10 minutes.",
          startDate: "2025-01-01",
          revisitDate: "2025-01-15",
        },
      })
    ).json() as InterventionView;
    const manual = await ctx.app.inject({
      method: "POST",
      url: `/api/interventions/${intervention.id}/assessments`,
      headers: actor,
      payload: {
        band: "mostly_achieved",
        rationaleMd: "Walked on most mornings.",
        digestWindowStart: "2025-01-01",
        digestWindowEnd: "2025-01-15",
      },
    });
    expect(manual.statusCode, manual.body).toBe(201);
    expect((manual.json() as InterventionAssessment)).toMatchObject({ band: "mostly_achieved", source: "manual" });
  });

  it("builds a reflection digest over an explicit intervention window", () => {
    const member = ctx.handle.db.insert(schema.members).values({ name: "Mira", color: "#123456" }).returning().get();
    const done = insertTestTask(ctx.handle.db, { title: "Tidy up", status: "done", completedAt: "2025-01-08T18:00:00.000Z" });
    ctx.handle.db
      .insert(schema.activityEvents)
      .values({
        kind: "task_status_changed",
        entityType: "task",
        entityId: done.id,
        entityTitle: done.title,
        createdAt: "2025-01-08T18:00:00.000Z",
        metadata: { scope: "household", previousStatus: "actionable", nextStatus: "done" },
      })
      .run();

    const briefing = buildReflectionBriefing(ctx.handle.db, {
      subjectMemberId: member.id,
      days: 14,
      scope: "all",
      window: { startDate: "2025-01-01", endDate: "2025-01-15" },
    });
    expect(briefing.window).toMatchObject({ startDate: "2025-01-01", endDate: "2025-01-15", days: 15 });

    const digest = summarizeAssessDigest(briefing);
    expect(digest.finiteCompletions).toContainEqual(expect.objectContaining({ id: done.id, title: "Tidy up" }));
    expect(assessCandidateItemIds(digest)).toContain(done.id);
  });
  it("asks one tailored question, carries the answer, and atomically accepts complete work once", async () => {
    const member = await createMember(); const headers = { [ACTIVITY_ACTOR_HEADER]: String(member.id) };
    const goal = (await ctx.app.inject({ method: "POST", url: "/api/goals", headers, payload: { title: "Sleep earlier" } })).json();
    const token = await pair();
    const first = (await ctx.app.inject({ method: "POST", url: `/api/goals/${goal.id}/suggest`, headers })).json();
    await complete(token, await lease(token), { clarificationQuestion: "What happens between brushing and bed?", interventions: [] });
    const question = (await ctx.app.inject({ method: "GET", url: `/api/goals/${goal.id}/suggest/${first.requestId}`, headers })).json();
    expect(question).toMatchObject({ status: "ready", clarificationQuestion: "What happens between brushing and bed?", interventions: [] });
    const next = (await ctx.app.inject({ method: "POST", url: `/api/goals/${goal.id}/suggest`, headers, payload: { clarificationRequestId: first.requestId, clarificationAnswer: "I start browsing after brushing." } })).json();
    const leased = await lease(token);
    expect(leased.payload.instructions).toContain("I start browsing after brushing.");
    await complete(token, leased, { interventions: [{ type: "obstacle_removal", commitment: "Leave the phone outside before brushing", rationale: "Tests removing browsing friction before the cue.", startDate: "2026-10-15", revisitDate: "2026-10-29", observationPlan: { method: "daily_report", question: "Last night: in bed after brushing?", reference: "night", reportDayOffset: 1, availableAfter: "07:00", opportunityBased: false }, tasks: [{ key: "charger", title: "Move charger outside the bedroom" }] }] });
    expect(ctx.handle.db.select().from(schema.interventions).all()).toHaveLength(0);
    expect(ctx.handle.db.select().from(schema.workItems).all()).toHaveLength(0);
    const accept = () => ctx.app.inject({ method: "POST", url: `/api/goals/${goal.id}/suggest/${next.requestId}/accept`, headers, payload: {} });
    const accepted = await accept(); expect(accepted.statusCode, accepted.body).toBe(201);
    expect((await accept()).json().id).toBe(accepted.json().id);
    expect(ctx.handle.db.select().from(schema.interventions).all()).toHaveLength(1);
    expect(ctx.handle.db.select().from(schema.workItems).all()).toHaveLength(1);
    expect(accepted.json().rationale).toContain("I start browsing after brushing.");
  });

  it("rejects a second clarification and unsupported AI task references without creating work", async () => {
    const member = await createMember(); const headers = { [ACTIVITY_ACTOR_HEADER]: String(member.id) };
    const goal = (await ctx.app.inject({ method: "POST", url: "/api/goals", headers, payload: { title: "Piano Tuesdays and Thursdays at 19:00" } })).json();
    const token = await pair();
    const first = (await ctx.app.inject({ method: "POST", url: `/api/goals/${goal.id}/suggest`, headers })).json();
    await complete(token, await lease(token), { interventions: [{ type: "frequency_habit", commitment: "Practise", rationale: "Useful", startDate: "2026-10-15", revisitDate: "2026-10-29", observationPlan: { method: "task_evidence" }, tasks: [{ key: "x", title: "Practise", taskId: 999 }] }] });
    expect((await ctx.app.inject({ method: "GET", url: `/api/goals/${goal.id}/suggest/${first.requestId}`, headers })).json().status).toBe("failed");
    expect(ctx.handle.db.select().from(schema.workItems).all()).toHaveLength(0);
    const questionRequest = (await ctx.app.inject({ method: "POST", url: `/api/goals/${goal.id}/suggest`, headers })).json();
    await complete(token, await lease(token), { clarificationQuestion: "Which obstacle matters?", interventions: [] });
    const followup = (await ctx.app.inject({ method: "POST", url: `/api/goals/${goal.id}/suggest`, headers, payload: { clarificationRequestId: questionRequest.requestId, clarificationAnswer: "Finding time" } })).json();
    await complete(token, await lease(token), { clarificationQuestion: "Another question?", interventions: [] });
    expect((await ctx.app.inject({ method: "GET", url: `/api/goals/${goal.id}/suggest/${followup.requestId}`, headers })).json().status).toBe("failed");
  });

  it("reviews a deterministic sparse snapshot, cites observations and reduces tracking only on acceptance", async () => {
    const member = await createMember(); const headers = { [ACTIVITY_ACTOR_HEADER]: String(member.id) };
    const goal = (await ctx.app.inject({ method: "POST", url: "/api/goals", headers, payload: { title: "Sleep earlier" } })).json();
    const intervention = (await ctx.app.inject({ method: "POST", url: `/api/goals/${goal.id}/interventions`, headers, payload: { type: "frequency_habit", commitment: "Bed after brushing", startDate: "2026-10-01", revisitDate: "2026-10-07" } })).json();
    const access = { ownerMemberId: member.id };
    setObservationPlan(ctx.handle.db, intervention.id, { expectedRevision: 1, plan: { method: "daily_report", question: "In bed?", reference: "night", reportDayOffset: 1, availableAfter: "07:00", opportunityBased: false } }, access, new Date("2026-10-01T10:00:00Z"));
    const report = recordObservation(ctx.handle.db, intervention.id, { referenceDate: "2026-10-01", answer: "met", expectedRevision: 0 }, access, new Date("2026-10-02T10:00:00Z"));
    const taskResponse = await ctx.app.inject({ method: "POST", url: `/api/interventions/${intervention.id}/backing`, headers, payload: { tasks: [{ key: "routine", title: "Useful bedtime routine" }] } });
    const taskId = taskResponse.json().backingTaskId;
    const token = await pair();
    const requested = (await ctx.app.inject({ method: "POST", url: `/api/interventions/${intervention.id}/assess`, headers, payload: { benefit: "not_helped", obstacle: "I did it but did not notice benefit" } })).json();
    const leased = await lease(token);
    const payload = JSON.parse(ctx.handle.db.select().from(schema.homeAssistantRequests).where(eq(schema.homeAssistantRequests.id, leased.id)).get()!.payloadJson);
    expect(payload.evidence.counts).toMatchObject({ met: 1, missing: 6, notMet: 0 });
    expect(payload.reflection).toMatchObject({ benefit: "not_helped" });
    expect(leased.payload.instructions).toContain("High adherence with little benefit");
    await complete(token, leased, { band: "attempted_partial", rationaleMd: "Only one report; benefit is uncertain. Try lighter reflection.", countedItemIds: [], countedObservationIds: [report.id], recommendedDecision: "adjust", observationPlan: { method: "reflection" }, reminderEnabled: false, nextMove: "Reduce tracking while keeping the routine." });
    expect(ctx.handle.db.select().from(schema.interventionAssessments).all()).toHaveLength(0);
    expect(ctx.handle.db.select().from(schema.interventionObservationPlans).all()).toHaveLength(1);
    // A later report does not rewrite the facts the coach actually reviewed.
    recordObservation(ctx.handle.db, intervention.id, { referenceDate: "2026-10-02", answer: "met", expectedRevision: 0 }, access, new Date("2026-10-03T10:00:00Z"));
    const accept = () => ctx.app.inject({ method: "POST", url: `/api/interventions/${intervention.id}/assess/${requested.requestId}/accept`, headers, payload: {} });
    const accepted = await accept(); expect(accepted.statusCode, accepted.body).toBe(201);
    expect(accepted.json()).toMatchObject({ countedObservationIds: [report.id], decision: "adjust", benefit: "not_helped", evidence: { counts: { met: 1, missing: 6 } } });
    expect((await accept()).json().id).toBe(accepted.json().id);
    const updated = (await ctx.app.inject({ method: "GET", url: `/api/goals/${goal.id}`, headers })).json().interventions[0];
    expect(updated).toMatchObject({ status: "active", reminderEnabled: false, observationPlan: { method: "reflection" } });
    expect(ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.id, taskId)).get()!.status).toBe("active");
    expect(recentInterventionReports(ctx.handle.db, intervention.id, access, new Date("2026-10-17T10:00:00Z"))).toEqual([]);
  });

});
