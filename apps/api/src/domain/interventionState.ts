import type { InterventionDerivedState } from "@machbar/shared";
import { addCalendarDays } from "./calendarDate.js";

/**
 * How long a finished-but-unreviewed intervention keeps surfacing its review
 * call-to-action in Heute (§5, §6). After this window it leaves Heute for the
 * Goals page but stays reviewable and is never auto-assessed.
 */
export const INTERVENTION_REVIEW_WINDOW_DAYS = 7;

export interface InterventionStateInput {
  /** The intervention's revisit date (`YYYY-MM-DD`). */
  revisitDate: string;
  /** Whether at least one assessment row exists for the intervention. */
  hasAssessment: boolean;
  /** Current calendar date (`YYYY-MM-DD`) in the household timezone. */
  today: string;
  /**
   * Stored lifecycle status. A concluded intervention with no assessment is
   * still "finished" rather than "running" even before its revisit date.
   */
  concluded?: boolean;
}

export interface InterventionState {
  derivedState: InterventionDerivedState;
  /**
   * True only while a finished, unreviewed intervention is still inside the
   * 7-day review window (`today <= revisit_date + 7`). False while running and
   * false once reviewed.
   */
  withinReviewWindow: boolean;
}

/**
 * Derives the user-facing `running | finished | reviewed` state (§5) purely
 * from the revisit date, whether an assessment exists, and today's household
 * date. Nothing here is stored or time-triggered; every caller computes it at
 * read time. Calendar dates compare lexicographically because they are strict
 * `YYYY-MM-DD` values.
 */
export function deriveInterventionState(input: InterventionStateInput): InterventionState {
  if (input.hasAssessment && input.concluded) {
    return { derivedState: "reviewed", withinReviewWindow: false };
  }
  const reached = input.today >= input.revisitDate;
  if (!reached && !input.concluded) {
    return { derivedState: "running", withinReviewWindow: false };
  }
  const windowEnd = addCalendarDays(input.revisitDate, INTERVENTION_REVIEW_WINDOW_DAYS);
  return {
    derivedState: "finished",
    withinReviewWindow: input.today <= windowEnd,
  };
}
