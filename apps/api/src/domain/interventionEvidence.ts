import { eq } from "drizzle-orm";
import type { InterventionEvidence, ObservationCounts, InterventionObservation } from "@machbar/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { AppError } from "../errors.js";
import { buildReflectionBriefing } from "../reflection/briefing.js";
import { observationHistory, observationPlanForDate, observationIsAnswerable } from "./interventionObservations.js";
import { addCalendarDays, calendarDaysBetween } from "./calendarDate.js";
import { householdToday, householdTimezone, localDate } from "./householdCalendar.js";
import { generatedTasksForIntervention, type GoalAccess } from "./goals.js";

export function observationCounts(days: string[], observations: InterventionObservation[]): ObservationCounts {
  const rows = observations.filter((o) => days.includes(o.referenceDate));
  return { eligible: days.length, reported: rows.length, met: rows.filter((r) => r.answer === "met").length,
    notMet: rows.filter((r) => r.answer === "not_met").length, unknown: rows.filter((r) => r.answer === "unknown").length,
    noOpportunity: rows.filter((r) => r.answer === "no_opportunity").length, missing: days.length - rows.length };
}
/** One deterministic builder for manual and coach review, extending canonical reflection. */
export function buildInterventionEvidence(db: Db, interventionId: number, access: GoalAccess, options: { startDate?: string; endDate?: string; now?: Date } = {}): InterventionEvidence {
  const history = observationHistory(db, interventionId, access);
  const intervention = db.select().from(schema.interventions).where(eq(schema.interventions.id, interventionId)).get()!;
  const now = options.now ?? new Date(), today = householdToday(db, now);
  const startDate = options.startDate ?? intervention.reviewWindowStart ?? intervention.startDate;
  const stopDate = intervention.concludedAt ? localDate(new Date(intervention.concludedAt), householdTimezone(db)) : null;
  const defaultEnd = stopDate ?? intervention.revisitDate;
  const endDate = options.endDate ?? (defaultEnd < today ? defaultEnd : today);
  const days = calendarDaysBetween(startDate, endDate) + 1;
  if (days < 1 || endDate > today || (stopDate !== null && endDate > stopDate) || startDate < intervention.startDate) throw AppError.badRequest("intervention_assessment_invalid", "Review a past or current calendar window.");
  const dailyStart = history.plans[0] && history.plans[0].effectiveFrom > startDate ? history.plans[0].effectiveFrom : startDate;
  const observationDays = history.plans.length ? Math.max(0, calendarDaysBetween(dailyStart, endDate) + 1) : 0;
  const eligibleDays = Array.from({ length: observationDays }, (_, n) => addCalendarDays(dailyStart, n)).filter((date) => {
    const plan = observationPlanForDate(history.plans, date);
    return plan && observationIsAnswerable(plan, date, now);
  });
  const observations = history.observations.filter((o) => o.referenceDate >= startDate && o.referenceDate <= endDate);
  const periods: InterventionEvidence["periods"] = [];
  const seen = new Set<string>();
  for (const date of eligibleDays) {
    const version = observationPlanForDate(history.plans, date)!;
    if (version.plan.method !== "daily_report" || !version.plan.target) continue;
    const target = version.plan.target;
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    const periodStart = target.window === "calendar_week" ? addCalendarDays(date, -((weekday + 6) % 7))
      : addCalendarDays(target.anchorDate!, Math.floor(calendarDaysBetween(target.anchorDate!, date) / 7) * 7);
    const periodEnd = addCalendarDays(periodStart, 6), key = `${version.id}:${periodStart}`;
    if (seen.has(key)) continue; seen.add(key);
    const periodDays = eligibleDays.filter((d) => d >= periodStart && d <= periodEnd && observationPlanForDate(history.plans, d)?.id === version.id);
    const counts = observationCounts(periodDays, observations);
    const partial = periodDays.length !== 7;
    // Missing/unknown never become failure. Partial windows never receive a fabricated proportional target.
    const targetMet = counts.met >= target.successfulDays ? true : !partial && counts.missing === 0 && counts.unknown === 0 && counts.noOpportunity === 0 ? false : null;
    periods.push({ planVersionId: version.id, startDate: periodStart, endDate: periodEnd, partial, target, counts, targetMet });
  }
  return { interventionId, generatedAt: now.toISOString(), window: { startDate, endDate }, plans: history.plans,
    observations, counts: observationCounts(eligibleDays, observations), periods,
    generatedTasks: generatedTasksForIntervention(db, interventionId),
    activity: buildReflectionBriefing(db, { subjectMemberId: access.ownerMemberId, days, scope: "all", now, window: { startDate, endDate } }),
  };
}
