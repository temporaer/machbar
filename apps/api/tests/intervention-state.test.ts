import { describe, expect, it } from "vitest";
import {
  INTERVENTION_REVIEW_WINDOW_DAYS,
  deriveInterventionState,
} from "../src/domain/interventionState.js";
import { localDate } from "../src/domain/householdCalendar.js";

describe("deriveInterventionState", () => {
  it("is running before the revisit date with no assessment", () => {
    expect(
      deriveInterventionState({ revisitDate: "2026-03-10", hasFinalAssessment: false, today: "2026-03-09" }),
    ).toEqual({ derivedState: "running", withinReviewWindow: false });
  });

  it("is finished and within the review window on the revisit date", () => {
    expect(
      deriveInterventionState({ revisitDate: "2026-03-10", hasFinalAssessment: false, today: "2026-03-10" }),
    ).toEqual({ derivedState: "finished", withinReviewWindow: true });
  });

  it("stays within the review window on the 7th day after revisit", () => {
    const today = "2026-03-17"; // revisit + 7
    expect(
      deriveInterventionState({ revisitDate: "2026-03-10", hasFinalAssessment: false, today }),
    ).toEqual({ derivedState: "finished", withinReviewWindow: true });
  });

  it("leaves the review window on the 8th day after revisit", () => {
    const today = "2026-03-18"; // revisit + 8
    expect(
      deriveInterventionState({ revisitDate: "2026-03-10", hasFinalAssessment: false, today }),
    ).toEqual({ derivedState: "finished", withinReviewWindow: false });
  });

  it("is reviewed once a concluded intervention has a final-period assessment", () => {
    expect(
      deriveInterventionState({ revisitDate: "2026-03-10", hasFinalAssessment: true, concluded: true, today: "2026-03-09" }),
    ).toEqual({ derivedState: "reviewed", withinReviewWindow: false });
    expect(
      deriveInterventionState({ revisitDate: "2026-03-10", hasFinalAssessment: true, concluded: true, today: "2026-04-01" }),
    ).toEqual({ derivedState: "reviewed", withinReviewWindow: false });
  });

  it("treats an early-concluded, unassessed intervention as finished", () => {
    expect(
      deriveInterventionState({
        revisitDate: "2026-03-10",
        hasFinalAssessment: false,
        today: "2026-03-05",
        concluded: true,
      }),
    ).toEqual({ derivedState: "finished", withinReviewWindow: true });
  });

  it("uses a fixed 7-day review window", () => {
    expect(INTERVENTION_REVIEW_WINDOW_DAYS).toBe(7);
  });

  describe("across the household-timezone date boundary", () => {
    // 2026-03-10T10:30:00Z is 2026-03-10 in UTC but already 2026-03-11 in
    // Pacific/Kiritimati (UTC+14) and still 2026-03-09 in Pacific/Niue (UTC-11).
    // The derived state must follow the household-local calendar day.
    const instant = new Date("2026-03-10T10:30:00.000Z");
    const revisitDate = "2026-03-10";

    it("is finished east of the line where the local day has already reached revisit", () => {
      const today = localDate(instant, "Pacific/Kiritimati");
      expect(today).toBe("2026-03-11");
      expect(
        deriveInterventionState({ revisitDate, hasFinalAssessment: false, today }),
      ).toEqual({ derivedState: "finished", withinReviewWindow: true });
    });

    it("is still running west of the line where the local day lags behind revisit", () => {
      const today = localDate(instant, "Pacific/Niue");
      expect(today).toBe("2026-03-09");
      expect(
        deriveInterventionState({ revisitDate, hasFinalAssessment: false, today }),
      ).toEqual({ derivedState: "running", withinReviewWindow: false });
    });
  });
});
