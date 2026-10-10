import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { IntakeRecord } from "@machbar/shared";
import { api } from "../lib/api";
import { renderWithProviders } from "../test/testUtils";
import { WorkRefinementReview } from "./WorkRefinementReview";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, api: {
    ...actual.api,
    updateWorkRefinement: vi.fn(), applyWorkRefinement: vi.fn(), retryIntake: vi.fn(), deleteIntake: vi.fn(),
  } };
});
const mockedApi = vi.mocked(api, true);
function record(disposition: "changes" | "clarification" = "changes"): IntakeRecord {
  return {
    id: "job", status: "ready", revision: 2, createdAt: "now", expiresAt: "later", text: JSON.stringify({ id: 4, title: "Kita-Formular", children: [] }), retryHint: null,
    attachments: [], draft: null, error: null, applyResults: null, homeAssistant: { workerOnline: true }, paperlessAvailable: false, breakdown: null,
    refinement: { targetType: "task", targetId: 4, intent: "improve", proposal: {
      intent: "improve", summary: "Den nächsten Schritt sichtbar machen.", disposition,
      question: disposition === "clarification" ? "Geht es noch um Auswahl oder nur um Montage?" : null,
      changes: disposition === "changes" ? [{ kind: "update_task", targetId: 4, title: "Kita-Formular im Sekretariat abgeben", rationale: "Die Handlung wird klar.", accepted: false }] : [],
    } },
  } as IntakeRecord;
}

describe("WorkRefinementReview", () => {
  beforeEach(() => vi.clearAllMocks());
  it("lets the user accept an individual edit and applies the reviewed proposal", async () => {
    const current = record();
    mockedApi.updateWorkRefinement.mockImplementation(async (_id, body) => ({ ...current, revision: 3, refinement: { ...current.refinement!, proposal: body.proposal } } as IntakeRecord));
    mockedApi.applyWorkRefinement.mockResolvedValue({ ...current, status: "applied", revision: 4 } as IntakeRecord);
    renderWithProviders(<WorkRefinementReview record={current} onChange={vi.fn()} />);
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: "Ausgewählte Änderungen übernehmen" }));
    await waitFor(() => expect(mockedApi.updateWorkRefinement).toHaveBeenCalledWith("job", expect.objectContaining({
      expectedRevision: 2,
      proposal: expect.objectContaining({ changes: [expect.objectContaining({ accepted: true })] }),
    })));
    expect(mockedApi.applyWorkRefinement).toHaveBeenCalledWith("job", { expectedRevision: 3 });
  });

  it("requires an answer to a clarification before it can be applied", async () => {
    const current = record("clarification");
    mockedApi.retryIntake.mockResolvedValue({ ...current, status: "queued", revision: 3 } as IntakeRecord);
    renderWithProviders(<WorkRefinementReview record={current} onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Ausgewählte Änderungen übernehmen" })).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Deine Antwort"), "Es geht nur noch um die Montage.");
    await userEvent.click(screen.getByRole("button", { name: "Mit Antwort neu prüfen" }));
    await waitFor(() => expect(mockedApi.retryIntake).toHaveBeenCalledWith("job", "Es geht nur noch um die Montage."));
  });
});
