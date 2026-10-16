import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACTIVITY_ACTOR_HEADER } from "@machbar/shared";
import type {
  GoalWithInterventions,
  Intervention,
  InterventionAssessment,
  InterventionView,
} from "@machbar/shared";
import { householdToday } from "../src/domain/householdCalendar.js";
import { createMachbarMcpServer } from "../src/mcp/tools.js";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

describe("Goals & interventions (Phase 1)", () => {
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

  async function connectMcp(memberId: number, scope: "household" | "work" = "work") {
    const server = createMachbarMcpServer({ db: ctx.handle.db, memberId, scope });
    const client = new Client({ name: "test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return { client, server };
  }

  it("runs the manual REST arc: create goal → author intervention → conclude → self-assess → read back", async () => {
    const member = await createMember();
    const actor = { [ACTIVITY_ACTOR_HEADER]: String(member.id) };

    // Create a goal.
    const createRes = await ctx.app.inject({
      method: "POST",
      url: "/api/goals",
      headers: actor,
      payload: { title: "Run a half marathon", notes: "Spring race", area: "work" },
    });
    expect(createRes.statusCode).toBe(201);
    const goal = createRes.json() as GoalWithInterventions;
    expect(goal).toMatchObject({
      revision: 1,
      status: "active",
      title: "Run a half marathon",
      notes: "Spring race",
      ownerMemberId: member.id,
      area: "work",
      interventions: [],
    });

    // Patch title with optimistic concurrency.
    const patchRes = await ctx.app.inject({
      method: "PATCH",
      url: `/api/goals/${goal.id}`,
      headers: actor,
      payload: { title: "Run a half marathon in spring", expectedRevision: 1 },
    });
    expect(patchRes.statusCode).toBe(200);
    expect((patchRes.json() as GoalWithInterventions).revision).toBe(2);

    // A stale write is rejected.
    const stale = await ctx.app.inject({
      method: "PATCH",
      url: `/api/goals/${goal.id}`,
      headers: actor,
      payload: { title: "Too late", expectedRevision: 1 },
    });
    expect(stale.statusCode).toBe(409);
    expect((stale.json() as { error: { code: string } }).error.code).toBe("stale_write_conflict");

    // Author a manual intervention that is already past its revisit date, so it
    // reads back as "finished" and within the review window.
    const interventionRes = await ctx.app.inject({
      method: "POST",
      url: `/api/goals/${goal.id}/interventions`,
      headers: actor,
      payload: {
        type: "frequency_habit",
        commitment: "Run three times a week",
        rationale: "Build a base",
        startDate: "2000-01-01",
        revisitDate: "2000-01-15",
      },
    });
    expect(interventionRes.statusCode).toBe(201);
    const intervention = interventionRes.json() as InterventionView;
    expect(intervention).toMatchObject({
      goalId: goal.id,
      type: "frequency_habit",
      commitment: "Run three times a week",
      status: "active",
      source: "manual",
      backingTaskId: null,
      derivedState: "finished",
      withinReviewWindow: false,
      assessments: [],
    });

    // Conclude the intervention (lifecycle command, not a status PATCH).
    const concludeIntervention = await ctx.app.inject({
      method: "POST",
      url: `/api/interventions/${intervention.id}/conclude`,
      headers: actor,
      payload: { expectedRevision: intervention.revision },
    });
    expect(concludeIntervention.statusCode).toBe(200);
    const concluded = concludeIntervention.json() as InterventionView;
    expect(concluded.status).toBe("concluded");
    expect(concluded.concludedAt).not.toBeNull();

    // Concluding again is an invalid transition.
    const concludeAgain = await ctx.app.inject({
      method: "POST",
      url: `/api/interventions/${intervention.id}/conclude`,
      headers: actor,
      payload: { expectedRevision: concluded.revision },
    });
    expect(concludeAgain.statusCode).toBe(409);
    expect((concludeAgain.json() as { error: { code: string } }).error.code).toBe(
      "intervention_transition_invalid",
    );

    // Author a manual self-assessment (works with no AI configured).
    const assessRes = await ctx.app.inject({
      method: "POST",
      url: `/api/interventions/${intervention.id}/assessments`,
      headers: actor,
      payload: {
        band: "mostly_achieved",
        rationaleMd: "Ran twice most weeks.",
        countedItemIds: [11, 12],
        digestWindowStart: "2000-01-01",
        digestWindowEnd: householdToday(ctx.handle.db),
      },
    });
    expect(assessRes.statusCode).toBe(201);
    const assessment = assessRes.json() as InterventionAssessment;
    expect(assessment).toMatchObject({
      interventionId: intervention.id,
      band: "mostly_achieved",
      source: "manual",
      countedItemIds: [11, 12],
    });

    // Read back the full arc: the intervention is now "reviewed".
    const readRes = await ctx.app.inject({
      method: "GET",
      url: `/api/goals/${goal.id}`,
      headers: actor,
    });
    expect(readRes.statusCode).toBe(200);
    const readback = readRes.json() as GoalWithInterventions;
    expect(readback.interventions).toHaveLength(1);
    const view = readback.interventions[0]!;
    expect(view.derivedState).toBe("reviewed");
    expect(view.withinReviewWindow).toBe(false);
    expect(view.assessments).toHaveLength(1);
    expect(view.assessments[0]!.band).toBe("mostly_achieved");

    // Conclude the goal.
    const concludeGoal = await ctx.app.inject({
      method: "POST",
      url: `/api/goals/${goal.id}/conclude`,
      headers: actor,
      payload: { expectedRevision: readback.revision },
    });
    expect(concludeGoal.statusCode).toBe(200);
    expect((concludeGoal.json() as GoalWithInterventions).status).toBe("concluded");
  });

  it("derives a running intervention before its revisit date", async () => {
    const member = await createMember();
    const actor = { [ACTIVITY_ACTOR_HEADER]: String(member.id) };
    const goal = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/goals",
        headers: actor,
        payload: { title: "Stay active" },
      })
    ).json() as GoalWithInterventions;

    const intervention = (
      await ctx.app.inject({
        method: "POST",
        url: `/api/goals/${goal.id}/interventions`,
        headers: actor,
        payload: {
          type: "exploration_step",
          commitment: "Try a new class",
          startDate: "2000-01-01",
          revisitDate: "2999-12-31",
        },
      })
    ).json() as InterventionView;
    expect(intervention.derivedState).toBe("running");
    expect(intervention.withinReviewWindow).toBe(false);
  });

  it("rejects an intervention whose revisit date precedes its start date", async () => {
    const member = await createMember();
    const actor = { [ACTIVITY_ACTOR_HEADER]: String(member.id) };
    const goal = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/goals",
        headers: actor,
        payload: { title: "Guardrails" },
      })
    ).json() as GoalWithInterventions;

    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/goals/${goal.id}/interventions`,
      headers: actor,
      payload: {
        type: "obstacle_removal",
        commitment: "Backwards window",
        startDate: "2026-02-10",
        revisitDate: "2026-02-01",
      },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe("intervention_revisit_invalid");
  });

  it("drives the goal lifecycle through MCP tools scoped to the owner", async () => {
    const member = await createMember();
    const { client, server } = await connectMcp(member.id, "work");

    const created = await client.callTool({
      name: "machbar_create_goal",
      arguments: { title: "Ship the feature", notes: "This quarter", area: "work" },
    });
    const goal = (created.structuredContent as { result: GoalWithInterventions }).result;
    expect(goal).toMatchObject({ title: "Ship the feature", area: "work", status: "active" });
    expect(goal.ownerMemberId).toBe(member.id);

    const started = await client.callTool({
      name: "machbar_start_intervention",
      arguments: {
        goalId: goal.id,
        type: "commitment_stake",
        commitment: "Demo every Friday",
        startDate: "2000-01-01",
        revisitDate: "2999-12-31",
      },
    });
    const intervention = (started.structuredContent as { result: Intervention }).result;
    expect(intervention).toMatchObject({ goalId: goal.id, source: "manual", status: "active" });

    const concluded = await client.callTool({
      name: "machbar_conclude_intervention",
      arguments: { interventionId: intervention.id, expectedRevision: intervention.revision },
    });
    expect(
      (concluded.structuredContent as { result: InterventionView }).result.status,
    ).toBe("concluded");

    const listed = await client.callTool({ name: "machbar_list_goals", arguments: {} });
    const goals = (listed.structuredContent as { result: GoalWithInterventions[] }).result;
    expect(goals).toHaveLength(1);
    expect(goals[0]!.interventions[0]!.status).toBe("concluded");

    await client.close();
    await server.close();
  });

  it("keeps goals owner-scoped: visible to the same owner regardless of credential scope, hidden from other members", async () => {
    const owner = await createMember("Owner");
    const other = await createMember("Other");

    // A goal created under the work credential is a personal, owner-scoped item.
    const work = await connectMcp(owner.id, "work");
    const created = await work.client.callTool({
      name: "machbar_create_goal",
      arguments: { title: "Personal goal", area: "personal" },
    });
    const goal = (created.structuredContent as { result: GoalWithInterventions }).result;
    await work.client.close();
    await work.server.close();

    // The same owner on a different credential scope still sees and can act on it:
    // goal access is purely owner-based, independent of the credential's area.
    const household = await connectMcp(owner.id, "household");
    const ownerListed = await household.client.callTool({
      name: "machbar_list_goals",
      arguments: {},
    });
    expect(
      (ownerListed.structuredContent as { result: GoalWithInterventions[] }).result,
    ).toHaveLength(1);
    await household.client.close();
    await household.server.close();

    // A different member never sees or acts on another owner's goal.
    const stranger = await connectMcp(other.id, "work");
    const strangerListed = await stranger.client.callTool({
      name: "machbar_list_goals",
      arguments: {},
    });
    expect(
      (strangerListed.structuredContent as { result: GoalWithInterventions[] }).result,
    ).toHaveLength(0);

    const blocked = await stranger.client.callTool({
      name: "machbar_conclude_goal",
      arguments: { goalId: goal.id, expectedRevision: goal.revision },
    });
    expect(blocked.isError).toBe(true);

    await stranger.client.close();
    await stranger.server.close();
  });
});
