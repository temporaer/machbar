import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/testUtils";
import { TodayPage } from "./TodayPage";
import { IdentitySelector } from "../components/IdentitySelector";
import { api } from "../lib/api";
import { makeMember, makeProject, makeTag, makeTask } from "../test/fixtures";
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
  return {
    projects: [],
    planned: [],
    overdue: [],
    dueToday: [],
    dueSoon: [],
    shared: [],
    unscheduled: [],
    followUp: [],
    revisit: [],
  };
}

describe("TodayPage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1 })]);
  });

  it("zeigt keinen manuellen Heute-Umschalter mehr an und erklärt die Ansicht im Seitenhinweis", async () => {
    mockedApi.getAgenda.mockResolvedValue({
      ...makeEmptyAgenda(),
      dueToday: [
        makeTask({
          id: 1,
          title: "Steuererklärung abgeben",
          effectiveTags: [makeTag({ id: 11, name: "Finanzen", kind: "area" })],
        }),
      ],
    });
    const { container } = renderWithProviders(<TodayPage />);

    await screen.findByText("Steuererklärung abgeben");
    expect(container.querySelector(".today-page")).toBeInTheDocument();
    expect(screen.queryByText("Heute erledigen")).not.toBeInTheDocument();
    expect(screen.queryByText("Für heute markieren")).not.toBeInTheDocument();
    const explanation =
      "Diese Übersicht wird automatisch aus Terminen, Fälligkeiten und dem Status berechnet – ohne manuelle Markierung.";
    expect(screen.queryByText(explanation)).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Hinweise zu dieser Seite anzeigen" }),
    );
    expect(screen.getByText(explanation)).toBeInTheDocument();
    expect(container.querySelector(".task-row-surface-actionable")).toBeInTheDocument();
    expect(container.querySelector(".task-row-header")).toContainElement(
      screen.getByText("Finanzen"),
    );
    expect(screen.queryByText("Machbar")).not.toBeInTheDocument();
  });

  it("bündelt alle sichtbaren Abschnittshinweise im einzigen Seitenhinweis", async () => {
    const revisitTask = makeTask({
      id: 2,
      title: "Leiter zurückbringen",
      blocked: true,
      scheduledDate: "2026-01-01",
    });
    mockedApi.getAgenda.mockResolvedValue({
      ...makeEmptyAgenda(),
      revisit: [revisitTask],
      followUp: [
        makeTask({
          id: 6,
          title: "Installateur anrufen",
          status: "waiting",
        }),
      ],
    });
    renderWithProviders(<TodayPage />);

    expect(await screen.findByText("Blockiert prüfen")).toBeInTheDocument();
    const revisitHint = "Blockiert, aber heute wieder zu prüfen.";
    const followUpHint =
      "Die Wiedervorlage ist erreicht. Jetzt nachhaken oder die Aufgabe wieder machbar machen.";
    expect(screen.queryByText(revisitHint)).not.toBeInTheDocument();
    expect(screen.queryByText(followUpHint)).not.toBeInTheDocument();
    const infoButtons = screen.getAllByRole("button", {
      name: "Hinweise zu dieser Seite anzeigen",
    });
    expect(infoButtons).toHaveLength(1);
    await userEvent.click(
      screen.getByRole("button", { name: "Hinweise zu dieser Seite anzeigen" }),
    );
    expect(screen.getByText(revisitHint)).toBeInTheDocument();
    expect(screen.getByText(followUpHint)).toBeInTheDocument();
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

  it("zeigt machbare Aufgaben ohne Termin sofort sichtbar in einem normalen Nebenabschnitt", async () => {
    mockedApi.getAgenda.mockResolvedValue({
      ...makeEmptyAgenda(),
      unscheduled: [makeTask({ id: 4, title: "Keller aufräumen", scheduledDate: null })],
    });
    renderWithProviders(<TodayPage />);

    const heading = await screen.findByText("Weitere machbare Aufgaben");
    // No longer a collapsed <details>/<summary> — it's a normal, always
    // visible section like every other one on this page.
    expect(heading.closest("details")).toBeNull();
    expect(screen.getByText("Keller aufräumen")).toBeVisible();
  });

  it("zeigt fällige Wiedervorlagen wartender Aufgaben unter Nachhaken", async () => {
    mockedApi.getAgenda.mockResolvedValue({
      ...makeEmptyAgenda(),
      followUp: [
        makeTask({
          id: 5,
          title: "Installateur anrufen",
          status: "waiting",
          scheduledDate: "2026-01-01",
        }),
      ],
    });
    renderWithProviders(<TodayPage />);

    expect(await screen.findByText("Nachhaken")).toBeInTheDocument();
    expect(screen.getByText("Installateur anrufen")).toBeInTheDocument();
  });

  it("zeigt Projekttermine in einem eigenen Abschnitt der Heute-Ansicht", async () => {
    mockedApi.getAgenda.mockResolvedValue({
      ...makeEmptyAgenda(),
      projects: [
        {
          project: makeProject({
            id: 77,
            title: "Umzug organisieren",
            dueDate: "2026-09-01",
          }),
          qualification: "due",
          nextAction: makeTask({ title: "Transporter reservieren" }),
          stuck: null,
        },
      ],
    });
    renderWithProviders(<TodayPage />);

    expect(await screen.findByRole("heading", { name: "Projekte" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Umzug organisieren" })).toHaveAttribute(
      "href",
      "/projekte/77",
    );
    expect(screen.getByText(/Transporter reservieren/)).toBeInTheDocument();
  });

  it("fragt die Agenda ausschließlich für die aktuell ausgewählte Identität ab", async () => {
    window.localStorage.setItem("machbar:identity-member-id", "1");
    mockedApi.getAgenda.mockResolvedValue(makeEmptyAgenda());
    renderWithProviders(<TodayPage />);

    // Once the member list has resolved and confirmed the stored id, the
    // agenda must be requested for exactly that member — never a
    // different/other member's id (only a transient `null` may precede it,
    // while identity is still resolving on first mount).
    await waitFor(() => expect(mockedApi.getAgenda).toHaveBeenCalledWith(1));
    for (const [memberId] of mockedApi.getAgenda.mock.calls) {
      expect(memberId === null || memberId === 1).toBe(true);
    }
  });

  it("bleibt sicher, wenn (noch) keine Identität ausgewählt ist", async () => {
    // No stored identity and an empty member list -> currentMemberId stays
    // null. The page must render without throwing and simply request the
    // agenda unscoped (shared/unassigned tasks still come back from the
    // backend), rather than guessing at another member's id.
    mockedApi.getMembers.mockResolvedValue([]);
    mockedApi.getAgenda.mockResolvedValue(makeEmptyAgenda());
    renderWithProviders(<TodayPage />);

    await waitFor(() => expect(mockedApi.getAgenda).toHaveBeenCalledWith(null));
  });

  it("lädt die Agenda automatisch neu, wenn die ausgewählte Identität wechselt", async () => {
    mockedApi.getMembers.mockResolvedValue([
      makeMember({ id: 1, name: "Mira" }),
      makeMember({ id: 2, name: "Jonas" }),
    ]);
    mockedApi.getAgenda.mockResolvedValue(makeEmptyAgenda());
    renderWithProviders(
      <>
        <IdentitySelector />
        <TodayPage />
      </>,
    );

    await waitFor(() => expect(mockedApi.getAgenda).toHaveBeenCalledWith(null));
    const initialCalls = mockedApi.getAgenda.mock.calls.length;

    const option = await screen.findByRole("option", { name: /Jonas/ });
    await userEvent.click(option);

    await waitFor(() => expect(mockedApi.getAgenda).toHaveBeenCalledWith(2));
    expect(mockedApi.getAgenda.mock.calls.length).toBeGreaterThan(initialCalls);
    // The last call must reflect only the newly selected member — the
    // previous member's id must never be requested again after switching.
    expect(mockedApi.getAgenda.mock.calls.at(-1)).toEqual([2]);
  });
});
