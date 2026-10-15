import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../test/testUtils";
import { api } from "../lib/api";
import { InterventionReportCard } from "./InterventionObservationPanel";
afterEach(() => vi.restoreAllMocks());
it("shows the reference night and records a negative answer without requiring notes", async () => {
  const record = vi.spyOn(api, "recordObservation").mockResolvedValue({ id: 1, interventionId: 1, planVersionId: 1, referenceDate: "2026-10-24", revision: 1, answer: "not_met", notes: "", submittedAt: "2026-10-25T07:00:00Z", updatedAt: "2026-10-25T07:00:00Z" });
  renderWithProviders(<InterventionReportCard report={{ goalId: 2, goalTitle: "Sleep", interventionId: 1, referenceDate: "2026-10-24", plan: { id: 1, interventionId: 1, effectiveFrom: "2026-10-24", commitment: "Bed", timezone: "Europe/Berlin", createdAt: "2026-10-24T00:00:00Z", plan: { method: "daily_report", question: "In bed after brushing?", reference: "night", reportDayOffset: 1, availableAfter: "07:00", opportunityBased: false } } }} />);
  expect(screen.getByText(/2026-10-24/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Keine Gelegenheit" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Nein" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Rückmeldung gespeichert"));
  expect(record).toHaveBeenCalledWith(1, { referenceDate: "2026-10-24", answer: "not_met", notes: "", expectedRevision: 0 });
});
