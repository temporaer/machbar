import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
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
    const toggle = within(header).getByRole("button", {
      name: "Aufgaben aller Personen anzeigen",
    });
    expect(toggle).toHaveClass("page-header-button", "today-scope-toggle");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(await screen.findByText("Meine Aufgabe")).toBeInTheDocument();

    await userEvent.click(toggle);

    await waitFor(() =>
      expect(mockedApi.getAgenda).toHaveBeenLastCalledWith(1, "all"),
    );
    expect(await screen.findByText("Jonas' Aufgabe")).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle).toHaveClass("today-scope-toggle");

    await userEvent.click(toggle);
    await waitFor(() =>
      expect(mockedApi.getAgenda).toHaveBeenLastCalledWith(1, "mine"),
    );
  });

  it("remembers the household scope while this browser tab remains open", async () => {
    mockedApi.getAgenda.mockResolvedValue(makeEmptyAgenda());
    const first = renderWithProviders(<TodayPage />);

    await userEvent.click(
      await screen.findByRole("button", {
        name: "Aufgaben aller Personen anzeigen",
      }),
    );
    await waitFor(() =>
      expect(mockedApi.getAgenda).toHaveBeenLastCalledWith(null, "all"),
    );
    first.unmount();

    renderWithProviders(<TodayPage />);
    await waitFor(() =>
      expect(mockedApi.getAgenda).toHaveBeenLastCalledWith(null, "all"),
    );
    expect(
      screen.getByRole("button", {
        name: "Aufgaben aller Personen anzeigen",
      }),
    ).toHaveAttribute("aria-pressed", "true");
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
    await userEvent.click(
      screen.getByRole("button", {
        name: "Aufgaben aller Personen anzeigen",
      }),
    );

    expect(screen.queryByText("Nur meine Aufgabe")).not.toBeInTheDocument();
    expect(await screen.findByText("Netzwerkfehler")).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Aufgaben aller Personen anzeigen",
      }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps the loaded agenda stable during a background refresh", async () => {
    let resolveRefresh!: (agenda: Agenda) => void;
    const refresh = new Promise<Agenda>((resolve) => {
      resolveRefresh = resolve;
    });
    mockedApi.getAgenda
      .mockResolvedValueOnce({
        ...makeEmptyAgenda(),
        dueToday: [makeTask({ title: "Bleibt sichtbar" })],
      })
      .mockReturnValueOnce(refresh);
    const { container } = renderWithProviders(<TodayPage />);

    expect(await screen.findByText("Bleibt sichtbar")).toBeInTheDocument();
    expect(container.querySelector(".loading-state")).not.toBeInTheDocument();

    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(mockedApi.getAgenda).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Bleibt sichtbar")).toBeInTheDocument();
    expect(container.querySelector(".loading-state")).not.toBeInTheDocument();

    act(() =>
      resolveRefresh({
        ...makeEmptyAgenda(),
        dueToday: [makeTask({ title: "Frisch geladen" })],
      }),
    );
    expect(await screen.findByText("Frisch geladen")).toBeInTheDocument();
    expect(screen.queryByText("Bleibt sichtbar")).not.toBeInTheDocument();
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
      "Hier steht, was jetzt wirklich dran ist: geplante und fällige Arbeit, Wiedervorlagen und die nächsten machbaren Projektschritte.";
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
      executable: false,
      scheduledDate: today,
      externalWait: {
        waitingFor: "Rückmeldung der Nachbarn",
        revisitDate: today,
      },
      nextBlockerAttentionDate: today,
    });
    mockedApi.getAgenda.mockResolvedValue({
      ...makeEmptyAgenda(),
      revisit: [revisitTask],
    });
    renderWithProviders(<TodayPage />);

    expect(await screen.findByText("Blockiert prüfen")).toBeInTheDocument();
    const revisitHint = "Blockiert, aber heute wieder zu prüfen.";
    expect(screen.queryByText(revisitHint)).not.toBeInTheDocument();
    const infoButtons = screen.getAllByRole("button", {
      name: "Hinweise zu dieser Seite anzeigen",
    });
    expect(infoButtons).toHaveLength(1);
    await userEvent.click(
      screen.getByRole("button", { name: "Hinweise zu dieser Seite anzeigen" }),
    );
    expect(screen.getByText(revisitHint)).toBeInTheDocument();
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
          nextActionContextAvailability: null,
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
