import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
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
    getContributionSummary: vi.fn(),
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
    window.sessionStorage.clear();
    vi.clearAllMocks();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1 })]);
    mockedApi.getContributionSummary.mockResolvedValue({
      windowStartedAt: "2026-08-21T10:00:00.000Z",
      windowEndedAt: "2026-08-28T10:00:00.000Z",
      sharedTotal: 0,
      sharedOnlyTotal: 0,
      sharedCategories: { completion: 0, planning: 0 },
      members: [],
      pulse: Array.from({ length: 7 }, (_, index) => ({
        startedAt: new Date(Date.UTC(2026, 7, 21 + index, 10)).toISOString(),
        endedAt: new Date(Date.UTC(2026, 7, 22 + index, 10)).toISOString(),
        level: "none" as const,
      })),
    });
  });

  it("shows a number-free seven-day shared contribution pulse below the header", async () => {
    mockedApi.getAgenda.mockResolvedValue(makeEmptyAgenda());
    const { container } = renderWithProviders(<TodayPage />);

    const pulse = await screen.findByRole("link", {
      name: /Gemeinsame Beiträge der letzten sieben Tage\. Zur ausführlichen Ansicht\./,
    });
    expect(pulse).toHaveAttribute("href", "/more");
    expect(pulse).toHaveTextContent("Gemeinsam · 7 Tage");
    expect(pulse.querySelectorAll(".contribution-pulse-segment")).toHaveLength(7);
    expect(pulse.querySelectorAll(".contribution-pulse-none")).toHaveLength(7);
    expect(pulse).not.toHaveTextContent(/\d+ Punkte/);

    const header = container.querySelector(".page-header")!;
    expect(
      header.compareDocumentPosition(pulse) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("switches between my and the household agenda from the compact header toggle", async () => {
    window.localStorage.setItem("machbar:identity-member-id", "1");
    mockedApi.getMembers.mockResolvedValue([
      makeMember({ id: 1, name: "Mira" }),
      makeMember({ id: 2, name: "Jonas" }),
    ]);
    mockedApi.getAgenda.mockImplementation(async (_memberId, scope) =>
      scope === "all"
        ? {
            ...makeEmptyAgenda(),
            dueToday: [
              makeTask({
                id: 20,
                title: "Jonas' Aufgabe",
                effectiveOwnerId: 2,
                effectiveOwnerSource: "task",
              }),
            ],
          }
        : {
            ...makeEmptyAgenda(),
            dueToday: [makeTask({ id: 10, title: "Meine Aufgabe" })],
          },
    );
    const { container } = renderWithProviders(<TodayPage />);

    const header = container.querySelector<HTMLElement>(".page-header")!;
    const toggle = within(header).getByRole("group", {
      name: "Umfang der Heute-Ansicht",
    });
    expect(toggle).toHaveClass("today-scope-toggle");
    expect(within(toggle).getByRole("button", { name: "Meine" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(await screen.findByText("Meine Aufgabe")).toBeInTheDocument();

    await userEvent.click(within(toggle).getByRole("button", { name: "Alle" }));

    await waitFor(() =>
      expect(mockedApi.getAgenda).toHaveBeenLastCalledWith(1, "all"),
    );
    expect(await screen.findByText("Jonas' Aufgabe")).toBeInTheDocument();
    expect(within(toggle).getByRole("button", { name: "Alle" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await userEvent.click(within(toggle).getByRole("button", { name: "Meine" }));
    await waitFor(() =>
      expect(mockedApi.getAgenda).toHaveBeenLastCalledWith(1, "mine"),
    );
  });

  it("remembers the household scope while this browser tab remains open", async () => {
    mockedApi.getAgenda.mockResolvedValue(makeEmptyAgenda());
    const first = renderWithProviders(<TodayPage />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Alle" }),
    );
    await waitFor(() =>
      expect(mockedApi.getAgenda).toHaveBeenLastCalledWith(null, "all"),
    );
    first.unmount();

    renderWithProviders(<TodayPage />);
    await waitFor(() =>
      expect(mockedApi.getAgenda).toHaveBeenLastCalledWith(null, "all"),
    );
    expect(screen.getByRole("button", { name: "Alle" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("never labels stale personal data as the household view after a failed switch", async () => {
    mockedApi.getMembers.mockResolvedValue([]);
    mockedApi.getAgenda
      .mockResolvedValueOnce({
        ...makeEmptyAgenda(),
        dueToday: [makeTask({ title: "Nur meine Aufgabe" })],
      })
      .mockRejectedValueOnce(new Error("Netzwerkfehler"));
    renderWithProviders(<TodayPage />);

    expect(await screen.findByText("Nur meine Aufgabe")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Alle" }));

    expect(screen.queryByText("Nur meine Aufgabe")).not.toBeInTheDocument();
    expect(await screen.findByText("Netzwerkfehler")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Alle" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
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
    expect(
      screen.getByText(
        "Nach rechts wischen: „Erledigen / Wieder öffnen“. Nach links wischen öffnet weitere Aktionen wie Zuweisen, Planen und Notizen. Am Desktop geht das auch über ⋯.",
      ),
    ).toBeInTheDocument();
    expect(container.querySelector(".task-row-surface-actionable")).toBeInTheDocument();
    expect(container.querySelector(".task-row-header")).toContainElement(
      screen.getByText("Finanzen"),
    );
    expect(screen.queryByText("Machbar")).not.toBeInTheDocument();
  });

  it("bündelt alle sichtbaren Abschnittshinweise im einzigen Seitenhinweis", async () => {
    const now = new Date();
    const today = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
    ].join("-");
    const revisitTask = makeTask({
      id: 2,
      title: "Leiter zurückbringen",
      blocked: true,
      scheduledDate: today,
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
    expect(screen.getByText("Wiedervorlage: heute")).toBeInTheDocument();
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
    expect(screen.queryByText(/Nach rechts wischen:/)).not.toBeInTheDocument();
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
      "/projects/77",
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
    await waitFor(() => expect(mockedApi.getAgenda).toHaveBeenCalledWith(1, "mine"));
    for (const [memberId, scope] of mockedApi.getAgenda.mock.calls) {
      expect(memberId === null || memberId === 1).toBe(true);
      expect(scope).toBe("mine");
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

    await waitFor(() =>
      expect(mockedApi.getAgenda).toHaveBeenCalledWith(null, "mine"),
    );
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

    await waitFor(() =>
      expect(mockedApi.getAgenda).toHaveBeenCalledWith(null, "mine"),
    );
    const initialCalls = mockedApi.getAgenda.mock.calls.length;

    const option = await screen.findByRole("option", { name: /Jonas/ });
    await userEvent.click(option);

    await waitFor(() =>
      expect(mockedApi.getAgenda).toHaveBeenCalledWith(2, "mine"),
    );
    expect(mockedApi.getAgenda.mock.calls.length).toBeGreaterThan(initialCalls);
    // The last call must reflect only the newly selected member — the
    // previous member's id must never be requested again after switching.
    expect(mockedApi.getAgenda.mock.calls.at(-1)).toEqual([2, "mine"]);
  });
});
