import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import type { CleanupRoundItemRecord, CleanupRoundRecord } from "@machbar/shared";
import { renderWithProviders } from "../test/testUtils";
import { api } from "../lib/api";
import { useTaskWorkflow } from "../lib/taskWorkflowContext";
import { useTaskDetail } from "../lib/taskDetailContext";
import { makeProject, makeTask } from "../test/fixtures";
import { CleanupRoundPage } from "./CleanupRoundPage";

vi.mock("../lib/api", () => ({
  api: {
    getAuthStatus: vi.fn().mockResolvedValue({ enabled: false, authenticated: false, member: null }),
    getMembers: vi.fn().mockResolvedValue([]),
    createCleanupRound: vi.fn(),
    getCleanupRound: vi.fn(),
    retryCleanupRound: vi.fn(),
    dismissCleanupRound: vi.fn(),
    resolveCleanupRoundItem: vi.fn(),
    applyCleanupRoundAction: vi.fn(),
    getProject: vi.fn(),
    getTask: vi.fn(),
    updateTask: vi.fn(),
    updateProject: vi.fn(),
    appendTaskNotes: vi.fn(),
    appendProjectNotes: vi.fn(),
    createTask: vi.fn(),
    createChildTask: vi.fn(),
    addCriterion: vi.fn(),
    acknowledgeTaskReview: vi.fn(),
    acknowledgeProjectReview: vi.fn(),
  },
}));

const mocked = vi.mocked(api);

function item(overrides: Partial<CleanupRoundItemRecord> = {}): CleanupRoundItemRecord {
  return {
    id: "item-1",
    targetType: "task",
    targetId: 7,
    targetRevision: 1,
    status: "ready",
    title: "Keller",
    exists: true,
    projectTitle: "Haus",
    parentTitle: null,
    itemStatus: "actionable",
    result: {
      targetType: "task",
      targetId: 7,
      proposal: "identify_first_slice",
      resolutionSurface: "create_first_slice",
      inferredWorkType: "debt",
      inferredFlow: "uphill",
      confidence: "medium",
      reason: "Der Keller ist zu breit für eine Aufgabe.",
      question: "Welche Ecke stört am meisten?",
      suggestedDefault: "Werkzeugecke sortieren",
      suggestedTitle: null,
      suggestedShape: null,
    },
    ...overrides,
  };
}

function round(overrides: Partial<CleanupRoundRecord> = {}): CleanupRoundRecord {
  return {
    id: "r1",
    status: "ready",
    revision: 2,
    scope: "household",
    createdAt: "2026-10-06T10:00:00.000Z",
    updatedAt: "2026-10-06T10:00:00.000Z",
    expiresAt: "2026-10-07T10:00:00.000Z",
    summary: null,
    items: [item()],
    warnings: [],
    error: null,
    homeAssistant: { workerOnline: true },
    ...overrides,
  };
}

function WorkflowProbe() {
  const workflow = useTaskWorkflow();
  return workflow.current ? (
    <output data-testid="workflow">
      {`${workflow.current.kind}:${workflow.current.taskId}`}
    </output>
  ) : null;
}

function DetailProbe() {
  const detail = useTaskDetail();
  return detail.openTaskId !== null ? (
    <output data-testid="detail">
      {`${detail.openTaskId}:${detail.focusField ?? ""}`}
    </output>
  ) : null;
}

function renderAt(path: string) {
  return renderWithProviders(
    <>
      <Routes>
        <Route path="/more/cleanup-round" element={<CleanupRoundPage />} />
        <Route path="/more/cleanup-round/:id" element={<CleanupRoundPage />} />
        <Route path="/more" element={<p>Mehr-Seite</p>} />
      </Routes>
      <WorkflowProbe />
      <DetailProbe />
    </>,
    { initialEntries: [path] },
  );
}

describe("CleanupRoundPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts a round and shows the pending state", async () => {
    mocked.createCleanupRound.mockResolvedValue({ id: "r1" });
    mocked.getCleanupRound.mockResolvedValue(round({ status: "queued", items: [item({ status: "pending", result: null })] }));
    renderAt("/more/cleanup-round");

    expect(screen.getByText(/welche Denkentscheidung helfen würde/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Runde starten" }));

    expect(await screen.findByText("Machbar prüft ein paar Dinge …")).toBeInTheDocument();
    expect(mocked.getCleanupRound).toHaveBeenCalledWith("r1");
  });

  it("shows coaching cards with an editable answer", async () => {
    mocked.getCleanupRound.mockResolvedValue(round());
    renderAt("/more/cleanup-round/r1");

    const card = await screen.findByRole("article", { name: "Keller" });
    expect(within(card).getByText("Ersten Schnitt finden")).toBeInTheDocument();
    expect(within(card).getByText("Der Keller ist zu breit für eine Aufgabe.")).toBeInTheDocument();
    expect(within(card).getByText(/Welche Ecke stört am meisten\?/)).toBeInTheDocument();
    expect(within(card).getByText(/Aufgabe · Haus · Machbar/)).toBeInTheDocument();
    expect(within(card).getByLabelText("Deine Antwort")).toHaveValue("Werkzeugecke sortieren");
  });

  it("labels reference conversion as a check, not as an applied change", async () => {
    mocked.getCleanupRound.mockResolvedValue(round({
      items: [item({
        result: {
          ...item().result!,
          proposal: "convert_to_reference",
          resolutionSurface: "convert_to_reference",
          suggestedDefault: null,
        },
      })],
    }));
    renderAt("/more/cleanup-round/r1");

    const card = await screen.findByRole("article", { name: "Keller" });
    expect(within(card).queryByRole("button", { name: /Als Information ablegen/ })).not.toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "Öffnen und als Information prüfen" }));
    expect(screen.getByTestId("detail")).toHaveTextContent("7:notes");
    expect(mocked.resolveCleanupRoundItem).not.toHaveBeenCalled();
  });

  it("explains the difference between review acknowledgement and hiding a card", async () => {
    mocked.getCleanupRound.mockResolvedValue(round());
    mocked.resolveCleanupRoundItem.mockResolvedValue(round({ status: "completed", items: [item({ status: "dismissed" })] }));
    renderAt("/more/cleanup-round/r1");

    expect(await screen.findByText(/ändert den Eintrag nicht/)).toBeInTheDocument();
    const card = screen.getByRole("article", { name: "Keller" });
    await userEvent.click(within(card).getByRole("button", { name: "Einschätzung ausblenden" }));
    expect(mocked.resolveCleanupRoundItem).toHaveBeenCalledWith("r1", "item-1", "dismiss");
  });

  it("shows failed items of a partial round as cards and retries only the missing ones", async () => {
    mocked.getCleanupRound.mockResolvedValue(round({
      status: "partial",
      items: [
        item(),
        item({ id: "item-2", targetId: 8, title: "Backup", status: "failed", result: null }),
      ],
    }));
    mocked.retryCleanupRound.mockResolvedValue(round({ status: "queued" }));
    renderAt("/more/cleanup-round/r1");

    const failed = await screen.findByRole("article", { name: "Backup" });
    expect(within(failed).getByText("Machbar konnte für diesen Eintrag keine sichere Einschätzung erstellen.")).toBeInTheDocument();
    expect(within(failed).getByRole("button", { name: "Öffnen" })).toBeInTheDocument();
    expect(within(failed).getByRole("button", { name: "Einschätzung ausblenden" })).toBeInTheDocument();
    expect(within(failed).queryByRole("button", { name: "Hinten anstellen" })).not.toBeInTheDocument();
    expect(screen.queryByText("Alles durchgesehen.")).not.toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Keller" })).toBeInTheDocument();

    // A single failed card owns the only retry control.
    expect(screen.queryByRole("button", { name: "Fehlende erneut versuchen" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /erneut versuchen/i })).toHaveLength(1);
    await userEvent.click(within(failed).getByRole("button", { name: "Erneut versuchen" }));
    expect(mocked.retryCleanupRound).toHaveBeenCalledWith("r1");
  });

  it("moves retry to the banner when several items failed", async () => {
    mocked.getCleanupRound.mockResolvedValue(round({
      status: "partial",
      items: [
        item(),
        item({ id: "item-2", targetId: 8, title: "Backup", status: "failed", result: null }),
        item({ id: "item-3", targetId: 9, title: "Drucker", status: "failed", result: null }),
      ],
    }));
    mocked.retryCleanupRound.mockResolvedValue(round({ status: "queued" }));
    renderAt("/more/cleanup-round/r1");

    const failed = await screen.findByRole("article", { name: "Backup" });
    expect(within(failed).queryByRole("button", { name: "Erneut versuchen" })).not.toBeInTheDocument();
    expect(within(failed).getByRole("button", { name: "Öffnen" })).toBeInTheDocument();
    expect(within(failed).getByRole("button", { name: "Einschätzung ausblenden" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Fehlende erneut versuchen" }));
    expect(mocked.retryCleanupRound).toHaveBeenCalledWith("r1");
  });

  const flows = [
    {
      name: "renames a task",
      value: "Werkzeugkiste im Keller sortieren – geprüft",
      targetType: "task",
      surface: "rename_item",
      suggestedTitle: "Werkzeugkiste im Keller sortieren",
      suggestedDefault: null,
      button: "Umbenennen …",
      heading: "Aufgabe umbenennen?",
      shown: ["Alt", "Keller"],
      field: "Neu",
      confirm: "Umbenennen",
      expectMutation: () =>
        expect(mocked.applyCleanupRoundAction).toHaveBeenCalledWith("r1", "item-1", {
          action: "rename",
          title: "Werkzeugkiste im Keller sortieren – geprüft",
          expectedRevision: 3,
        }),
    },
    {
      name: "renames a project",
      value: "Neue Haustür auswählen – geprüft",
      targetType: "project",
      surface: "rename_item",
      suggestedTitle: "Neue Haustür auswählen",
      suggestedDefault: null,
      button: "Umbenennen …",
      heading: "Projekt umbenennen?",
      shown: ["Alt", "Keller"],
      field: "Neu",
      confirm: "Umbenennen",
      expectMutation: () =>
        expect(mocked.applyCleanupRoundAction).toHaveBeenCalledWith("r1", "item-1", {
          action: "rename",
          title: "Neue Haustür auswählen – geprüft",
          expectedRevision: 4,
        }),
    },
    {
      name: "creates a decision subtask",
      value: "Entscheiden: Welche Ecke zuerst? – geprüft",
      targetType: "task",
      surface: "create_decision_task",
      suggestedTitle: null,
      suggestedDefault: "Welche Ecke zuerst?",
      button: "Entscheidungsaufgabe anlegen …",
      heading: "Entscheidungsaufgabe anlegen?",
      shown: ["Unter", "Keller"],
      field: "Neue Teilaufgabe",
      confirm: "Teilaufgabe anlegen",
      expectMutation: () =>
        expect(mocked.applyCleanupRoundAction).toHaveBeenCalledWith("r1", "item-1", {
          action: "create-task",
          title: "Entscheiden: Welche Ecke zuerst? – geprüft",
          purpose: "decision",
        }),
    },
    {
      name: "creates a first-step subtask",
      value: "Werkzeugecke sortieren – geprüft",
      targetType: "task",
      surface: "create_first_slice",
      suggestedTitle: null,
      suggestedDefault: "Werkzeugecke sortieren",
      button: "Ersten Schritt anlegen …",
      heading: "Ersten Schritt anlegen?",
      shown: ["Unter", "Keller"],
      field: "Neue Teilaufgabe",
      confirm: "Teilaufgabe anlegen",
      expectMutation: () =>
        expect(mocked.applyCleanupRoundAction).toHaveBeenCalledWith("r1", "item-1", {
          action: "create-task",
          title: "Werkzeugecke sortieren – geprüft",
          purpose: "firstSlice",
        }),
    },
    {
      name: "creates a first project task",
      value: "Angebote vergleichen – geprüft",
      targetType: "project",
      surface: "create_first_slice",
      suggestedTitle: null,
      suggestedDefault: "Angebote vergleichen",
      button: "Ersten Schritt anlegen …",
      heading: "Ersten Schritt anlegen?",
      shown: ["Projekt", "Keller"],
      field: "Neue Aufgabe",
      confirm: "Aufgabe anlegen",
      expectMutation: () =>
        expect(mocked.applyCleanupRoundAction).toHaveBeenCalledWith("r1", "item-1", {
          action: "create-task",
          title: "Angebote vergleichen – geprüft",
          purpose: "firstSlice",
        }),
    },
    {
      name: "creates a project follow-up",
      value: "Nachhalten: Versicherung wegen Rohrbruch – geprüft",
      targetType: "project",
      surface: "create_followup",
      suggestedTitle: null,
      suggestedDefault: "Versicherung wegen Rohrbruch",
      button: "Follow-up anlegen …",
      heading: "Follow-up anlegen?",
      shown: ["Projekt", "Keller"],
      field: "Neue Aufgabe",
      confirm: "Aufgabe anlegen",
      expectMutation: () =>
        expect(mocked.applyCleanupRoundAction).toHaveBeenCalledWith("r1", "item-1", {
          action: "create-task",
          title: "Nachhalten: Versicherung wegen Rohrbruch – geprüft",
          purpose: "followup",
        }),
    },
    {
      name: "adds a project done-when criterion",
      value: "Tür ist montiert und dicht – geprüft",
      targetType: "project",
      surface: "edit_done_when",
      suggestedTitle: null,
      suggestedDefault: "Tür ist montiert und dicht",
      button: "Kriterium hinzufügen …",
      heading: "Erledigt-wenn ergänzen?",
      shown: ["Projekt", "Keller"],
      field: "Neues Kriterium",
      confirm: "Kriterium hinzufügen",
      expectMutation: () =>
        expect(mocked.applyCleanupRoundAction).toHaveBeenCalledWith("r1", "item-1", {
          action: "add-done-when",
          text: "Tür ist montiert und dicht – geprüft",
        }),
    },
    {
      name: "appends a labeled done-when block to task notes",
      value: "Erledigt, wenn: Letztes Backup erfolgreich – geprüft",
      targetType: "task",
      surface: "edit_done_when",
      suggestedTitle: null,
      suggestedDefault: "Letztes Backup erfolgreich",
      button: "In Notizen ergänzen …",
      heading: "Erledigt-wenn in Notizen ergänzen?",
      shown: ["Aufgabe", "Keller"],
      field: "Eintrag",
      confirm: "In Notizen ergänzen",
      expectMutation: () =>
        expect(mocked.applyCleanupRoundAction).toHaveBeenCalledWith("r1", "item-1", {
          action: "add-done-when",
          text: "Erledigt, wenn: Letztes Backup erfolgreich – geprüft",
        }),
    },
  ] as const;

  it.each(flows)("$name after an explicit confirmation", async (flow) => {
    mocked.getTask.mockResolvedValue(makeTask({ id: 7, title: "Keller", revision: 3 }));
    mocked.getProject.mockResolvedValue({ ...makeProject({ id: 7, title: "Keller", revision: 4 }), tasks: [] });
    mocked.applyCleanupRoundAction.mockResolvedValue(round({ status: "completed", items: [item({ status: "dismissed" })] }));
    mocked.getCleanupRound.mockResolvedValue(round({
      items: [item({
        targetType: flow.targetType,
        itemStatus: flow.targetType === "project" ? "active" : "actionable",
        result: {
          ...item().result!,
          targetType: flow.targetType,
          resolutionSurface: flow.surface,
          suggestedDefault: flow.suggestedDefault,
          suggestedTitle: flow.suggestedTitle,
        },
      })],
    }));
    renderAt("/more/cleanup-round/r1");

    const card = await screen.findByRole("article", { name: "Keller" });
    await userEvent.type(within(card).getByLabelText("Deine Antwort"), " – geprüft");
    await userEvent.click(within(card).getByRole("button", { name: flow.button }));

    // The sheet shows the target and exactly what will be written.
    const sheet = await screen.findByRole("dialog", { name: flow.heading });
    await waitFor(() => expect(within(sheet).getByText(flow.shown[1])).toBeInTheDocument());
    expect(within(sheet).getByText(flow.shown[0])).toBeInTheDocument();
    expect(within(sheet).getByLabelText(flow.field)).toHaveValue(flow.value);
    expect(within(sheet).getByText(/Eintrag geändert und diese Einschätzung ausgeblendet/)).toBeInTheDocument();
    expect(mocked.resolveCleanupRoundItem).not.toHaveBeenCalled();

    await userEvent.click(within(sheet).getByRole("button", { name: flow.confirm }));

    await waitFor(() => flow.expectMutation());
    // One request changes the item and hides the card; the page renders the
    // returned round. No second dismiss request, no generic mutation, no review.
    expect(mocked.applyCleanupRoundAction).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Alles durchgesehen.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Keller" })).not.toBeInTheDocument();
    for (const separate of [
      mocked.resolveCleanupRoundItem,
      mocked.updateTask,
      mocked.updateProject,
      mocked.createTask,
      mocked.createChildTask,
      mocked.addCriterion,
      mocked.appendTaskNotes,
      mocked.appendProjectNotes,
      mocked.acknowledgeTaskReview,
      mocked.acknowledgeProjectReview,
    ]) {
      expect(separate).not.toHaveBeenCalled();
    }
  });

  it("makes an admin step concrete: new wording plus optional note, both previewed", async () => {
    mocked.getTask.mockResolvedValue(makeTask({ id: 7, title: "Kur-Nachweis", revision: 2 }));
    mocked.applyCleanupRoundAction.mockResolvedValue(round({ status: "completed", items: [item({ status: "dismissed" })] }));
    mocked.getCleanupRound.mockResolvedValue(round({
      items: [item({
        title: "Kur-Nachweis",
        result: {
          ...item().result!,
          proposal: "clarify_recipient_or_document",
          resolutionSurface: "clarify_admin_target",
          suggestedTitle: "Kur-Nachweis an Minijob-Zentrale einreichen",
          suggestedDefault: "Empfänger: Minijob-Zentrale",
        },
      })],
    }));
    renderAt("/more/cleanup-round/r1");

    const card = await screen.findByRole("article", { name: "Kur-Nachweis" });
    expect(within(card).getByLabelText("Deine Antwort")).toHaveValue("Empfänger: Minijob-Zentrale");
    await userEvent.click(within(card).getByRole("button", { name: "Verwaltungsschritt konkretisieren …" }));

    const sheet = await screen.findByRole("dialog", { name: "Verwaltungsschritt konkretisieren?" });
    await waitFor(() => expect(within(sheet).getByText("Kur-Nachweis")).toBeInTheDocument());
    expect(within(sheet).getByLabelText("Neue Formulierung")).toHaveValue("Kur-Nachweis an Minijob-Zentrale einreichen");
    expect(within(sheet).getByLabelText("Notiz ergänzen (optional)")).toHaveValue("Empfänger: Minijob-Zentrale");
    await userEvent.click(within(sheet).getByRole("button", { name: "Aktualisieren" }));

    await waitFor(() =>
      expect(mocked.applyCleanupRoundAction).toHaveBeenCalledWith("r1", "item-1", {
        action: "clarify-admin",
        title: "Kur-Nachweis an Minijob-Zentrale einreichen",
        notes: "Empfänger: Minijob-Zentrale",
        expectedRevision: 2,
      }),
    );
    expect(await screen.findByText("Alles durchgesehen.")).toBeInTheDocument();
    expect(mocked.updateTask).not.toHaveBeenCalled();
    expect(mocked.appendTaskNotes).not.toHaveBeenCalled();
    expect(mocked.resolveCleanupRoundItem).not.toHaveBeenCalled();
  });

  it("changes nothing when the confirmation is cancelled", async () => {
    mocked.getTask.mockResolvedValue(makeTask({ id: 7, title: "Keller", revision: 3 }));
    mocked.getCleanupRound.mockResolvedValue(round());
    renderAt("/more/cleanup-round/r1");

    const card = await screen.findByRole("article", { name: "Keller" });
    await userEvent.click(within(card).getByRole("button", { name: "Ersten Schritt anlegen …" }));
    const sheet = await screen.findByRole("dialog", { name: "Ersten Schritt anlegen?" });
    await waitFor(() => expect(within(sheet).getByLabelText("Neue Teilaufgabe")).toHaveValue("Werkzeugecke sortieren"));
    await userEvent.click(within(sheet).getByRole("button", { name: "Abbrechen" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mocked.applyCleanupRoundAction).not.toHaveBeenCalled();
    expect(mocked.resolveCleanupRoundItem).not.toHaveBeenCalled();
    expect(screen.getByRole("article", { name: "Keller" })).toBeInTheDocument();
  });

  it("keeps the sheet and the card when the action endpoint fails", async () => {
    mocked.getTask.mockResolvedValue(makeTask({ id: 7, title: "Keller", revision: 3 }));
    mocked.applyCleanupRoundAction.mockRejectedValue(new Error("kaputt"));
    mocked.getCleanupRound.mockResolvedValue(round());
    renderAt("/more/cleanup-round/r1");

    const card = await screen.findByRole("article", { name: "Keller" });
    await userEvent.click(within(card).getByRole("button", { name: "Ersten Schritt anlegen …" }));
    const sheet = await screen.findByRole("dialog", { name: "Ersten Schritt anlegen?" });
    await userEvent.click(await within(sheet).findByRole("button", { name: "Teilaufgabe anlegen" }));

    expect(await within(sheet).findByRole("alert")).toBeInTheDocument();
    expect(mocked.applyCleanupRoundAction).toHaveBeenCalledTimes(1);
    expect(mocked.resolveCleanupRoundItem).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Ersten Schritt anlegen?" })).toBeInTheDocument();
    expect(within(sheet).getByLabelText("Neue Teilaufgabe")).toHaveValue("Werkzeugecke sortieren");
    expect(within(sheet).getByRole("button", { name: "Teilaufgabe anlegen" })).toBeEnabled();
    expect(screen.getByRole("article", { name: "Keller" })).toBeInTheDocument();
  });

  it("keeps the draft and refreshes the preview after a stale write conflict", async () => {
    mocked.getTask
      .mockResolvedValueOnce(makeTask({ id: 7, title: "Keller", revision: 3 }))
      .mockResolvedValue(makeTask({ id: 7, title: "Keller (Haus)", revision: 4 }));
    mocked.applyCleanupRoundAction.mockRejectedValueOnce(
      Object.assign(new Error("stale"), { name: "ApiError", status: 409, code: "stale_write_conflict" }),
    );
    mocked.getCleanupRound.mockResolvedValue(round({
      items: [item({
        result: { ...item().result!, proposal: "rename_for_actionability", resolutionSurface: "rename_item", suggestedTitle: "Werkzeugecke sortieren" },
      })],
    }));
    renderAt("/more/cleanup-round/r1");

    const card = await screen.findByRole("article", { name: "Keller" });
    await userEvent.click(within(card).getByRole("button", { name: "Umbenennen …" }));
    const sheet = await screen.findByRole("dialog", { name: "Aufgabe umbenennen?" });
    const field = await within(sheet).findByLabelText("Neu");
    await userEvent.clear(field);
    await userEvent.type(field, "Werkzeugecke im Keller sortieren");
    await userEvent.click(within(sheet).getByRole("button", { name: "Umbenennen" }));

    expect(await within(sheet).findByRole("alert")).toBeInTheDocument();
    // The preview reloads the current title; the draft survives.
    expect(await within(sheet).findByText("Keller (Haus)")).toBeInTheDocument();
    expect(within(sheet).getByLabelText("Neu")).toHaveValue("Werkzeugecke im Keller sortieren");
    expect(screen.getByRole("article", { name: "Keller" })).toBeInTheDocument();
    expect(mocked.resolveCleanupRoundItem).not.toHaveBeenCalled();

    mocked.applyCleanupRoundAction.mockResolvedValueOnce(round({ status: "completed", items: [item({ status: "dismissed" })] }));
    await userEvent.click(within(sheet).getByRole("button", { name: "Umbenennen" }));
    await waitFor(() =>
      expect(mocked.applyCleanupRoundAction).toHaveBeenLastCalledWith("r1", "item-1", {
        action: "rename",
        title: "Werkzeugecke im Keller sortieren",
        expectedRevision: 4,
      }),
    );
    expect(await screen.findByText("Alles durchgesehen.")).toBeInTheDocument();
  });

  it("disables confirmation until the change is meaningful", async () => {
    mocked.getTask.mockImplementation(async (id: number) =>
      makeTask({ id, title: id === 8 ? "Kur-Nachweis" : "Keller", revision: 3 }));
    mocked.getCleanupRound.mockResolvedValue(round({
      items: [
        item({ result: { ...item().result!, resolutionSurface: "rename_item", suggestedTitle: "Werkzeugecke sortieren" } }),
        item({
          id: "item-2",
          targetId: 8,
          title: "Kur-Nachweis",
          result: { ...item().result!, targetId: 8, resolutionSurface: "clarify_admin_target", suggestedTitle: null, suggestedDefault: null },
        }),
      ],
    }));
    renderAt("/more/cleanup-round/r1");

    const rename = await screen.findByRole("article", { name: "Keller" });
    await userEvent.click(within(rename).getByRole("button", { name: "Umbenennen …" }));
    let sheet = await screen.findByRole("dialog", { name: "Aufgabe umbenennen?" });
    const title = await within(sheet).findByLabelText("Neu");
    await userEvent.clear(title);
    await userEvent.type(title, "Keller");
    expect(within(sheet).getByRole("button", { name: "Umbenennen" })).toBeDisabled();
    await userEvent.clear(title);
    expect(within(sheet).getByRole("button", { name: "Umbenennen" })).toBeDisabled();
    await userEvent.click(within(sheet).getByRole("button", { name: "Abbrechen" }));

    const admin = screen.getByRole("article", { name: "Kur-Nachweis" });
    await userEvent.click(within(admin).getByRole("button", { name: "Verwaltungsschritt konkretisieren …" }));
    sheet = await screen.findByRole("dialog", { name: "Verwaltungsschritt konkretisieren?" });
    await within(sheet).findByLabelText("Neue Formulierung");
    expect(within(sheet).getByRole("button", { name: "Aktualisieren" })).toBeDisabled();
    await userEvent.type(within(sheet).getByLabelText("Notiz ergänzen (optional)"), "Empfänger: Minijob-Zentrale");
    expect(within(sheet).getByRole("button", { name: "Aktualisieren" })).toBeEnabled();
    expect(mocked.applyCleanupRoundAction).not.toHaveBeenCalled();
  });

  it("names the only real shape change and keeps other shapes as checks", async () => {
    mocked.getCleanupRound.mockResolvedValue(round({
      items: [
        item({ result: { ...item().result!, proposal: "wrong_shape", resolutionSurface: "choose_shape", suggestedShape: "project" } }),
        item({
          id: "item-2",
          targetId: 8,
          title: "Öffnungszeiten",
          result: { ...item().result!, targetId: 8, proposal: "wrong_shape", resolutionSurface: "choose_shape", suggestedShape: "reference" },
        }),
      ],
    }));
    renderAt("/more/cleanup-round/r1");

    const project = await screen.findByRole("article", { name: "Keller" });
    await userEvent.click(within(project).getByRole("button", { name: "Zum Projekt machen …" }));
    expect(screen.getByTestId("workflow")).toHaveTextContent("convertToProject:7");

    const reference = screen.getByRole("article", { name: "Öffnungszeiten" });
    expect(within(reference).queryByRole("button", { name: /Projekt|Form ändern/ })).not.toBeInTheDocument();
    expect(within(reference).getByRole("button", { name: "Öffnen und als Information prüfen" })).toBeInTheDocument();
  });

  it("marks an item reviewed only through the explicit action", async () => {
    mocked.getCleanupRound.mockResolvedValue(round());
    mocked.resolveCleanupRoundItem.mockResolvedValue(
      round({ status: "completed", items: [item({ status: "reviewed" })] }),
    );
    renderAt("/more/cleanup-round/r1");

    const card = await screen.findByRole("article", { name: "Keller" });
    await userEvent.click(within(card).getByRole("button", { name: "Hinten anstellen" }));

    expect(mocked.resolveCleanupRoundItem).toHaveBeenCalledWith("r1", "item-1", "mark-reviewed");
    expect(await screen.findByText("Alles durchgesehen.")).toBeInTheDocument();
  });

  it("offers retry and close when the round failed", async () => {
    mocked.getCleanupRound.mockResolvedValue(round({ status: "failed", items: [item({ status: "failed", result: null })] }));
    mocked.retryCleanupRound.mockResolvedValue(round({ status: "queued" }));
    mocked.dismissCleanupRound.mockResolvedValue(round({ status: "dismissed" }));
    renderAt("/more/cleanup-round/r1");

    expect(await screen.findByText("Machbar konnte keine sichere Klärungsrunde erstellen.")).toBeInTheDocument();
    const card = screen.getByRole("article", { name: "Keller" });
    await userEvent.click(within(card).getByRole("button", { name: "Erneut versuchen" }));
    expect(mocked.retryCleanupRound).toHaveBeenCalledWith("r1");
    expect(await screen.findByText("Machbar prüft ein paar Dinge …")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Schließen" }));
    expect(mocked.dismissCleanupRound).toHaveBeenCalledWith("r1");
    expect(await screen.findByText("Mehr-Seite")).toBeInTheDocument();
  });
});
