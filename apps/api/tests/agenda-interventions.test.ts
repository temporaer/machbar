import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACTIVITY_ACTOR_HEADER } from "@machbar/shared";
import type {
  Agenda,
  GoalWithInterventions,
  Intervention,
} from "@machbar/shared";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

/**
 * Phase 2 Heute intervention focus: the running/finished sibling section is a
 * read-time projection over the Phase 1 journal. It must classify running vs
 * review-window interventions by the household date, respect owner/scope, drop
 * reviewed ones, and never leak into the derived Review queue.
 */
describe("Agenda intervention focus (Phase 2)", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await closeTestContext(ctx);
  });

  async function createMember(name = "Mira") {
    return (
      await ctx.app.inject({ method: "POST", url: "/api/members", payload: { name } })
    ).json() as { id: number; name: string };
  }

  async function createGoal(
    memberId: number,
    payload: Record<string, unknown>,
  ): Promise<GoalWithInterventions> {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/goals",
      headers: { [ACTIVITY_ACTOR_HEADER]: String(memberId) },
      payload,
    });
    expect(res.statusCode).toBe(201);
    return res.json() as GoalWithInterventions;
  }

  async function startIntervention(
    memberId: number,
    goalId: number,
    payload: Record<string, unknown>,
  ): Promise<Intervention> {
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/goals/${goalId}/interventions`,
      headers: { [ACTIVITY_ACTOR_HEADER]: String(memberId) },
      payload,
    });
    expect(res.statusCode).toBe(201);
    return res.json() as Intervention;
  }

  async function agenda(
    memberId: number | undefined,
    scope: "mine" | "all" | "work",
    date: string,
  ): Promise<Agenda> {
    const params = new URLSearchParams({ scope, date });
    if (memberId !== undefined) params.set("memberId", String(memberId));
    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/agenda/today?${params.toString()}`,
    });
    expect(res.statusCode).toBe(200);
    return res.json() as Agenda;
  }

  it("surfaces a running experiment with period progress, then the review window, then drops it", async () => {
    const member = await createMember();
    const goal = await createGoal(member.id, {
      title: "Run a half marathon",
      scope: "work",
    });
    const intervention = await startIntervention(member.id, goal.id, {
      type: "frequency_habit",
      commitment: "Run three times a week",
      startDate: "2026-01-01",
      revisitDate: "2026-01-15",
    });

    // Mid-window: running, "Tag 10 von 14".
    const running = await agenda(member.id, "work", "2026-01-10");
    expect(running.interventions.running).toHaveLength(1);
    expect(running.interventions.review).toHaveLength(0);
    expect(running.interventions.running[0]).toMatchObject({
      interventionId: intervention.id,
      goalTitle: "Run a half marathon",
      commitment: "Run three times a week",
      periodDay: 10,
      periodLength: 14,
      derivedState: "running",
    });

    // On the revisit date: finished + unreviewed, inside the 7-day window.
    const review = await agenda(member.id, "work", "2026-01-15");
    expect(review.interventions.running).toHaveLength(0);
    expect(review.interventions.review).toHaveLength(1);
    expect(review.interventions.review[0]).toMatchObject({
      interventionId: intervention.id,
      derivedState: "finished",
      withinReviewWindow: true,
    });

    // Still visible on the last day of the window (revisit + 7).
    const lastDay = await agenda(member.id, "work", "2026-01-22");
    expect(lastDay.interventions.review).toHaveLength(1);

    // One day later it drops off Heute entirely.
    const demoted = await agenda(member.id, "work", "2026-01-23");
    expect(demoted.interventions.running).toHaveLength(0);
    expect(demoted.interventions.review).toHaveLength(0);
  });

  it("drops the experiment from Heute once it has been reviewed", async () => {
    const member = await createMember();
    const goal = await createGoal(member.id, { title: "Sleep earlier", scope: "work" });
    const intervention = await startIntervention(member.id, goal.id, {
      type: "frequency_habit",
      commitment: "Lights out by 23:00",
      startDate: "2026-02-01",
      revisitDate: "2026-02-10",
    });

    const assessRes = await ctx.app.inject({
      method: "POST",
      url: `/api/interventions/${intervention.id}/assessments`,
      headers: { [ACTIVITY_ACTOR_HEADER]: String(member.id) },
      payload: {
        band: "mostly_achieved",
        rationaleMd: "Most nights worked.",
        digestWindowStart: "2026-02-01",
        digestWindowEnd: "2026-02-10",
      },
    });
    expect(assessRes.statusCode).toBe(201);

    // Within the window but already reviewed → gone from both buckets.
    const reviewed = await agenda(member.id, "work", "2026-02-11");
    expect(reviewed.interventions.running).toHaveLength(0);
    expect(reviewed.interventions.review).toHaveLength(0);
  });

  it("scopes the section by owner and goal scope", async () => {
    const owner = await createMember("Owner");
    const other = await createMember("Other");

    const workGoal = await createGoal(owner.id, { title: "Work goal", scope: "work" });
    await startIntervention(owner.id, workGoal.id, {
      type: "frequency_habit",
      commitment: "Work commitment",
      startDate: "2026-03-01",
      revisitDate: "2026-03-20",
    });

    const householdGoal = await createGoal(owner.id, {
      title: "Household goal",
      scope: "household",
    });
    await startIntervention(owner.id, householdGoal.id, {
      type: "frequency_habit",
      commitment: "Household commitment",
      startDate: "2026-03-01",
      revisitDate: "2026-03-20",
    });

    // Owner's work view: only the work goal.
    const work = await agenda(owner.id, "work", "2026-03-05");
    expect(work.interventions.running.map((i) => i.goalTitle)).toEqual(["Work goal"]);

    // Owner's household ("mine") view: only the household goal.
    const mine = await agenda(owner.id, "mine", "2026-03-05");
    expect(mine.interventions.running.map((i) => i.goalTitle)).toEqual(["Household goal"]);

    // Household-wide "all" view: every owner's household goals, not work goals.
    const all = await agenda(undefined, "all", "2026-03-05");
    expect(all.interventions.running.map((i) => i.goalTitle)).toEqual(["Household goal"]);

    // A different member's work view sees none of the owner's experiments.
    const otherWork = await agenda(other.id, "work", "2026-03-05");
    expect(otherWork.interventions.running).toHaveLength(0);
  });

  it("keeps interventions out of the derived Review queue", async () => {
    const member = await createMember();
    const goal = await createGoal(member.id, { title: "Journal daily", scope: "work" });
    await startIntervention(member.id, goal.id, {
      type: "frequency_habit",
      commitment: "Write one line each night",
      startDate: "2026-04-01",
      revisitDate: "2026-04-10",
    });

    const res = await ctx.app.inject({ method: "GET", url: "/api/review" });
    expect(res.statusCode).toBe(200);
    const body = JSON.stringify(res.json());
    expect(body).not.toContain("Write one line each night");
    expect(body).not.toContain("Journal daily");
  });
});
