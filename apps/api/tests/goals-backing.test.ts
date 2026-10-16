import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACTIVITY_ACTOR_HEADER } from "@machbar/shared";
import type {
  Agenda,
  GoalWithInterventions,
  Intervention,
  InterventionView,
} from "@machbar/shared";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

/**
 * Phase 4 optional recurring-task backing (§8): a `frequency_habit` intervention
 * may be backed by a canonical recurring check-in task. The task is created and
 * ended exclusively through the canonical task path (`createTaskInTransaction` /
 * `cancelTask`) — never a parallel task-mutation path. When backed, the recurring
 * check-in is the real Heute presence carrying a hit/miss tally, and concluding a
 * backed intervention resolves the task with a keep/stop decision (default stop).
 */
describe("Intervention recurring-task backing (Phase 4)", () => {
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

  async function createGoal(memberId: number): Promise<GoalWithInterventions> {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/goals",
      headers: { [ACTIVITY_ACTOR_HEADER]: String(memberId) },
      payload: { title: "Run a half marathon", area: "work" },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as GoalWithInterventions;
  }

  async function startIntervention(
    memberId: number,
    goalId: number,
    overrides: Record<string, unknown> = {},
  ): Promise<Intervention> {
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/goals/${goalId}/interventions`,
      headers: { [ACTIVITY_ACTOR_HEADER]: String(memberId) },
      payload: {
        type: "frequency_habit",
        commitment: "Run three times a week",
        startDate: "2000-01-01",
        revisitDate: "2999-12-31",
        ...overrides,
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as Intervention;
  }

  async function getTask(memberId: number, taskId: number) {
    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}`,
      headers: { [ACTIVITY_ACTOR_HEADER]: String(memberId) },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as {
      id: number;
      status: string;
      scheduledDate: string | null;
      repeatAfterDays: number | null;
      allowedDeviationDays: number | null;
      effectiveOwnerMemberId?: number | null;
      ownerMemberId?: number | null;
    };
  }

  it("backs a frequency habit through the canonical task path and shows it in Heute", async () => {
    const member = await createMember();
    const actor = { [ACTIVITY_ACTOR_HEADER]: String(member.id) };
    const goal = await createGoal(member.id);
    const intervention = await startIntervention(member.id, goal.id);
    expect(intervention.backingTaskId).toBeNull();

    const backed = await ctx.app.inject({
      method: "POST",
      url: `/api/interventions/${intervention.id}/backing`,
      headers: actor,
      payload: {},
    });
    expect(backed.statusCode).toBe(201);
    const view = backed.json() as InterventionView;
    expect(view.backingTaskId).not.toBeNull();
    expect(view.revision).toBe(intervention.revision + 1);

    // The backing task is a real recurring, scheduled check-in owned by the goal
    // owner — created through the canonical task path, not a parallel insert.
    const task = await getTask(member.id, view.backingTaskId as number);
    expect(task.repeatAfterDays).toBe(1);
    expect(task.scheduledDate).not.toBeNull();
    expect(task.status).not.toBe("cancelled");

    // Heute surfaces the running strip with a (so far empty) hit/miss tally.
    const params = new URLSearchParams({
      scope: "work",
      memberId: String(member.id),
      date: "2026-06-01",
    });
    const agendaRes = await ctx.app.inject({
      method: "GET",
      url: `/api/agenda/today?${params.toString()}`,
    });
    expect(agendaRes.statusCode).toBe(200);
    const agenda = agendaRes.json() as Agenda;
    expect(agenda.interventions.running).toHaveLength(1);
    const runningItem = agenda.interventions.running[0];
    expect(runningItem?.backing).toMatchObject({
      taskId: view.backingTaskId,
      hits: 0,
      misses: 0,
    });
  });

  it("creates a one-off backing task for non-frequency interventions", async () => {
    const member = await createMember();
    const goal = await createGoal(member.id);
    const intervention = await startIntervention(member.id, goal.id, {
      type: "obstacle_removal",
    });

    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/interventions/${intervention.id}/backing`,
      headers: { [ACTIVITY_ACTOR_HEADER]: String(member.id) },
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    expect((await getTask(member.id, res.json().backingTaskId)).repeatAfterDays).toBeNull();
  });

  it("retries an identical backing acceptance without creating duplicate tasks", async () => {
    const member = await createMember();
    const actor = { [ACTIVITY_ACTOR_HEADER]: String(member.id) };
    const goal = await createGoal(member.id);
    const intervention = await startIntervention(member.id, goal.id);

    const first = await ctx.app.inject({
      method: "POST",
      url: `/api/interventions/${intervention.id}/backing`,
      headers: actor,
      payload: {},
    });
    expect(first.statusCode).toBe(201);

    const second = await ctx.app.inject({
      method: "POST",
      url: `/api/interventions/${intervention.id}/backing`,
      headers: actor,
      payload: {},
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().backingTaskId).toBe(first.json().backingTaskId);
    expect(second.json().generatedTasks).toHaveLength(1);
  });

  it("ends the backing task via the canonical path when concluding (default stop)", async () => {
    const member = await createMember();
    const actor = { [ACTIVITY_ACTOR_HEADER]: String(member.id) };
    const goal = await createGoal(member.id);
    const intervention = await startIntervention(member.id, goal.id);
    const backed = (
      await ctx.app.inject({
        method: "POST",
        url: `/api/interventions/${intervention.id}/backing`,
        headers: actor,
        payload: {},
      })
    ).json() as InterventionView;
    const taskId = backed.backingTaskId as number;

    const concluded = await ctx.app.inject({
      method: "POST",
      url: `/api/interventions/${intervention.id}/conclude`,
      headers: actor,
      payload: { expectedRevision: backed.revision },
    });
    expect(concluded.statusCode).toBe(200);
    const concludedView = concluded.json() as InterventionView;
    expect(concludedView.status).toBe("concluded");
    expect(concludedView.backingTaskId).toBeNull();

    const task = await getTask(member.id, taskId);
    expect(task.status).toBe("cancelled");
  });

  it("keeps the backing task alive when concluding with keep", async () => {
    const member = await createMember();
    const actor = { [ACTIVITY_ACTOR_HEADER]: String(member.id) };
    const goal = await createGoal(member.id);
    const intervention = await startIntervention(member.id, goal.id);
    const backed = (
      await ctx.app.inject({
        method: "POST",
        url: `/api/interventions/${intervention.id}/backing`,
        headers: actor,
        payload: {},
      })
    ).json() as InterventionView;
    const taskId = backed.backingTaskId as number;

    const concluded = await ctx.app.inject({
      method: "POST",
      url: `/api/interventions/${intervention.id}/conclude`,
      headers: actor,
      payload: { expectedRevision: backed.revision, backingCleanup: "keep" },
    });
    expect(concluded.statusCode).toBe(200);
    expect((concluded.json() as InterventionView).backingTaskId).toBeNull();

    // The recurring task survives as ordinary recurring work.
    const task = await getTask(member.id, taskId);
    expect(task.status).not.toBe("cancelled");
    expect(task.repeatAfterDays).toBe(1);
  });
});
