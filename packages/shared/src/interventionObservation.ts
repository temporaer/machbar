/** Bounded evidence contracts: calendar-day reports, task evidence or reflection. */
export type ObservationAnswer = "met" | "not_met" | "unknown" | "no_opportunity";
export interface ObservationTarget {
  successfulDays: number;
  window: "calendar_week" | "seven_days";
  /** Required anchor for consecutive seven-day windows. Calendar weeks start Monday. */
  anchorDate?: string;
}
export type ObservationPlan =
  | { method: "task_evidence" | "reflection" }
  | { method: "daily_report"; question: string; reference: "day" | "night";
      /** Same-day after a closed window or following morning, in the snapshotted zone. */
      reportDayOffset: 0 | 1; availableAfter: string; opportunityBased: boolean;
      target?: ObservationTarget };
export interface ObservationPlanVersion {
  id: number; interventionId: number; effectiveFrom: string; timezone: string;
  commitment: string; plan: ObservationPlan; createdAt: string;
}
export interface InterventionObservation {
  id: number; interventionId: number; planVersionId: number; revision: number;
  referenceDate: string; submittedAt: string; updatedAt: string;
  answer: ObservationAnswer; notes: string;
}
export interface InterventionObservationHistory {
  plans: ObservationPlanVersion[];
  observations: InterventionObservation[];
}
