import { afterEach, beforeEach, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestContext, closeTestContext, type TestContext } from "./helpers.js";
import * as schema from "../src/db/schema.js";
import { createGoal, startIntervention, backIntervention, createManualAssessment, getGoal } from "../src/domain/goals.js";
import { setObservationPlan, recordObservation } from "../src/domain/interventionObservations.js";
import { buildInterventionEvidence } from "../src/domain/interventionEvidence.js";
let ctx: TestContext;
beforeEach(() => { ctx = createTestContext(); });
afterEach(async () => { await closeTestContext(ctx); });
function setup() {
  const db = ctx.handle.db;
  const member = db.insert(schema.members).values({ name: "Owner", color: "#123456" }).returning().get();
  const goal = createGoal(db, { title: "Sleep", ownerMemberId: member.id }, "2026-10-05");
  const intervention = startIntervention(db, goal.id, { type: "frequency_habit", commitment: "Bed after brushing", startDate: "2026-10-05", revisitDate: "2026-10-11" }, "2026-10-05");
  const access = { ownerMemberId: member.id };
  setObservationPlan(db, intervention.id, { expectedRevision: 1, plan: { method: "daily_report", question: "In bed?", reference: "night", reportDayOffset: 1, availableAfter: "07:00", opportunityBased: false, target: { successfulDays: 4, window: "calendar_week" } } }, access, new Date("2026-10-05T10:00:00Z"));
  for (let n = 0; n < 6; n++) recordObservation(db, intervention.id, { referenceDate: `2026-10-${String(5 + n).padStart(2, "0")}`, answer: n < 4 ? "met" : "not_met", expectedRevision: 0 }, access, new Date("2026-10-12T10:00:00Z"));
  return { db, member, goal, intervention, access };
}
it("keeps four successes, two failures and one missing explicit, with per-week historical targets", () => {
  const { db, intervention: i, access } = setup();
  const evidence = buildInterventionEvidence(db, i.id, access, { now: new Date("2026-10-12T10:00:00Z") });
  expect(evidence.counts).toEqual({ eligible: 7, reported: 6, met: 4, notMet: 2, unknown: 0, noOpportunity: 0, missing: 1 });
  expect(evidence.periods).toHaveLength(1);
  expect(evidence.periods[0]).toMatchObject({ startDate: "2026-10-05", endDate: "2026-10-11", target: { successfulDays: 4, window: "calendar_week" }, targetMet: true, partial: false });
  expect(() => buildInterventionEvidence(db, i.id, { ownerMemberId: access.ownerMemberId + 1 })).toThrow();
  recordObservation(db, i.id, { referenceDate: "2026-10-11", answer: "unknown", expectedRevision: 0 }, access, new Date("2026-10-12T10:00:00Z"));
  const later = buildInterventionEvidence(db, i.id, access, { now: new Date("2026-10-12T10:00:00Z") });
  expect(later.counts).toMatchObject({ unknown: 1, missing: 0, notMet: 2 });
});
it("continues without duplicating work, snapshots evidence, and idempotently accepts one checkpoint", () => {
  const { db, intervention: i, goal, access } = setup();
  const backed = backIntervention(db, i.id, { tasks: [{ key: "routine", title: "Useful routine", scheduledDate: "2026-10-15", repeatAfterDays: 1 }] }, "2026-10-15");
  const input = { band: "mostly_achieved" as const, rationaleMd: "Helpful, still observing benefit", digestWindowStart: "2026-10-05", digestWindowEnd: "2026-10-11", decision: "continue" as const, benefit: "uncertain" as const, reviewKey: "checkpoint-1", expectedRevision: backed.revision };
  const assessment = createManualAssessment(db, i.id, input);
  expect(assessment.evidence?.counts).toMatchObject({ met: 4, notMet: 2, missing: 1 });
  expect(createManualAssessment(db, i.id, input).id).toBe(assessment.id);
  const continued = getGoal(db, goal.id, "2026-10-15").interventions[0]!;
  expect(continued).toMatchObject({ status: "active", derivedState: "running", reviewWindowStart: "2026-10-12", backingTaskId: backed.backingTaskId });
  expect(db.select().from(schema.interventionTasks).all()).toHaveLength(1);
  recordObservation(db, i.id, { referenceDate: "2026-10-11", answer: "met", expectedRevision: 0 }, access, new Date("2026-10-15T10:00:00Z"));
  expect(getGoal(db, goal.id, "2026-10-15").interventions[0]!.assessments[0]!.evidence?.counts.missing).toBe(1);
  const stopped = createManualAssessment(db, i.id, { ...input, reviewKey: "checkpoint-2", expectedRevision: continued.revision, digestWindowStart: "2026-10-12", digestWindowEnd: "2026-10-15", decision: "stop", backingCleanup: "keep" });
  expect(stopped.decision).toBe("stop");
  expect(db.select().from(schema.workItems).where(eq(schema.workItems.id, backed.backingTaskId!)).get()!.status).toBe("active");
});
it("evaluates weekly targets separately and preserves old targets after a prospective change", () => {
  const { db, intervention: i, access } = setup();
  const fortnight = buildInterventionEvidence(db, i.id, access, { endDate: "2026-10-18", now: new Date("2026-10-19T10:00:00Z") });
  expect(fortnight.periods.map((p) => p.counts.met)).toEqual([4, 0]);
  expect(fortnight.periods.map((p) => p.targetMet)).toEqual([true, null]);
  setObservationPlan(db, i.id, { expectedRevision: 2, plan: { method: "daily_report", question: "A lighter question", reference: "day", reportDayOffset: 0, availableAfter: "20:00", opportunityBased: true, target: { successfulDays: 2, window: "calendar_week" } } }, access, new Date("2026-10-12T10:00:00Z"));
  const changed = buildInterventionEvidence(db, i.id, access, { endDate: "2026-10-18", now: new Date("2026-10-19T10:00:00Z") });
  expect(changed.periods[0]!.target.successfulDays).toBe(4);
  expect(changed.periods.find((p) => p.planVersionId !== changed.periods[0]!.planVersionId)).toMatchObject({ partial: true, target: { successfulDays: 2 } });
});
