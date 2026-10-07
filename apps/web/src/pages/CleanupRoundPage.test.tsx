import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import type { CleanupRoundItemRecord, CleanupRoundRecord } from "@machbar/shared";
import { renderWithProviders } from "../test/testUtils";
import { api } from "../lib/api";
import { useTaskWorkflow } from "../lib/taskWorkflowContext";
import { useTaskDetail } from "../lib/taskDetailContext";
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
    await userEvent.click(within(card).getByRole("button", { name: "Ersten Schnitt anlegen …" }));
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

    await userEvent.click(within(failed).getByRole("button", { name: "Erneut versuchen" }));
    expect(mocked.retryCleanupRound).toHaveBeenCalledWith("r1");
  });

  it("offers retrying only the missing items from the partial banner", async () => {
    mocked.getCleanupRound.mockResolvedValue(round({
      status: "partial",
      items: [item(), item({ id: "item-2", targetId: 8, title: "Backup", status: "failed", result: null })],
    }));
    mocked.retryCleanupRound.mockResolvedValue(round({ status: "queued" }));
    renderAt("/more/cleanup-round/r1");

    await userEvent.click(await screen.findByRole("button", { name: "Fehlende erneut versuchen" }));
    expect(mocked.retryCleanupRound).toHaveBeenCalledWith("r1");
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
    expect(screen.getByRole("article", { name: "Keller" })).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: "Erneut versuchen" })[0]!);
    expect(mocked.retryCleanupRound).toHaveBeenCalledWith("r1");
    expect(await screen.findByText("Machbar prüft ein paar Dinge …")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Schließen" }));
    expect(mocked.dismissCleanupRound).toHaveBeenCalledWith("r1");
    expect(await screen.findByText("Mehr-Seite")).toBeInTheDocument();
  });
});
