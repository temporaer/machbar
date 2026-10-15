import { and, asc, eq } from "drizzle-orm";
import type { InterventionObservation, InterventionObservationHistory, ObservationPlanVersion } from "@machbar/shared";
import type { z } from "zod";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { AppError } from "../errors.js";
import { recordObservationSchema, setObservationPlanSchema } from "../schemas.js";
import { parseOrThrow } from "../validation.js";
import { assertInterventionAccessible, type GoalAccess } from "./goals.js";
import { addCalendarDays } from "./calendarDate.js";
import { householdToday, householdTimezone, localDate } from "./householdCalendar.js";

export function observationHistory(db: Db, interventionId: number, access: GoalAccess): InterventionObservationHistory {
  assertInterventionAccessible(db, interventionId, access);
  return {
    plans: db.select().from(schema.interventionObservationPlans).where(eq(schema.interventionObservationPlans.interventionId, interventionId)).orderBy(asc(schema.interventionObservationPlans.effectiveFrom)).all(),
    observations: db.select().from(schema.interventionObservations).where(eq(schema.interventionObservations.interventionId, interventionId)).orderBy(asc(schema.interventionObservations.referenceDate)).all(),
  };
}
export function observationPlanForDate(plans: ObservationPlanVersion[], date: string): ObservationPlanVersion | undefined {
  return plans.filter((p) => p.effectiveFrom <= date).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
}
/** Wall-clock comparison deliberately avoids assuming that local days are 24 hours. */
export function observationIsAnswerable(version: ObservationPlanVersion, referenceDate: string, now: Date): boolean {
  if (version.plan.method !== "daily_report" || referenceDate < version.effectiveFrom) return false;
  const availableDate = addCalendarDays(referenceDate, version.plan.reportDayOffset);
  const today = localDate(now, version.timezone);
  if (today !== availableDate) return today > availableDate;
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: version.timezone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).format(now);
  return time >= version.plan.availableAfter;
}
export function setObservationPlan(db: Db, interventionId: number, raw: z.input<typeof setObservationPlanSchema>, access: GoalAccess, now = new Date()): ObservationPlanVersion {
  const input = parseOrThrow(setObservationPlanSchema, raw);
  return db.transaction((tx) => {
    const history = observationHistory(tx as unknown as Db, interventionId, access);
    const current = tx.select().from(schema.interventions).where(eq(schema.interventions.id, interventionId)).get()!;
    if (current.status !== "active") throw AppError.conflict("intervention_transition_invalid", "A stopped intervention cannot start a new observation plan.");
    if (current.revision !== input.expectedRevision) throw AppError.conflict("stale_write_conflict", "Reload the intervention before changing its plan.");
    const today = householdToday(tx as unknown as Db, now);
    // Once a plan exists, all changes apply tomorrow. Never overwrite an issued snapshot.
    const effectiveFrom = history.plans.length === 0 ? (current.startDate > today ? current.startDate : today) : addCalendarDays(today, 1);
    if (history.plans.some((p) => p.effectiveFrom >= effectiveFrom)) throw AppError.conflict("stale_write_conflict", "A prospective plan is already scheduled. Review it before making another change.");
    const created = tx.insert(schema.interventionObservationPlans).values({ interventionId, effectiveFrom, timezone: householdTimezone(tx as unknown as Db), commitment: current.commitment, plan: input.plan }).returning().get();
    tx.update(schema.interventions).set({ revision: current.revision + 1, updatedAt: now.toISOString() }).where(eq(schema.interventions.id, interventionId)).run();
    return created;
  });
}
/** expectedRevision=0 creates; a concrete revision corrects, preserving initial submission time. */
export function recordObservation(db: Db, interventionId: number, raw: z.input<typeof recordObservationSchema>, access: GoalAccess, now = new Date()): InterventionObservation {
  const input = parseOrThrow(recordObservationSchema, raw);
  return db.transaction((tx) => {
    const history = observationHistory(tx as unknown as Db, interventionId, access);
    const version = observationPlanForDate(history.plans, input.referenceDate);
    const intervention = tx.select().from(schema.interventions).where(eq(schema.interventions.id, interventionId)).get()!;
    const stopDate = intervention.concludedAt ? localDate(new Date(intervention.concludedAt), version?.timezone ?? householdTimezone(tx as unknown as Db)) : null;
    if (!version || input.referenceDate < intervention.startDate || (stopDate !== null && input.referenceDate > stopDate) || !observationIsAnswerable(version, input.referenceDate, now)) throw AppError.badRequest("intervention_assessment_invalid", "This reference period is not available for reporting.");
    if (input.answer === "no_opportunity" && (version.plan.method !== "daily_report" || !version.plan.opportunityBased)) throw AppError.badRequest("intervention_assessment_invalid", "No opportunity applies only to opportunity-based plans.");
    const existing = history.observations.find((o) => o.referenceDate === input.referenceDate);
    if ((existing?.revision ?? 0) !== input.expectedRevision) throw AppError.conflict("stale_write_conflict", "This report has changed. Reload before correcting it.");
    const timestamp = now.toISOString();
    if (existing) return tx.update(schema.interventionObservations).set({ answer: input.answer, notes: input.notes ?? "", revision: existing.revision + 1, updatedAt: timestamp }).where(and(eq(schema.interventionObservations.id, existing.id), eq(schema.interventionObservations.revision, existing.revision))).returning().get()!;
    return tx.insert(schema.interventionObservations).values({ interventionId, planVersionId: version.id, referenceDate: input.referenceDate, answer: input.answer, notes: input.notes ?? "", submittedAt: timestamp, updatedAt: timestamp }).returning().get();
  });
}
