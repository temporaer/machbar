import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useLocation } from "react-router-dom";
import type { CleanupRoundItemRecord, CleanupRoundRecord } from "@machbar/shared";
import { renderWithProviders } from "../test/testUtils";
import { api } from "../lib/api";
import { useTaskWorkflow } from "../lib/taskWorkflowContext";
import { useTaskDetail } from "../lib/taskDetailContext";
import { useProjectWorkflow } from "../lib/projectWorkflowContext";
import { makeProject } from "../test/fixtures";
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
    getProject: vi.fn(),
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
      {`${workflow.current.kind}:${workflow.current.taskId}:${(workflow.current.initialTitles ?? []).join("|")}`}
    </output>
  ) : null;
}

function DetailProbe() {
  const detail = useTaskDetail();
  return detail.openTaskId !== null ? (
    <output data-testid="detail">
      {`${detail.openTaskId}:${detail.focusField ?? ""}:${detail.focusDraft ?? ""}`}
    </output>
  ) : null;
}

function ProjectProbe() {
  const workflow = useProjectWorkflow();
  const location = useLocation();
  return (
    <>
      <output data-testid="location">{`${location.pathname}${location.search}`}</output>
      {workflow.current ? (
        <output data-testid="project-workflow">
          {`${workflow.current.kind}:${workflow.current.projectId}:${workflow.current.draft ?? ""}`}
        </output>
      ) : null}
    </>
  );
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
      <ProjectProbe />
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

  it("shows coaching cards and routes surfaces into existing workflows", async () => {
    mocked.getCleanupRound.mockResolvedValue(round());
    renderAt("/more/cleanup-round/r1");

    const card = await screen.findByRole("article", { name: "Keller" });
    expect(within(card).getByText("Ersten Schnitt finden")).toBeInTheDocument();
    expect(within(card).getByText("Der Keller ist zu breit für eine Aufgabe.")).toBeInTheDocument();
    expect(within(card).getByText(/Welche Ecke stört am meisten\?/)).toBeInTheDocument();
    expect(within(card).getByText(/Aufgabe · Haus · Machbar/)).toBeInTheDocument();

    // The suggestion is an editable answer that is carried into the workflow.
    const answer = within(card).getByLabelText("Deine Antwort");
    expect(answer).toHaveValue("Werkzeugecke sortieren");
    await userEvent.clear(answer);
    await userEvent.type(answer, "Schraubenregal sortieren");
    await userEvent.click(within(card).getByRole("button", { name: "Ersten Schritt anlegen …" }));
    expect(screen.getByTestId("workflow")).toHaveTextContent("split:7:Schraubenregal sortieren");
    expect(mocked.resolveCleanupRoundItem).not.toHaveBeenCalled();
  });

  it("opens the title editor seeded with the suggested title", async () => {
    mocked.getCleanupRound.mockResolvedValue(round({
      items: [item({
        result: {
          ...item().result!,
          proposal: "rename_for_actionability",
          resolutionSurface: "rename_item",
          suggestedDefault: null,
          suggestedTitle: "Werkzeugkiste im Keller sortieren",
        },
      })],
    }));
    renderAt("/more/cleanup-round/r1");

    const card = await screen.findByRole("article", { name: "Keller" });
    expect(within(card).getByLabelText("Deine Antwort")).toHaveValue("Werkzeugkiste im Keller sortieren");
    await userEvent.click(within(card).getByRole("button", { name: "Umbenennen …" }));
    expect(screen.getByTestId("detail")).toHaveTextContent("7:title:Werkzeugkiste im Keller sortieren");
    expect(mocked.resolveCleanupRoundItem).not.toHaveBeenCalled();
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
    expect(screen.getByTestId("detail")).toHaveTextContent("7:notes:");
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

  it.each([
    ["task notes as done-when", "task", "edit_done_when", "Erledigt-wenn in Notizen übernehmen …", "Erledigt, wenn: Tür ist dicht", "detail", "7:notes:Erledigt, wenn: Tür ist dicht – geprüft"],
    ["task notes for an admin target", "task", "clarify_admin_target", "Antwort in Notizen übernehmen …", "An die Krankenkasse", "detail", "7:notes:An die Krankenkasse – geprüft"],
    ["project criterion", "project", "edit_done_when", "Als Erledigt-wenn-Kriterium übernehmen …", "Tür ist dicht", "project-workflow", "editOutcome:7:Tür ist dicht – geprüft"],
    ["project next action as first step", "project", "create_first_slice", "Ersten Schritt anlegen …", "Angebote vergleichen", "location", "/projects/7?focus=next-action&draft=Angebote+vergleichen+%E2%80%93+gepr%C3%BCft"],
    ["project next action as follow-up", "project", "create_followup", "Follow-up anlegen …", "Nachhalten: Rechnung", "location", "/projects/7?focus=next-action&draft=Nachhalten%3A+Rechnung+%E2%80%93+gepr%C3%BCft"],
    ["project title", "project", "rename_item", "Umbenennen …", "Neue Haustür montieren", "location", "/projects/7?focus=title&draft=Neue+Haust%C3%BCr+montieren+%E2%80%93+gepr%C3%BCft"],
  ] as const)("carries the edited answer into the %s", async (_name, targetType, surface, label, start, probe, expected) => {
    mocked.getProject.mockResolvedValue({ ...makeProject({ id: 7, title: "Keller" }), tasks: [] });
    mocked.getCleanupRound.mockResolvedValue(round({
      items: [item({
        targetType,
        itemStatus: targetType === "project" ? "active" : "actionable",
        result: {
          ...item().result!,
          targetType,
          resolutionSurface: surface,
          suggestedDefault: start.replace(/^(Erledigt, wenn|Nachhalten): /, ""),
          suggestedTitle: surface === "rename_item" ? start : null,
        },
      })],
    }));
    renderAt("/more/cleanup-round/r1");

    const card = await screen.findByRole("article", { name: "Keller" });
    const answer = within(card).getByLabelText("Deine Antwort");
    expect(answer).toHaveValue(start);
    await userEvent.type(answer, " – geprüft");
    await userEvent.click(within(card).getByRole("button", { name: label }));

    await waitFor(() => expect(screen.getByTestId(probe)).toHaveTextContent(expected));
    // Nothing is saved from the card; the destination's own Save commits.
    expect(mocked.resolveCleanupRoundItem).not.toHaveBeenCalled();
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
    expect(screen.getByTestId("workflow")).toHaveTextContent("convertToProject:7:");

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
