import { afterEach, beforeEach, expect, it } from "vitest";
import { ACTIVITY_ACTOR_HEADER } from "@machbar/shared";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";
import { buildReflectionBriefing } from "../src/reflection/briefing.js";
import { getActivityDigest } from "../src/activity/digest.js";
let ctx: TestContext;
beforeEach(() => { ctx = createTestContext(); });
afterEach(async () => { await closeTestContext(ctx); });
it("protects the whole goal loop and places private personal backing independently of work", async () => {
  const member = async (name: string) => (await ctx.app.inject({ method: "POST", url: "/api/members", payload: { name } })).json().id as number;
  const owner = await member("Owner"), other = await member("Other");
  const actor = (id: number) => ({ [ACTIVITY_ACTOR_HEADER]: String(id) });
  const goal = (await ctx.app.inject({ method: "POST", url: "/api/goals", headers: actor(owner), payload: { title: "Private sleep", area: "personal" } })).json();
  const intervention = (await ctx.app.inject({ method: "POST", url: `/api/goals/${goal.id}/interventions`, headers: actor(owner), payload: { type: "frequency_habit", commitment: "Private bedtime", startDate: "2026-10-01", revisitDate: "2999-01-01" } })).json();
  for (const [method, url] of [
    ["GET", `/api/goals/${goal.id}`], ["PATCH", `/api/goals/${goal.id}`],
    ["POST", `/api/goals/${goal.id}/conclude`], ["POST", `/api/goals/${goal.id}/interventions`],
    ["PATCH", `/api/interventions/${intervention.id}`], ["POST", `/api/interventions/${intervention.id}/backing`],
    ["POST", `/api/interventions/${intervention.id}/conclude`], ["POST", `/api/interventions/${intervention.id}/assessments`],
    ["POST", `/api/goals/${goal.id}/suggest`], ["GET", `/api/goals/${goal.id}/suggest/fake`],
    ["POST", `/api/goals/${goal.id}/suggest/fake/accept`], ["POST", `/api/interventions/${intervention.id}/assess`],
    ["GET", `/api/interventions/${intervention.id}/assess/fake`], ["POST", `/api/interventions/${intervention.id}/assess/fake/accept`],
  ] as const) {
    expect((await ctx.app.inject({ method, url, headers: actor(other) })).statusCode, `${method} ${url}`).toBe(404);
  }
  expect((await ctx.app.inject({ method: "GET", url: "/api/goals", headers: actor(other) })).json()).toEqual([]);
  expect((await ctx.app.inject({ method: "GET", url: "/api/goals" })).statusCode).toBe(401);
  expect((await ctx.app.inject({ method: "POST", url: "/api/goals", headers: actor(other), payload: { title: "Spoof", ownerMemberId: owner } })).statusCode).toBe(400);
  const backing = await ctx.app.inject({ method: "POST", url: `/api/interventions/${intervention.id}/backing`, headers: actor(owner), payload: { scheduledDate: "2026-10-15" } });
  expect(backing.statusCode).toBe(201);
  const id = backing.json().backingTaskId;
  const task = await ctx.app.inject({ method: "GET", url: `/api/tasks/${id}`, headers: actor(owner) });
  expect(task.json()).toMatchObject({ scope: "household", privacyOwnerMemberId: owner });
  for (const method of ["GET", "PATCH", "DELETE"] as const) {
    expect((await ctx.app.inject({ method, url: `/api/tasks/${id}`, headers: actor(other), ...(method === "PATCH" ? { payload: { title: "Stolen" } } : {}) })).statusCode).toBe(404);
  }
  const personal = await ctx.app.inject({ method: "GET", url: `/api/agenda/today?scope=mine&memberId=${owner}&date=2026-10-15`, headers: actor(owner) });
  expect(personal.body).toContain("Private bedtime");
  for (const [memberId, scope] of [[other, "mine"], [owner, "all"], [owner, "work"]] as const) {
    const res = await ctx.app.inject({ method: "GET", url: `/api/agenda/today?scope=${scope}&memberId=${memberId}&date=2026-10-15`, headers: actor(memberId) });
    expect(res.body).not.toContain("Private bedtime");
  }
  const activity = await ctx.app.inject({ method: "GET", url: "/api/activity", headers: actor(other) });
  expect(activity.body).not.toContain("Private bedtime");
  expect(JSON.stringify(getActivityDigest(ctx.handle.db, other))).not.toContain("Private bedtime");
  expect(JSON.stringify(buildReflectionBriefing(ctx.handle.db, { subjectMemberId: other, days: 14, scope: "all" }))).not.toContain("Private bedtime");
});
