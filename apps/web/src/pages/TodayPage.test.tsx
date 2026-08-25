import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "../test/testUtils";
import { TodayPage } from "./TodayPage";
import { api } from "../lib/api";
import { makeMember, makeTask } from "../test/fixtures";
import type { Agenda } from "@machbar/shared";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    getAgenda: vi.fn(),
    completeTask: vi.fn(),
    cancelTask: vi.fn(),
    reopenTask: vi.fn(),
    updateTask: vi.fn(),
    reorderTask: vi.fn(),
    indentTask: vi.fn(),
    outdentTask: vi.fn(),
    moveTask: vi.fn(),
    createTask: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

function makeEmptyAgenda(): Agenda {
  return { planned: [], overdue: [], dueToday: [], dueSoon: [], shared: [], revisit: [] };
}

describe("TodayPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1 })]);
  });

  it("zeigt keinen manuellen Heute-Umschalter mehr an und erklärt die Ansicht als automatisch berechnet", async () => {
    mockedApi.getAgenda.mockResolvedValue({
      ...makeEmptyAgenda(),
      dueToday: [makeTask({ id: 1, title: "Steuererklärung abgeben" })],
    });
    renderWithProviders(<TodayPage />);

    await screen.findByText("Steuererklärung abgeben");
    expect(screen.queryByText("Heute erledigen")).not.toBeInTheDocument();
    expect(screen.queryByText("Für heute markieren")).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Diese Übersicht wird automatisch aus Terminen, Fälligkeiten und dem Status berechnet – ohne manuelle Markierung.",
      ),
    ).toBeInTheDocument();
  });

  it("zeigt blockierte, wieder fällige Aufgaben als Wiedervorlage mit Erklärung und blockiert-Hinweis", async () => {
    const revisitTask = makeTask({
      id: 2,
      title: "Leiter zurückbringen",
      blocked: true,
      scheduledDate: "2026-01-01",
    });
    mockedApi.getAgenda.mockResolvedValue({
      ...makeEmptyAgenda(),
      revisit: [revisitTask],
    });
    renderWithProviders(<TodayPage />);

    expect(await screen.findByText("Wiedervorlage")).toBeInTheDocument();
    expect(screen.getByText("Blockiert, aber zur Wiedervorlage für heute geplant.")).toBeInTheDocument();
    expect(screen.getByText("Leiter zurückbringen")).toBeInTheDocument();
    // The normal blocked lock indicator from TaskRow must still show up.
    expect(screen.getByLabelText("Blockiert durch")).toBeInTheDocument();
  });

  it("blendet den Wiedervorlage-Abschnitt aus, wenn nichts wieder anzusehen ist", async () => {
    mockedApi.getAgenda.mockResolvedValue({
      ...makeEmptyAgenda(),
      dueToday: [makeTask({ id: 3, title: "Etwas anderes" })],
    });
    renderWithProviders(<TodayPage />);

    await screen.findByText("Etwas anderes");
    expect(screen.queryByText("Wiedervorlage")).not.toBeInTheDocument();
  });
});
