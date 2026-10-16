import { makeReflectionBriefing } from "../test/fixtures";
import { expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import type { InterventionEvidence } from "@machbar/shared";
import { renderWithProviders } from "../test/testUtils";
import { InterventionEvidenceFacts } from "./InterventionEvidencePanel";

function evidence(method: "daily_report" | "task_evidence" | "reflection"): InterventionEvidence {
  return {
    interventionId: 1, generatedAt: "2026-10-16T10:00:00Z", window: { startDate: "2026-10-01", endDate: "2026-10-15" },
    plans: [{ id: 1, interventionId: 1, effectiveFrom: "2026-10-01", timezone: "Europe/Berlin", commitment: "Phone outside bedroom", createdAt: "2026-10-01T10:00:00Z", plan: method === "daily_report" ? { method, question: "In bed after brushing?", reference: "night", reportDayOffset: 1, availableAfter: "07:00", opportunityBased: false } : { method } }],
    observations: method === "daily_report" ? [{ id: 42, interventionId: 1, planVersionId: 1, revision: 1, referenceDate: "2026-10-14", answer: "unknown", notes: "Cannot remember last night", submittedAt: "2026-10-15T10:00:00Z", updatedAt: "2026-10-15T10:00:00Z" }] : [],
    counts: { eligible: method === "daily_report" ? 15 : 0, reported: method === "daily_report" ? 1 : 0, met: 0, notMet: 0, unknown: method === "daily_report" ? 1 : 0, noOpportunity: 0, missing: method === "daily_report" ? 14 : 0 },
    periods: [], generatedTasks: [],
    activity: makeReflectionBriefing({ finiteCompletions: [{ id: 7, title: "Piano practice", date: "2026-10-13", type: "task", href: null, currentItemAvailable: true }], bulkCompletionGroups: [], recurringWork: [] }),
  };
}
it("shows sparse dated reports, historical wording/notes and editable citations independently of totals", () => {
  const facts = evidence("daily_report"), onObservationChange = vi.fn(), onItemChange = vi.fn();
  renderWithProviders(<InterventionEvidenceFacts evidence={facts} selection={{ observationIds: [42], itemIds: [7], onObservationChange, onItemChange }} />);
  expect(screen.getAllByText("In bed after brushing?").length).toBeGreaterThan(0);
  expect(screen.getByText("Cannot remember last night")).toBeInTheDocument();
  const report = screen.getByRole("checkbox", { name: /2026-10-14/ });
  expect(report).toBeChecked(); fireEvent.click(report);
  fireEvent.click(screen.getByRole("checkbox", { name: /Piano practice/ }));
  expect(onObservationChange).toHaveBeenCalledWith([]);
  expect(onItemChange).toHaveBeenCalledWith([]);
  expect(facts.counts).toMatchObject({ reported: 1, unknown: 1, missing: 14 });
  expect(facts.observations[0]!.answer).toBe("unknown");
});
it.each(["task_evidence", "reflection"] as const)("avoids empty daily-report scores for %s evidence", (method) => {
  renderWithProviders(<InterventionEvidenceFacts evidence={evidence(method)} />);
  expect(screen.queryByText(/0 von 0/)).toBeNull();
  expect(screen.getByText(/Piano practice/)).toBeInTheDocument();
});
it("exposes historical selected references without offering to mutate the saved assessment", () => {
  renderWithProviders(<InterventionEvidenceFacts evidence={evidence("daily_report")} selection={{ observationIds: [42], itemIds: [] }} />);
  expect(screen.getByRole("checkbox", { name: /2026-10-14/ })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: /2026-10-14/ })).toBeDisabled();
  expect(screen.getByRole("checkbox", { name: /Piano practice/ })).not.toBeChecked();
});
