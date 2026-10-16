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
  recentReports?: Array<{ referenceDate: string; plan: ObservationPlanVersion }>;
  plans: ObservationPlanVersion[];
  observations: InterventionObservation[];
}
export interface DueInterventionReport {
  interventionId: number; goalId: number; goalTitle: string;
  referenceDate: string; plan: ObservationPlanVersion;
}

/** Only work created by the intervention, never arbitrary manual tagging. */
export interface InterventionTaskPlan {
  key: string; title: string; notes?: string; scheduledDate?: string;
  dueDate?: string; repeatAfterDays?: number; allowedDeviationDays?: number;
  reminders?: import("./taskReminder.js").TaskReminderInput[];
}
export interface InterventionGeneratedTask {
  id: number; key: string; taskId: number | null; originalTaskId: number;
  title: string; createdAt: string;
}

export interface ObservationCounts {
  eligible: number; reported: number; met: number; notMet: number;
  unknown: number; noOpportunity: number; missing: number;
}
export interface InterventionEvidence {
  interventionId: number; generatedAt: string; window: { startDate: string; endDate: string };
  plans: ObservationPlanVersion[]; observations: InterventionObservation[]; counts: ObservationCounts;
  periods: Array<{ planVersionId: number; startDate: string; endDate: string; partial: boolean;
    target: ObservationTarget; counts: ObservationCounts; targetMet: boolean | null }>;
  generatedTasks: InterventionGeneratedTask[];
  /** Reuses the historical reflection path. Task facts and reports measure separate facts. */
  activity: import("./index.js").ReflectionBriefing;
}
export type InterventionReviewDecision = "continue" | "adjust" | "stop";
export type InterventionBenefit = "helped" | "not_helped" | "uncertain";
