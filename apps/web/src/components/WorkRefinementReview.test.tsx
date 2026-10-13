import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { workRefinementProposalSchema, type IntakeRecord } from "@machbar/shared";
import { api, ApiError, request } from "../lib/api";
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
async function editDetails() {
  const toggle = screen.queryByRole("button", { name: "Details bearbeiten" });
  if (toggle) await userEvent.click(toggle);
}
vi.mock("../lib/identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/identity")>();
  return { ...actual, useIdentity: () => ({ members: [{ id: 1, name: "Mira", color: "#123456", pictureUrl: null }], currentMemberId: 1 }) };
});
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

function withProposalTitle(current: IntakeRecord, title: string, revision = 3): IntakeRecord {
  const next = structuredClone(current);
  const refinement = next.refinement;
  if (!refinement?.proposal) throw new Error("test record has no proposal");
  const first = refinement.proposal.changes[0];
  if (!first || !("title" in first)) throw new Error("test record has no titled change");
  next.revision = revision;
  next.refinement = {
    ...refinement,
    proposal: {
      ...refinement.proposal,
      changes: [{ ...first, title }, ...refinement.proposal.changes.slice(1)],
    },
  };
  return next;
}

describe("WorkRefinementReview", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("shows a compact title-only proposal without empty planning controls", () => {
    renderWithProviders(<WorkRefinementReview record={record()} onChange={vi.fn()} />);
    expect(screen.getByText("Kita-Formular → Kita-Formular im Sekretariat abgeben")).toBeInTheDocument();
    expect(screen.queryByLabelText("Geplantes Datum")).not.toBeInTheDocument();
    expect(document.querySelector(".refinement-compact-summary")?.textContent).not.toMatch(/Keine → Vorgeschlagen: Keine/);
    expect(screen.getByRole("button", { name: "Details bearbeiten" })).toBeInTheDocument();
  });

  it("shows the edited title as the resulting project title during conversion", () => {
    const current = record();
    current.text = JSON.stringify({ id: 4, title: "Kita-Formular", status: "captured", kind: "action", children: [] });
    current.refinement!.proposal = {
      intent: "structure", summary: "Ein kleines Projekt mit klaren Schritten.", disposition: "changes", question: null,
      changes: [
        { kind: "convert_task_to_project", targetId: 4, rationale: "Mehrere konkrete Schritte sollen koordiniert werden.", accepted: true },
        { kind: "update_task", targetId: 4, title: "Kita-Unterlagen zusammenstellen", notes: "Das Formular liegt bei Sarah.", rationale: "Der Titel benennt das gewünschte Ergebnis.", accepted: true },
        { kind: "create_child", parentTaskId: 4, title: "Formular bei Sarah abholen", rationale: "Die Unterlagen werden zuerst benötigt.", accepted: true },
        { kind: "create_child", parentTaskId: 4, title: "Formular im Sekretariat abgeben", rationale: "Danach kann es eingereicht werden.", accepted: true },
      ],
    };
    renderWithProviders(<WorkRefinementReview record={current} onChange={vi.fn()} />);
    const conversionCard = screen.getByText("In ein Projekt umwandeln").closest("article");
    expect(conversionCard).toHaveTextContent("Kita-Formular → Kita-Unterlagen zusammenstellen");
    expect(conversionCard).toHaveTextContent("Wird Backlog-Projekt.");
    expect(screen.getAllByText("Formular bei Sarah abholen")).toHaveLength(1);
  });

  it("flags and blocks incompatible selected conversion edits before saving or applying", async () => {
    const current = record();
    current.text = JSON.stringify({ id: 4, title: "Kita-Formular", status: "captured", kind: "action", children: [] });
    current.refinement!.proposal!.changes = [
      { kind: "convert_task_to_project", targetId: 4, rationale: "Mehrere Schritte koordinieren.", accepted: true },
      { kind: "update_task", targetId: 4, title: "Kita-Abgabe", scheduledDate: "2026-11-01", rationale: "Die Arbeit ist geplant.", accepted: true },
    ];
    renderWithProviders(<WorkRefinementReview record={current} onChange={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Bei einer Umwandlung in ein Projekt dürfen Titel und Notizen mitgeändert werden");
    expect(screen.getByRole("button", { name: "Ausgewählte Änderungen übernehmen" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Speichern" })).toBeDisabled();
    expect(mockedApi.updateWorkRefinement).not.toHaveBeenCalled();
    expect(mockedApi.applyWorkRefinement).not.toHaveBeenCalled();

    await userEvent.click(screen.getAllByRole("checkbox")[1]!);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ausgewählte Änderungen übernehmen" })).toBeEnabled();
  });

  it("surfaces the reported HTTP 400 envelope, keeps the accepted draft, and allows a successful retry", async () => {
    const current = record();
    current.text = JSON.stringify({ id: 4, title: "Kita-Formular", status: "captured", kind: "action", children: [] });
    current.refinement!.proposal!.changes = [
      { kind: "convert_task_to_project", targetId: 4, rationale: "Mehrere Schritte koordinieren.", accepted: true },
      { kind: "update_task", targetId: 4, title: "Kita-Unterlagen zusammenstellen", notes: "Formular liegt bei Sarah.", rationale: "Das Ergebnis wird klarer.", accepted: true },
      { kind: "create_child", parentTaskId: 4, title: "Formular abholen", rationale: "Zuerst das Formular beschaffen.", accepted: true },
    ];
    const failedResponse = {
      ok: false, status: 400, statusText: "Bad Request",
      json: async () => ({ error: { code: "intake_draft_invalid", message: "A role conversion cannot be combined with an edit to the same item." } }),
    } as Response;
    vi.stubGlobal("fetch", vi.fn(async () => failedResponse));
    const reportedError = await request("/intake/job/refinement/apply", { method: "POST", body: "{}" }).catch((cause) => cause);
    expect(reportedError).toMatchObject({ status: 400, code: "intake_draft_invalid", message: "A role conversion cannot be combined with an edit to the same item." });
    mockedApi.updateWorkRefinement.mockResolvedValue({ ...current, revision: 3 } as IntakeRecord);
    mockedApi.applyWorkRefinement.mockRejectedValueOnce(reportedError)
      .mockResolvedValueOnce({ ...current, status: "applied", revision: 4 } as IntakeRecord);
    const onChange = vi.fn();
    renderWithProviders(<WorkRefinementReview record={current} onChange={onChange} />);

    await userEvent.click(screen.getByRole("button", { name: "Ausgewählte Änderungen übernehmen" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Bei einer Umwandlung in ein Projekt dürfen Titel und Notizen mitgeändert werden");
    expect(alert).toHaveFocus();
    expect(screen.getAllByRole("checkbox").every((checkbox) => (checkbox as HTMLInputElement).checked)).toBe(true);
    expect(screen.getByText("Formular abholen")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Ausgewählte Änderungen übernehmen" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ status: "applied" })));
    expect(mockedApi.applyWorkRefinement).toHaveBeenCalledTimes(2);
  });

  it("announces stale apply failures in the foreground and allows retry", async () => {
    const current = record();
    const onChange = vi.fn();
    mockedApi.updateWorkRefinement.mockImplementation(async (_id, body) => ({
      ...current, revision: 3, refinement: { ...current.refinement!, proposal: body.proposal },
    } as IntakeRecord));
    mockedApi.applyWorkRefinement.mockRejectedValueOnce(new ApiError(409, "The proposal changed before apply.", "stale_write_conflict"))
      .mockResolvedValueOnce({ ...current, status: "applied", revision: 4 } as IntakeRecord);
    renderWithProviders(<WorkRefinementReview record={current} onChange={onChange} />);

    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: "Ausgewählte Änderungen übernehmen" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Dieser Eintrag wurde auf einem anderen Gerät geändert");
    expect(alert).toHaveFocus();
    expect(screen.getByRole("checkbox")).toBeChecked();

    await userEvent.click(screen.getByRole("button", { name: "Ausgewählte Änderungen übernehmen" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ status: "applied" })));
  });

  it("shows proposed dates and reminders together in household-local time", () => {
    const current = record();
    current.text = JSON.stringify({ id: 4, title: "Container vorbereiten", status: "actionable", kind: "action", children: [] });
    current.refinement!.proposal = {
      intent: "improve", summary: "Zwei konkrete Bringaktionen", disposition: "changes", question: null,
      changes: [{ kind: "create_child", parentTaskId: 4, title: "Kita A bringen", scheduledDate: "2026-10-13", reminders: [{ kind: "absolute", at: "2026-10-12T05:00:00.000Z" }], rationale: "Am Vortag erinnern.", accepted: false }],
    };
    renderWithProviders(<WorkRefinementReview record={current} onChange={vi.fn()} />);
    const card = screen.getByText("Kita A bringen").closest("article");
    expect(card).toHaveTextContent("Geplant für: 13.10.2026");
    expect(card).toHaveTextContent("12.10.2026 07:00");
    expect(card?.querySelector(".refinement-compact-summary")).not.toHaveTextContent("Keine → Vorgeschlagen: Keine");
  });

  it("keeps high-signal dates visible in the compact view at a narrow viewport", () => {
    const priorWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 360 });
    const current = record();
    current.text = JSON.stringify({ id: 4, title: "Kita-Sachen", status: "actionable", kind: "action", children: [] });
    current.refinement!.proposal = {
      intent: "improve", summary: "Bringtermine", disposition: "changes", question: null,
      changes: [{ kind: "create_child", parentTaskId: 4, title: "Kita-Formular abgeben", scheduledDate: "2026-10-13", reminders: [{ kind: "absolute", at: "2026-10-12T05:00:00.000Z" }], rationale: "Eine Erinnerung am Vortag ist vorgeschlagen.", accepted: false }],
    };
    try {
      renderWithProviders(<WorkRefinementReview record={current} onChange={vi.fn()} />);
      const summary = document.querySelector(".refinement-compact-summary");
      expect(summary).toHaveTextContent("13.10.2026");
      expect(summary).toHaveTextContent("12.10.2026 07:00");
      expect(screen.queryByLabelText("Geplant für")).not.toBeInTheDocument();
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: priorWidth });
    }
  });

  it("keeps unfinished revisit input while proposal details are collapsed and reopened", async () => {
    const current = record();
    current.refinement!.proposal = {
      intent: "improve", summary: "Wiedervorlage planen", disposition: "changes", question: null,
      changes: [{ kind: "update_task", targetId: 4, title: "Kita-Formular", rationale: "Keep the editor draft.", accepted: false }],
    };
    renderWithProviders(<WorkRefinementReview record={current} onChange={vi.fn()} />);
    await editDetails();
    fireEvent.change(screen.getByLabelText("Wiedervorlage-Datum"), { target: { value: "2026-10-19" } });
    await userEvent.click(screen.getByRole("button", { name: "Details schließen" }));
    await userEvent.click(screen.getByRole("button", { name: "Details bearbeiten" }));
    expect(screen.getByLabelText("Wiedervorlage-Datum")).toHaveValue("2026-10-19");
  });

  it("makes explicit deadline and reminder removals visible in the compact summary", () => {
    const current = record();
    current.text = JSON.stringify({ id: 4, title: "Frist prüfen", dueDate: "2026-10-19", reminders: [{ kind: "absolute", at: "2026-10-18T05:00:00.000Z" }], children: [] });
    current.refinement!.proposal!.changes = [{ kind: "update_task", targetId: 4, dueDate: null, reminders: [], rationale: "Die alten Erinnerungen passen nicht mehr.", accepted: false }];
    renderWithProviders(<WorkRefinementReview record={current} onChange={vi.fn()} />);
    expect(document.querySelector(".refinement-compact-summary")).toHaveTextContent("Fällig bis: 19.10.2026 → Frist entfernt");
    expect(document.querySelector(".refinement-compact-summary")).toHaveTextContent("Erinnerungen entfernt");
  });

  it("preserves edited fields across an equivalent background refresh", async () => {
    const current = record();
    const { rerender } = renderWithProviders(
      <WorkRefinementReview record={current} onChange={vi.fn()} />,
    );
    await editDetails();
    const title = screen.getByDisplayValue("Kita-Formular im Sekretariat abgeben");
    await userEvent.clear(title);
    await userEvent.type(title, "Kita-Formular persönlich abgeben");

    const refreshed = structuredClone(current);
    rerender(<WorkRefinementReview record={refreshed} onChange={vi.fn()} />);

    expect(screen.getByDisplayValue("Kita-Formular persönlich abgeben")).toBeInTheDocument();
  });

  it("keeps local edits and checkbox selections on same-revision refetches", async () => {
    const current = record();
    const { rerender } = renderWithProviders(
      <WorkRefinementReview record={current} onChange={vi.fn()} />,
    );
    await editDetails();
    const title = screen.getByDisplayValue("Kita-Formular im Sekretariat abgeben");
    await userEvent.clear(title);
    await userEvent.type(title, "Kita-Formular selbst abgeben");
    await userEvent.click(screen.getByRole("checkbox"));

    rerender(<WorkRefinementReview record={structuredClone(current)} onChange={vi.fn()} />);

    expect(screen.getByDisplayValue("Kita-Formular selbst abgeben")).toBeInTheDocument();
    expect(screen.getByRole("checkbox")).toBeChecked();
  });

  it("preserves edits made while Save is in flight and acknowledges the older response", async () => {
    const current = record();
    let resolveSave: ((value: IntakeRecord) => void) | undefined;
    mockedApi.updateWorkRefinement.mockReturnValue(
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
    );
    renderWithProviders(<WorkRefinementReview record={current} onChange={vi.fn()} />);
    await editDetails();
    const title = screen.getByDisplayValue("Kita-Formular im Sekretariat abgeben");
    await userEvent.clear(title);
    await userEvent.type(title, "Kita-Formular B");
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await userEvent.clear(title);
    await userEvent.type(title, "Kita-Formular C");

    resolveSave?.(withProposalTitle(current, "Kita-Formular B"));

    await waitFor(() =>
      expect(screen.getByDisplayValue("Kita-Formular C")).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Speichern" })).toBeEnabled();
  });

  it("reports a remote proposal conflict without replacing local edits", async () => {
    const current = record();
    const { rerender } = renderWithProviders(
      <WorkRefinementReview record={current} onChange={vi.fn()} />,
    );
    await editDetails();
    const title = screen.getByDisplayValue("Kita-Formular im Sekretariat abgeben");
    await userEvent.clear(title);
    await userEvent.type(title, "Lokale Änderung");

    rerender(<WorkRefinementReview record={withProposalTitle(current, "Entfernte Änderung")} onChange={vi.fn()} />);

    expect(screen.getByDisplayValue("Lokale Änderung")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Vorschlag wurde inzwischen geändert");
  });

  it("updates a clean editor when a newer server proposal arrives", async () => {
    const current = record();
    const { rerender } = renderWithProviders(
      <WorkRefinementReview record={current} onChange={vi.fn()} />,
    );
    await editDetails();
    rerender(<WorkRefinementReview record={withProposalTitle(current, "Neue Serverfassung")} onChange={vi.fn()} />);

    expect(await screen.findByDisplayValue("Neue Serverfassung")).toBeInTheDocument();
  });

  it("allows an intentional regeneration to replace the acknowledged proposal", async () => {
    const current = record();
    const regenerated = withProposalTitle(current, "Neu erzeugter Vorschlag");
    regenerated.revision = 4;
    mockedApi.updateWorkRefinement.mockResolvedValue(withProposalTitle(current, "Gespeicherte Änderung"));
    mockedApi.retryIntake.mockResolvedValue(regenerated);
    const onChange = vi.fn();
    const { rerender } = renderWithProviders(
      <WorkRefinementReview record={current} onChange={onChange} />,
    );

    await userEvent.type(screen.getByLabelText("Änderungswunsch"), "Bitte konkreter.");
    await userEvent.click(screen.getByRole("button", { name: "Vorschlag mit Feedback neu erstellen" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(regenerated));
    rerender(<WorkRefinementReview record={regenerated} onChange={onChange} />);

    expect(screen.getByDisplayValue("Neu erzeugter Vorschlag")).toBeInTheDocument();
  });

  it("freezes the editor from the start of Apply", async () => {
    const current = record();
    let resolveUpdate: ((value: IntakeRecord) => void) | undefined;
    mockedApi.updateWorkRefinement.mockImplementation(() => new Promise((resolve) => {
      resolveUpdate = resolve;
    }));
    mockedApi.applyWorkRefinement.mockResolvedValue({ ...current, status: "applied", revision: 5 } as IntakeRecord);
    renderWithProviders(<WorkRefinementReview record={current} onChange={vi.fn()} />);

    await editDetails();
    await userEvent.click(screen.getByRole("button", { name: "Ausgewählte Änderungen übernehmen" }));
    const title = screen.getByDisplayValue("Kita-Formular im Sekretariat abgeben");
    await waitFor(() => expect(title).toBeDisabled());
    resolveUpdate?.(withProposalTitle(current, "Änderung beim Start"));

    await waitFor(() => expect(mockedApi.applyWorkRefinement).toHaveBeenCalledWith("job", { expectedRevision: 3 }));
  });

  it("freezes the editor after the final persistence step until Apply completes", async () => {
    const current = record();
    let resolveApply: ((value: IntakeRecord) => void) | undefined;
    mockedApi.updateWorkRefinement.mockResolvedValue(withProposalTitle(current, "Gespeicherte Änderung"));
    mockedApi.applyWorkRefinement.mockReturnValue(new Promise((resolve) => {
      resolveApply = resolve;
    }));
    renderWithProviders(<WorkRefinementReview record={current} onChange={vi.fn()} />);

    await editDetails();
    await userEvent.click(screen.getByRole("button", { name: "Ausgewählte Änderungen übernehmen" }));
    const title = screen.getByDisplayValue("Gespeicherte Änderung");
    await waitFor(() => expect(title).toBeDisabled());
    expect(title).toHaveValue("Gespeicherte Änderung");

    resolveApply?.({ ...current, status: "applied", revision: 4 } as IntakeRecord);
    await waitFor(() => expect(mockedApi.applyWorkRefinement).toHaveBeenCalledWith("job", { expectedRevision: 3 }));
  });

  it("rejects a stale Save response after a newer remote revision was observed", async () => {
    const current = record();
    let resolveSave: ((value: IntakeRecord) => void) | undefined;
    const onChange = vi.fn();
    mockedApi.updateWorkRefinement.mockReturnValue(new Promise((resolve) => {
      resolveSave = resolve;
    }));
    const { rerender } = renderWithProviders(
      <WorkRefinementReview record={current} onChange={onChange} />,
    );
    await editDetails();
    const title = screen.getByDisplayValue("Kita-Formular im Sekretariat abgeben");
    await userEvent.clear(title);
    await userEvent.type(title, "Lokale Änderung");
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));

    rerender(
      <WorkRefinementReview
        record={withProposalTitle(current, "Entfernte Änderung", 4)}
        onChange={onChange}
      />,
    );
    resolveSave?.(withProposalTitle(current, "Veraltete Antwort", 3));

    await waitFor(() => expect(screen.getByDisplayValue("Lokale Änderung")).toBeInTheDocument());
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Vorschlag wurde inzwischen geändert");
  });

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

  it("requires an accepted parent before applying nested proposed steps", async () => {
    const current = record();
    current.text = JSON.stringify({ id: 4, title: "Kita vorbereiten", status: "actionable", kind: "action", children: [] });
    current.refinement!.proposal = {
      intent: "structure", summary: "Vorbereitung und Einreichen", disposition: "changes", question: null,
      changes: [
        { kind: "create_child", parentTaskId: 4, proposalKey: "prepare", title: "Formular vorbereiten", rationale: "Zuerst vorbereiten.", accepted: false },
        { kind: "create_child", parentProposalKey: "prepare", proposalKey: "submit", title: "Formular abgeben", rationale: "Danach einreichen.", accepted: true },
      ],
    };
    renderWithProviders(<WorkRefinementReview record={current} onChange={vi.fn()} />);
    const applyButton = screen.getByRole("button", { name: "Ausgewählte Änderungen übernehmen" });
    expect(applyButton).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Übernimm zuerst den übergeordneten Schritt");
    await userEvent.click(screen.getAllByRole("checkbox")[0]!);
    expect(applyButton).toBeEnabled();
  });

  it("adds a proposal-local key when reparenting an older unkeyed child", async () => {
    const current = record();
    current.text = JSON.stringify({ id: 4, title: "Kita vorbereiten", status: "actionable", kind: "action", children: [] });
    current.refinement!.proposal = {
      intent: "structure", summary: "Vorbereitung und Einreichen", disposition: "changes", question: null,
      changes: [
        { kind: "create_child", parentTaskId: 4, proposalKey: "prepare", title: "Formular vorbereiten", rationale: "Zuerst vorbereiten.", accepted: false },
        { kind: "create_child", parentTaskId: 4, title: "Formular abgeben", rationale: "Danach einreichen.", accepted: false },
      ],
    };
    mockedApi.updateWorkRefinement.mockResolvedValue(current);
    renderWithProviders(<WorkRefinementReview record={current} onChange={vi.fn()} />);
    const parentSelectors = screen.getAllByLabelText("Übergeordneter Schritt");

    await userEvent.selectOptions(parentSelectors[1]!, "proposal:prepare");
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));

    await waitFor(() => expect(mockedApi.updateWorkRefinement).toHaveBeenCalled());
    const saved = mockedApi.updateWorkRefinement.mock.calls[0]?.[1].proposal;
    expect(saved?.changes[1]).toMatchObject({
      kind: "create_child",
      parentProposalKey: "prepare",
      proposalKey: expect.stringMatching(/^review-child-2/),
    });
    expect(saved?.changes[1]).not.toHaveProperty("parentTaskId");
    expect(workRefinementProposalSchema.safeParse(saved).success).toBe(true);
  });

  it("shows cancellation impact and requires a reviewed descendant policy", async () => {
    const current = record();
    current.text = JSON.stringify({ id: 4, title: "Altes Vorhaben", status: "actionable", kind: "action", parentTaskId: null, children: [{ id: 5, title: "Offener Teilschritt", status: "actionable", kind: "action", parentTaskId: 4, children: [] }] });
    current.refinement!.proposal = {
      intent: "improve", summary: "Nicht mehr benötigt", disposition: "changes", question: null,
      changes: [{ kind: "cancel_task", targetId: 4, rationale: "Das Vorhaben ist überholt.", accepted: true }],
    };
    mockedApi.updateWorkRefinement.mockImplementation(async (_id, body) => ({ ...current, revision: 3, refinement: { ...current.refinement!, proposal: body.proposal } } as IntakeRecord));
    mockedApi.applyWorkRefinement.mockResolvedValue({ ...current, status: "applied", revision: 4 } as IntakeRecord);
    renderWithProviders(<WorkRefinementReview record={current} onChange={vi.fn()} />);
    const applyButton = screen.getByRole("button", { name: "Ausgewählte Änderungen übernehmen" });
    expect(screen.getByText("Offene Unteraufgaben: 1")).toBeInTheDocument();
    expect(applyButton).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText("Was soll mit den offenen Unteraufgaben geschehen?"), "cancel_children");
    expect(applyButton).toBeEnabled();
    await userEvent.click(applyButton);
    await waitFor(() => expect(mockedApi.updateWorkRefinement).toHaveBeenCalledWith("job", expect.objectContaining({
      proposal: expect.objectContaining({ changes: [expect.objectContaining({ descendantsPolicy: "cancel_children" })] }),
    })));
  });

  it("shows external wait resolution as separate from task completion", () => {
    const current = record();
    current.text = JSON.stringify({ id: 4, title: "Versicherung prüfen", status: "actionable", kind: "action", revisitAt: "2026-11-01T09:00:00.000Z", externalWait: { waitingFor: "Deckungszusage" }, children: [] });
    current.refinement!.proposal = {
      intent: "improve", summary: "Rückmeldung ist eingetroffen", disposition: "changes", question: null,
      changes: [{ kind: "resolve_wait", taskId: 4, rationale: "Die Versicherung hat geantwortet.", accepted: false }],
    };
    renderWithProviders(<WorkRefinementReview record={current} onChange={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Rückmeldung ist eingetroffen" })).toBeInTheDocument();
    expect(screen.getByText("Deckungszusage")).toBeInTheDocument();
    expect(screen.getAllByText("Beendet nur das Warten. Die Aufgabe bleibt offen.").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Ausgewählte Änderungen übernehmen" })).toBeEnabled();
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });

  it("reviews and edits schedule, deadline, revisit and reminder changes before applying", async () => {
    const current = record();
    current.text = JSON.stringify({
      id: 4, revision: 1, title: "Container service", status: "actionable", kind: "action",
      scheduledDate: null, dueDate: null, revisitAt: null,
      reminders: [], children: [],
    });
    current.refinement!.proposal = {
      intent: "improve", summary: "Die Arbeit für den Container ist planbar.", disposition: "changes", question: null,
      changes: [{ kind: "update_task", targetId: 4, title: "Container service", scheduledDate: "2026-10-13", dueDate: "2026-10-19", revisitAt: "2026-10-12T05:00:00.000Z", reminders: [{ kind: "absolute", at: "2026-10-12T05:00:00.000Z" }], rationale: "Planung und Wiedervorlage konkretisieren.", accepted: true }],
    };
    mockedApi.updateWorkRefinement.mockImplementation(async (_id, body) => ({
      ...current, revision: 3, refinement: { ...current.refinement!, proposal: body.proposal },
    } as IntakeRecord));
    mockedApi.applyWorkRefinement.mockResolvedValue({ ...current, status: "applied", revision: 4 } as IntakeRecord);
    renderWithProviders(<WorkRefinementReview record={current} onChange={vi.fn()} />);

    expect(document.querySelector(".refinement-compact-summary")).toHaveTextContent("Geplant für: Keine → 13.10.2026");
    expect(document.querySelector(".refinement-compact-summary")).toHaveTextContent("Fällig bis: Keine → 19.10.2026");
    expect(document.querySelector(".refinement-compact-summary")).toHaveTextContent("12.10.2026 07:00");
    expect(screen.queryByText(/Keine → Vorgeschlagen: Keine/)).not.toBeInTheDocument();
    await editDetails();
    expect(screen.getByRole("button", { name: "2026-10-12 · 07:00" })).toBeInTheDocument();
    expect(screen.getByText("Erinnerungen", { exact: true }).parentElement).toHaveTextContent("12.10.2026 07:00");
    await userEvent.click(screen.getByRole("button", { name: "Erinnerung entfernen" }));
    await userEvent.click(screen.getByRole("button", { name: "Ausgewählte Änderungen übernehmen" }));

    await waitFor(() => expect(mockedApi.applyWorkRefinement).toHaveBeenCalled());
    const updateBody = mockedApi.updateWorkRefinement.mock.calls[0]?.[1];
    expect(updateBody?.proposal?.changes[0]).toMatchObject({
      scheduledDate: "2026-10-13", dueDate: "2026-10-19", revisitAt: "2026-10-12T05:00:00.000Z", reminders: [],
    });
  });

  it("keeps an invalid household-local revisit draft and blocks applying it", async () => {
    const current = record();
    current.refinement!.proposal = {
      intent: "improve", summary: "Wiedervorlage präzisieren", disposition: "changes", question: null,
      changes: [{ kind: "update_task", targetId: 4, title: "Kita-Formular", rationale: "A focused edit." , accepted: true }],
    };
    renderWithProviders(<WorkRefinementReview record={current} onChange={vi.fn()} />);
    await editDetails();
    fireEvent.change(screen.getByLabelText("Wiedervorlage-Datum"), { target: { value: "2026-03-29" } });
    fireEvent.change(screen.getByLabelText("Wiedervorlage-Uhrzeit"), { target: { value: "02:30" } });
    expect(screen.getByRole("alert")).toHaveTextContent("Bitte vervollständige oder verwirf");

    await userEvent.click(screen.getByRole("button", { name: "Ausgewählte Änderungen übernehmen" }));
    expect(mockedApi.updateWorkRefinement).not.toHaveBeenCalled();
    expect(mockedApi.applyWorkRefinement).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Wiedervorlage-Datum")).toHaveValue("2026-03-29");
    expect(screen.getByLabelText("Wiedervorlage-Uhrzeit")).toHaveValue("02:30");
  });

  it("preserves unfinished revisit and reminder editor input through a conflicting proposal refresh", async () => {
    const current = record();
    current.refinement!.proposal = {
      intent: "improve", summary: "Plan the task", disposition: "changes", question: null,
      changes: [{ kind: "update_task", targetId: 4, title: "Kita-Formular", rationale: "Clarify the next action.", accepted: false }],
    };
    const { rerender, container } = renderWithProviders(<WorkRefinementReview record={current} onChange={vi.fn()} />);

    await editDetails();
    fireEvent.change(screen.getByLabelText("Wiedervorlage-Datum"), { target: { value: "2026-03-29" } });
    fireEvent.change(screen.getByLabelText("Wiedervorlage-Uhrzeit"), { target: { value: "02:30" } });
    await userEvent.click(screen.getByRole("button", { name: "+ Erinnerung" }));
    await userEvent.click(screen.getByRole("button", { name: "Benutzerdefiniert …" }));
    const reminderDate = container.querySelector<HTMLInputElement>("#reminder-date-new");
    expect(reminderDate).not.toBeNull();
    fireEvent.change(reminderDate!, { target: { value: "20.10.2026" } });

    rerender(<WorkRefinementReview record={withProposalTitle(current, "Remote title change")} onChange={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("Der Vorschlag wurde inzwischen geändert. Deine lokalen Änderungen bleiben erhalten. Prüfe sie und speichere sie erneut.")).toBeInTheDocument());
    expect(screen.getByDisplayValue("Kita-Formular")).toBeInTheDocument();
    expect(screen.getByLabelText("Wiedervorlage-Datum")).toHaveValue("2026-03-29");
    expect(screen.getByLabelText("Wiedervorlage-Uhrzeit")).toHaveValue("02:30");
    expect(container.querySelector<HTMLInputElement>("#reminder-date-new")).toHaveValue("20.10.2026");
  });

  it("preserves reminder-only editor input through a conflicting proposal refresh", async () => {
    const current = record();
    current.refinement!.proposal = {
      intent: "improve", summary: "Plan the task", disposition: "changes", question: null,
      changes: [{ kind: "update_task", targetId: 4, title: "Kita-Formular", rationale: "Clarify the next action.", accepted: false }],
    };
    const { rerender, container } = renderWithProviders(<WorkRefinementReview record={current} onChange={vi.fn()} />);

    await editDetails();
    await userEvent.click(screen.getByRole("button", { name: "+ Erinnerung" }));
    await userEvent.click(screen.getByRole("button", { name: "Benutzerdefiniert …" }));
    const reminderDate = container.querySelector<HTMLInputElement>("#reminder-date-new");
    expect(reminderDate).not.toBeNull();
    fireEvent.change(reminderDate!, { target: { value: "20.10.2026" } });

    rerender(<WorkRefinementReview record={withProposalTitle(current, "Remote title change")} onChange={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("Der Vorschlag wurde inzwischen geändert. Deine lokalen Änderungen bleiben erhalten. Prüfe sie und speichere sie erneut.")).toBeInTheDocument());
    expect(screen.getByDisplayValue("Kita-Formular")).toBeInTheDocument();
    expect(container.querySelector<HTMLInputElement>("#reminder-date-new")).toHaveValue("20.10.2026");
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

  it("shows a meaningful move summary instead of a numeric position control", () => {
    const current = record();
    current.text = JSON.stringify({ id: 4, title: "Project", tasks: [
      { id: 8, title: "Prepare", position: 0, parentTaskId: null, projectId: 4, children: [] },
      { id: 9, title: "Book", position: 1, parentTaskId: null, projectId: 4, children: [] },
    ], projects: [] });
    current.refinement!.targetType = "project";
    current.refinement!.proposal!.changes = [{ kind: "move_task", targetId: 9, parentTaskId: null, projectId: 4, position: 0, rationale: "Vorbereitung soll vor der Buchung stattfinden.", accepted: false }];
    renderWithProviders(<WorkRefinementReview record={current} onChange={vi.fn()} />);
    expect(document.querySelector(".refinement-compact-summary")).toHaveTextContent("Book → Project · An den Anfang");
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
  });

  it("allows a captured-task child without converting the task into a project", () => {
    const current = record();
    current.text = JSON.stringify({ id: 4, title: "Haustür", status: "captured", kind: "action", children: [] });
    current.refinement!.proposal!.changes = [
      { kind: "create_child", parentTaskId: 4, title: "Montage klären", rationale: "Nächster Schritt.", accepted: true },
      { kind: "convert_task_to_project", targetId: 4, rationale: "Ermöglicht Schritte.", accepted: false },
    ];
    renderWithProviders(<WorkRefinementReview record={current} onChange={vi.fn()} />);
    expect(screen.queryByText("Dieser Schritt kann nur zusammen mit der Umwandlung in ein Projekt übernommen werden.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ausgewählte Änderungen übernehmen" })).toBeEnabled();
  });

  it("does not warn that canonical conversion loses preserved task metadata", async () => {
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
    expect(screen.queryByText("Priorität und Aufgabengröße werden bei der Umwandlung in ein Projekt nicht übernommen.")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox"));
    expect(screen.queryByText("Priorität und Aufgabengröße werden bei der Umwandlung in ein Projekt nicht übernommen.")).not.toBeInTheDocument();
  });

  it("collects a server-required next action for a typed conversion and retries Apply", async () => {
    const current = record();
    current.text = JSON.stringify({
      id: 4, title: "Haustür montieren", status: "actionable", ownerMemberId: 1,
      dueDate: null, scheduledDate: null, revisitAt: null, reminders: [], children: [],
    });
    current.refinement!.proposal!.changes = [
      { kind: "convert_task_to_project", targetId: 4, rationale: "Make the next action visible.", accepted: false },
    ];
    const activationError = Object.assign(new Error("This commitment needs a viable next action."), {
      code: "project_commitment_resolution_required",
      details: {
        projects: [{ projectId: 4, title: "Haustür montieren", ownerMemberId: 1, revision: 2, required: ["progressPath"] }],
        expectedProjects: [{ projectId: 4, revision: 2 }],
      },
    });
    mockedApi.updateWorkRefinement.mockImplementation(async (_id, body) => ({
      ...current, revision: 3, refinement: { ...current.refinement!, proposal: body.proposal },
    } as IntakeRecord));
    mockedApi.applyWorkRefinement.mockRejectedValueOnce(activationError as never)
      .mockResolvedValueOnce({ ...current, status: "applied", revision: 4 } as IntakeRecord);
    renderWithProviders(<WorkRefinementReview record={current} onChange={vi.fn()} />);

    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: "Ausgewählte Änderungen übernehmen" }));
    const nextAction = await screen.findByLabelText("Welcher konkrete nächste Schritt bringt das Projekt voran?");
    expect(document.activeElement).toHaveAttribute("tabindex", "-1");
    await userEvent.type(nextAction, "Montage-Termin abstimmen");
    await userEvent.click(screen.getByRole("button", { name: "Ausgewählte Änderungen übernehmen" }));
    await waitFor(() => expect(mockedApi.applyWorkRefinement).toHaveBeenCalledTimes(2));
    expect(mockedApi.applyWorkRefinement.mock.calls[1]?.[1]).toMatchObject({
      activationResolution: {
        expectedProjects: [{ projectId: 4, revision: 2 }],
        drivers: [],
        nextActionTitle: "Montage-Termin abstimmen",
      },
    });
  });

  it.each(["captured", "someday"] as const)("does not warn about preserved metadata for a %s conversion", (status) => {
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
    expect(screen.queryByText("Priorität und Aufgabengröße werden bei der Umwandlung in ein Projekt nicht übernommen.")).not.toBeInTheDocument();
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
