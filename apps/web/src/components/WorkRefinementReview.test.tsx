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
function record(disposition: "changes" | "clarification" | "leave_alone" = "changes", status: IntakeRecord["status"] = "ready"): IntakeRecord {
  return {
    id: "job", status, revision: 2, createdAt: "now", expiresAt: "later", text: JSON.stringify({ id: 4, title: "Kita-Formular", children: [] }), retryHint: null,
    attachments: [], draft: null, error: status === "analysis_failed" ? { code: "ai_error", message: "Die Analyse ist fehlgeschlagen." } : null, applyResults: null, homeAssistant: { workerOnline: true }, paperlessAvailable: false, breakdown: null,
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
    expect(mockedApi.updateWorkRefinement).toHaveBeenCalledWith("job", expect.objectContaining({ expectedRevision: 2 }));
  });

  it("shows a meaningful place for moves instead of a numeric position control", () => {
    const current = record();
    current.text = JSON.stringify({ id: 4, title: "Project", tasks: [
      { id: 8, title: "Prepare", position: 0, parentTaskId: null, projectId: 4, children: [] },
      { id: 9, title: "Book", position: 1, parentTaskId: null, projectId: 4, children: [] },
    ], projects: [] });
    current.refinement!.targetType = "project";
    current.refinement!.proposal!.changes = [{ kind: "move_task", targetId: 9, parentTaskId: null, projectId: 4, position: 0, rationale: "Vorbereitung soll vor der Buchung stattfinden.", accepted: false }];
    renderWithProviders(<WorkRefinementReview record={current} onChange={vi.fn()} />);
    expect(screen.getByRole("link", { name: "Book" })).toHaveAttribute("href", "/tasks/9");
    expect(screen.getByLabelText("Einordnen")).toHaveDisplayValue("An den Anfang");
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
  });

  it("requires accepting the conversion before a captured-task child and explains the dependency", () => {
    const current = record();
    current.text = JSON.stringify({ id: 4, title: "Haustür", status: "captured", kind: "action", children: [] });
    current.refinement!.proposal!.changes = [
      { kind: "create_child", parentTaskId: 4, title: "Montage klären", rationale: "Nächster Schritt.", accepted: true },
      { kind: "convert_task_to_project", targetId: 4, rationale: "Ermöglicht Schritte.", accepted: false },
    ];
    renderWithProviders(<WorkRefinementReview record={current} onChange={vi.fn()} />);
    expect(screen.getByText("Dieser Schritt kann nur zusammen mit der Umwandlung in ein Projekt übernommen werden.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ausgewählte Änderungen übernehmen" })).toBeDisabled();
  });

  it("warns about task-only metadata while an actionable conversion is selected", async () => {
    const current = record();
    current.text = JSON.stringify({
      id: 4,
      title: "Haustür",
      status: "actionable",
      ownerMemberId: 1,
      priority: 2,
      size: "L",
      children: [],
    });
    current.refinement!.proposal!.changes = [{
      kind: "convert_task_to_project",
      targetId: 4,
      rationale: "Ermöglicht mehrere Schritte.",
      accepted: true,
    }];
    renderWithProviders(<WorkRefinementReview record={current} onChange={vi.fn()} />);
    expect(screen.getByText("Priorität und Aufgabengröße werden bei der Umwandlung in ein Projekt nicht übernommen.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox"));
    expect(screen.queryByText("Priorität und Aufgabengröße werden bei der Umwandlung in ein Projekt nicht übernommen.")).not.toBeInTheDocument();
  });

  it.each(["captured", "someday"] as const)("warns about task-only metadata for a %s conversion", (status) => {
    const current = record();
    current.text = JSON.stringify({
      id: 4,
      title: "Haustür",
      status,
      ownerMemberId: null,
      priority: 1,
      size: "M",
      children: [],
    });
    current.refinement!.proposal!.changes = [{
      kind: "convert_task_to_project",
      targetId: 4,
      rationale: "Ermöglicht mehrere Schritte.",
      accepted: true,
    }];
    renderWithProviders(<WorkRefinementReview record={current} onChange={vi.fn()} />);
    expect(screen.getByText("Priorität und Aufgabengröße werden bei der Umwandlung in ein Projekt nicht übernommen.")).toBeInTheDocument();
  });

  it("shows the concise leave-alone confirmation and original-item link", () => {
    const current = record("leave_alone");
    renderWithProviders(<WorkRefinementReview record={current} onChange={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Passt so – die Arbeit ist bereits konkret und ausführbar." })).toBeInTheDocument();
    expect(screen.getByText("Den nächsten Schritt sichtbar machen.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Zur ursprünglichen Aufgabe" })).toHaveAttribute("href", "/tasks/4");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Passt so" })).toBeEnabled();
  });

  it("allows feedback and regeneration for a leave-alone proposal", async () => {
    const current = record("leave_alone");
    mockedApi.updateWorkRefinement.mockResolvedValue({ ...current, revision: 3 } as IntakeRecord);
    mockedApi.retryIntake.mockResolvedValue({ ...current, status: "queued", revision: 4 } as IntakeRecord);
    renderWithProviders(<WorkRefinementReview record={current} onChange={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Änderungswunsch"), "Bitte prüfe noch den Ablageort.");
    await userEvent.click(screen.getByRole("button", { name: "Vorschlag mit Feedback neu erstellen" }));
    await waitFor(() => expect(mockedApi.retryIntake).toHaveBeenCalledWith("job", "Bitte prüfe noch den Ablageort."));
    expect(mockedApi.updateWorkRefinement).toHaveBeenCalledWith("job", expect.objectContaining({ expectedRevision: 2, proposal: current.refinement!.proposal }));
  });

  it("shows a failed leave-alone proposal with its error and an enabled retry", async () => {
    const current = record("leave_alone", "analysis_failed");
    mockedApi.updateWorkRefinement.mockResolvedValue({ ...current, revision: 3 } as IntakeRecord);
    mockedApi.retryIntake.mockResolvedValue({ ...current, status: "queued", revision: 4 } as IntakeRecord);
    renderWithProviders(<WorkRefinementReview record={current} onChange={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Die Analyse ist fehlgeschlagen.");
    await userEvent.type(screen.getByLabelText("Änderungswunsch"), "Bitte den nächsten Schritt noch einmal bewerten.");
    await userEvent.click(screen.getByRole("button", { name: "Vorschlag mit Feedback neu erstellen" }));
    await waitFor(() => expect(mockedApi.retryIntake).toHaveBeenCalledWith("job", "Bitte den nächsten Schritt noch einmal bewerten."));
    expect(screen.getByRole("button", { name: "Passt so" })).toBeDisabled();
    expect(mockedApi.applyWorkRefinement).not.toHaveBeenCalled();
  });

  it.each(["analysis_failed", "analyzing"] as const)("does not allow applying a leave-alone proposal while %s", (status) => {
    const current = record("leave_alone", status);
    renderWithProviders(<WorkRefinementReview record={current} onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Passt so" })).toBeDisabled();
    expect(mockedApi.applyWorkRefinement).not.toHaveBeenCalled();
  });

  it("offers retry without requiring feedback after failed leave-alone analysis", async () => {
    const current = record("leave_alone", "analysis_failed");
    mockedApi.updateWorkRefinement.mockResolvedValue({ ...current, revision: 3 } as IntakeRecord);
    mockedApi.retryIntake.mockResolvedValue({ ...current, status: "queued", revision: 4 } as IntakeRecord);
    renderWithProviders(<WorkRefinementReview record={current} onChange={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Erneut analysieren" }));
    await waitFor(() => expect(mockedApi.retryIntake).toHaveBeenCalledWith("job", ""));
  });

  it("keeps application disabled while a non-leave-alone proposal is processing", () => {
    const current = record("changes", "analyzing");
    renderWithProviders(<WorkRefinementReview record={current} onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Ausgewählte Änderungen übernehmen" })).toBeDisabled();
    expect(mockedApi.applyWorkRefinement).not.toHaveBeenCalled();
  });

  it("can confirm leave-alone without a source mutation", async () => {
    const current = record("leave_alone");
    mockedApi.updateWorkRefinement.mockResolvedValue({ ...current, revision: 3 } as IntakeRecord);
    mockedApi.applyWorkRefinement.mockResolvedValue({ ...current, status: "applied", revision: 4 } as IntakeRecord);
    renderWithProviders(<WorkRefinementReview record={current} onChange={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Passt so" }));
    await waitFor(() => expect(mockedApi.applyWorkRefinement).toHaveBeenCalled());
  });
});
