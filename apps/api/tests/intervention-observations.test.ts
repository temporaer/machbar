import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestContext, closeTestContext, type TestContext } from "./helpers.js";
import * as schema from "../src/db/schema.js";
import { createGoal, startIntervention, concludeIntervention, createManualAssessment, getGoal } from "../src/domain/goals.js";
import { setObservationPlan, recordObservation, observationHistory, observationIsAnswerable, recentInterventionReports } from "../src/domain/interventionObservations.js";
import { ACTIVITY_ACTOR_HEADER } from "@machbar/shared";
import type { ObservationPlanVersion } from "@machbar/shared";
let ctx: TestContext;
beforeEach(() => { ctx = createTestContext(); });
afterEach(async () => { vi.useRealTimers(); await closeTestContext(ctx); });
const daily = { method: "daily_report", question: "In bed after brushing?", reference: "night", reportDayOffset: 1, availableAfter: "07:00", opportunityBased: false, target: { successfulDays: 4, window: "calendar_week" } } as const;
function setup() {
  const member = ctx.handle.db.insert(schema.members).values({ name: "Owner", color: "#123456" }).returning().get();
  ctx.handle.db.insert(schema.householdSettings).values({ key: "timezone", value: "Europe/Berlin" }).onConflictDoUpdate({ target: schema.householdSettings.key, set: { value: "Europe/Berlin" } }).run();
  const goal = createGoal(ctx.handle.db, { title: "Sleep", ownerMemberId: member.id }, "2026-10-24");
  const intervention = startIntervention(ctx.handle.db, goal.id, { type: "frequency_habit", commitment: "Bed after brushing", startDate: "2026-10-24", revisitDate: "2026-11-07" }, "2026-10-24");
  return { intervention, access: { ownerMemberId: member.id } };
}
it("attributes morning reports to last night, prevents duplicates/stale corrections, and retains unknown distinct from missing", () => {
  const { intervention: i, access } = setup(); const db = ctx.handle.db;
  const plan = setObservationPlan(db, i.id, { plan: daily, expectedRevision: 1 }, access, new Date("2026-10-24T10:00:00Z"));
  expect(observationHistory(db, i.id, access).observations).toEqual([]);
  expect(() => recordObservation(db, i.id, { referenceDate: "2026-10-24", answer: "met", expectedRevision: 0 }, access, new Date("2026-10-24T23:30:00Z"))).toThrow();
  const now = new Date("2026-10-25T06:00:00Z");
  const row = recordObservation(db, i.id, { referenceDate: "2026-10-24", answer: "not_met", expectedRevision: 0 }, access, now);
  expect(row).toMatchObject({ planVersionId: plan.id, referenceDate: "2026-10-24", submittedAt: now.toISOString(), answer: "not_met" });
  expect(() => recordObservation(db, i.id, { referenceDate: row.referenceDate, answer: "met", expectedRevision: 0 }, access, now)).toThrow();
  const corrected = recordObservation(db, i.id, { referenceDate: row.referenceDate, answer: "unknown", expectedRevision: row.revision }, access, new Date("2026-10-26T10:00:00Z"));
  expect(corrected).toMatchObject({ revision: 2, answer: "unknown", submittedAt: row.submittedAt });
  expect(() => recordObservation(db, i.id, { referenceDate: row.referenceDate, answer: "met", expectedRevision: 1 }, access, now)).toThrow();
  expect(() => recordObservation(db, i.id, { referenceDate: row.referenceDate, answer: "no_opportunity", expectedRevision: 2 }, access, now)).toThrow();
  expect(() => observationHistory(db, i.id, { ownerMemberId: access.ownerMemberId + 1 })).toThrow();
});
it("preserves historical plans and targets while new versions apply prospectively", () => {
  const { intervention: i, access } = setup(); const db = ctx.handle.db;
  const first = setObservationPlan(db, i.id, { plan: daily, expectedRevision: 1 }, access, new Date("2026-10-24T10:00:00Z"));
  expect(() => setObservationPlan(db, i.id, { plan: { method: "reflection" }, expectedRevision: 1 }, access, new Date("2026-10-25T10:00:00Z"))).toThrow();
  const next = setObservationPlan(db, i.id, { plan: { ...daily, question: "New wording", opportunityBased: true, target: { successfulDays: 2, window: "seven_days", anchorDate: "2026-10-26" } }, expectedRevision: 2 }, access, new Date("2026-10-25T10:00:00Z"));
  expect(next.effectiveFrom).toBe("2026-10-26");
  const oldReport = recordObservation(db, i.id, { referenceDate: "2026-10-25", answer: "met", expectedRevision: 0 }, access, new Date("2026-10-28T10:00:00Z"));
  expect(oldReport.planVersionId).toBe(first.id);
  expect(recordObservation(db, i.id, { referenceDate: "2026-10-26", answer: "no_opportunity", expectedRevision: 0 }, access, new Date("2026-10-28T10:00:00Z")).planVersionId).toBe(next.id);
  expect(observationHistory(db, i.id, access).plans[0]!.plan).toEqual(daily);
  // Checkpoints do not terminate a still-active behavior or future reports.
  db.update(schema.interventions).set({ revisitDate: "2026-10-25" }).where(eq(schema.interventions.id, i.id)).run();
  expect(recordObservation(db, i.id, { referenceDate: "2026-10-27", answer: "met", expectedRevision: 0 }, access, new Date("2026-10-28T10:00:00Z")).referenceDate).toBe("2026-10-27");
});
it("uses local wall clocks across both DST transitions and same-day window closure", () => {
  const version: ObservationPlanVersion = { id: 1, interventionId: 1, effectiveFrom: "2026-01-01", timezone: "Europe/Berlin", commitment: "Evening", plan: daily, createdAt: "2026-01-01T00:00:00Z" };
  expect(observationIsAnswerable(version, "2026-03-28", new Date("2026-03-29T04:59:00Z"))).toBe(false);
  expect(observationIsAnswerable(version, "2026-03-28", new Date("2026-03-29T05:00:00Z"))).toBe(true);
  expect(observationIsAnswerable(version, "2026-10-24", new Date("2026-10-25T05:59:00Z"))).toBe(false);
  expect(observationIsAnswerable(version, "2026-10-24", new Date("2026-10-25T06:00:00Z"))).toBe(true);
  const sameDay: ObservationPlanVersion = { ...version, plan: { ...daily, reference: "day", reportDayOffset: 0, availableAfter: "22:00" } };
  expect(observationIsAnswerable(sameDay, "2026-10-24", new Date("2026-10-24T19:59:00Z"))).toBe(false);
  expect(observationIsAnswerable(sameDay, "2026-10-24", new Date("2026-10-24T20:00:00Z"))).toBe(true);
  expect(observationIsAnswerable(sameDay, "2026-10-24", new Date("2026-10-24T22:01:00Z"))).toBe(true);
});
it("offers only answerable recent questions in the owner's personal Today; a negative answer finishes reporting", async () => {
  const { buildAgendaInterventionFocus } = await import("../src/domain/agendaInterventions.js");
  const { intervention: i, access } = setup(); const db = ctx.handle.db;
  setObservationPlan(db, i.id, { plan: daily, expectedRevision: 1 }, access, new Date("2026-10-24T10:00:00Z"));
  const options = { memberId: access.ownerMemberId, scope: "mine" as const, today: "2026-10-25", now: new Date("2026-10-25T06:00:00Z") };
  expect(buildAgendaInterventionFocus(db, { ...options, now: new Date("2026-10-25T05:59:00Z") }).reports).toEqual([]);
  expect(buildAgendaInterventionFocus(db, options).reports?.map((r) => r.referenceDate)).toEqual(["2026-10-24"]);
  expect(buildAgendaInterventionFocus(db, { ...options, memberId: access.ownerMemberId + 1 }).reports).toEqual([]);
  expect(buildAgendaInterventionFocus(db, { ...options, scope: "work" }).reports).toEqual([]);
  recordObservation(db, i.id, { referenceDate: "2026-10-24", answer: "not_met", expectedRevision: 0 }, access, options.now);
  expect(buildAgendaInterventionFocus(db, options).reports).toEqual([]);
  expect(buildAgendaInterventionFocus(db, { ...options, today: "2027-01-01", now: new Date("2027-01-01T10:00:00Z") }).reports?.length).toBeLessThanOrEqual(7);
});

it("keeps availability monotonic during a repeated hour and shifts nonexistent times forward", () => {
  const version: ObservationPlanVersion = { id: 1, interventionId: 1, effectiveFrom: "2026-01-01", timezone: "Europe/Berlin", commitment: "Night", plan: { ...daily, availableAfter: "02:30" }, createdAt: "2026-01-01T00:00:00Z" };
  // The later occurrence is deliberate: the first 02:45 must not be followed by unavailable 02:15.
  expect(observationIsAnswerable(version, "2026-10-24", new Date("2026-10-25T00:45:00Z"))).toBe(false);
  expect(observationIsAnswerable(version, "2026-10-24", new Date("2026-10-25T01:15:00Z"))).toBe(false);
  expect(observationIsAnswerable(version, "2026-10-24", new Date("2026-10-25T01:30:00Z"))).toBe(true);
  expect(observationIsAnswerable(version, "2026-10-24", new Date("2026-10-25T01:45:00Z"))).toBe(true);
  expect(observationIsAnswerable(version, "2026-03-28", new Date("2026-03-29T01:29:00Z"))).toBe(false);
  expect(observationIsAnswerable(version, "2026-03-28", new Date("2026-03-29T01:30:00Z"))).toBe(true);
});


it("keeps the final nightly report available after switching to reflection", () => {
  const { intervention: i, access } = setup(); const db = ctx.handle.db;
  const first = setObservationPlan(db, i.id, { plan: daily, expectedRevision: 1 }, access, new Date("2026-10-24T10:00:00Z"));
  setObservationPlan(db, i.id, { plan: { method: "reflection" }, expectedRevision: 2 }, access, new Date("2026-10-24T11:00:00Z"));
  const now = new Date("2026-10-25T06:00:00Z");
  expect(recentInterventionReports(db, i.id, access, now)).toMatchObject([{ referenceDate: "2026-10-24", plan: { id: first.id } }]);
  recordObservation(db, i.id, { referenceDate: "2026-10-24", answer: "not_met", expectedRevision: 0 }, access, now);
  expect(recentInterventionReports(db, i.id, access, now)).toEqual([]);
});

it.each([1, 0] as const)("keeps final pending reports in stopped history after final review, excluding Today and post-stop dates (offset %s)", async (reportDayOffset) => {
  const { buildAgendaInterventionFocus } = await import("../src/domain/agendaInterventions.js");
  const { intervention: i, access } = setup(); const db = ctx.handle.db;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-24T10:00:00Z"));
  setObservationPlan(db, i.id, { plan: { ...daily, reference: reportDayOffset === 1 ? "night" : "day", reportDayOffset, availableAfter: reportDayOffset === 1 ? "07:00" : "22:00" }, expectedRevision: 1 }, access);
  const stopped = concludeIntervention(db, i.id, 2, "2026-10-24");
  expect(recentInterventionReports(db, i.id, access)).toEqual([]);
  createManualAssessment(db, i.id, { band: "no_evidence", rationaleMd: "Stopped before final report becomes available", digestWindowStart: "2026-10-24", digestWindowEnd: "2026-10-24", decision: "stop", reviewKey: "final-before-report", expectedRevision: stopped.revision });
  expect(getGoal(db, i.goalId, "2026-10-24").interventions[0]!.derivedState).toBe("reviewed");
  vi.setSystemTime(new Date(reportDayOffset === 1 ? "2026-10-25T06:00:00Z" : "2026-10-24T20:00:00Z"));
  const history = await ctx.app.inject({ method: "GET", url: `/api/interventions/${i.id}/observations`, headers: { [ACTIVITY_ACTOR_HEADER]: String(access.ownerMemberId) } });
  expect(history.statusCode, history.body).toBe(200);
  expect(history.json().recentReports.map((r: { referenceDate: string }) => r.referenceDate)).toEqual(["2026-10-24"]);
  const focus = buildAgendaInterventionFocus(db, { memberId: access.ownerMemberId, scope: "mine", today: "2026-10-25" });
  expect(focus.running).toEqual([]); expect(focus.review).toEqual([]); expect(focus.reports).toEqual([]);
  vi.setSystemTime(new Date("2026-10-26T10:00:00Z"));
  expect(recentInterventionReports(db, i.id, access).map((r) => r.referenceDate)).toEqual(["2026-10-24"]);
  expect(recentInterventionReports(db, i.id, access, new Date("2026-11-01T10:00:00Z"))).toEqual([]);
  expect(() => recordObservation(db, i.id, { referenceDate: "2026-10-25", answer: "met", expectedRevision: 0 }, access)).toThrow();
  const observation = recordObservation(db, i.id, { referenceDate: "2026-10-24", answer: "unknown", expectedRevision: 0 }, access);
  expect(observation.referenceDate).toBe("2026-10-24");
  expect(recentInterventionReports(db, i.id, access)).toEqual([]);
});
