import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/testUtils";
import { MorePage } from "./MorePage";

vi.mock("../lib/api", () => ({
  api: {
    getAuthStatus: vi.fn().mockResolvedValue({
      enabled: false,
      authenticated: false,
      member: null,
    }),
    getMembers: vi.fn().mockResolvedValue([]),
    getPushConfig: vi.fn().mockResolvedValue({
      enabled: false,
      publicKey: null,
    }),
    getPushNotificationPreferences: vi.fn().mockResolvedValue({
      project_assigned: true,
      task_reminder: true,
      context_entered: true,
    }),
    getContributionSummary: vi.fn().mockResolvedValue({
      windowStartedAt: "2026-08-21T10:00:00.000Z",
      windowEndedAt: "2026-08-28T10:00:00.000Z",
      sharedTotal: 7,
      sharedOnlyTotal: 2,
      sharedCategories: { completion: 4, planning: 3 },
      members: [
        {
          member: {
            id: 1,
            name: "Mira",
            color: "#123456",
            pictureUrl: null,
          },
          total: 5,
          categories: { completion: 4, planning: 1 },
        },
      ],
      pulse: Array.from({ length: 7 }, (_, index) => ({
        startedAt: new Date(Date.UTC(2026, 7, 21 + index, 10)).toISOString(),
        endedAt: new Date(Date.UTC(2026, 7, 22 + index, 10)).toISOString(),
        level: "low",
      })),
    }),
    getMoreCounts: vi.fn().mockResolvedValue({
      review: 7,
    }),
    getHomeAssistantStatus: vi.fn().mockResolvedValue({
      connected: true,
      instanceId: "ha-1",
      protocolVersion: 1,
      connectedAt: "2026-09-03T10:00:00.000Z",
      lastUpdateAt: "2026-09-03T12:00:00.000Z",
      stale: false,
      contexts: [],
      people: [
        {
          externalId: "person.mira",
          name: "Mira",
          state: "known",
          contexts: [
            {
              id: 1,
              source: "home_assistant",
              externalId: "zone.seligenstadt",
              name: "Seligenstadt",
              active: true,
              updatedAt: "2026-09-03T12:00:00.000Z",
            },
          ],
          mappedMemberId: 1,
          observedAt: "2026-09-03T12:00:00.000Z",
        },
      ],
    }),
  },
}));

describe("MorePage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("links to the dedicated tag catalogue instead of expanding it inline", async () => {
    const { container } = renderWithProviders(<MorePage />);

    const link = await screen.findByRole("link", { name: /Tags verwalten/ });
    expect(link).toHaveAttribute("href", "/more/tags");
    expect(container.querySelector(".tag-manager")).toBeNull();
  });

  it("links to the global activity feed", async () => {
    renderWithProviders(<MorePage />);

    expect(await screen.findByRole("link", { name: /Aktivitäten/ })).toHaveAttribute(
      "href",
      "/more/activity",
    );
  });

  it("shows the consolidated Review count and exhaustive inventory", async () => {
    renderWithProviders(<MorePage />);

    expect(await screen.findByRole("link", { name: /Review.*7/ })).toHaveAttribute(
      "href",
      "/more/review",
    );
    expect(screen.getByRole("link", { name: "Alles" })).toHaveAttribute(
      "href",
      "/more/all",
    );
    expect(screen.queryByRole("link", { name: /Festgefahren|Backlog prüfen|Arbeit klären/ }))
      .not.toBeInTheDocument();
  });

  it("keeps diagnostics at the bottom of settings", async () => {
    renderWithProviders(<MorePage />);

    expect(screen.queryByRole("link", { name: /Debug/ })).not.toBeInTheDocument();
    const administration = screen
      .getByText("Administration")
      .closest("details");
    expect(administration).not.toHaveAttribute("open");
    expect(administration).toContainElement(
      screen.getByRole("heading", { name: "Personen verwalten" }),
    );
    await userEvent.click(screen.getByText("Administration"));
    expect(
      screen.getByRole("heading", { name: "Personen verwalten" }),
    ).toBeInTheDocument();
    const toggle = screen.getByRole("switch", { name: /Entwicklermodus/ });
    await userEvent.click(toggle);
    const link = screen.getByRole("link", { name: /Debug/ });
    expect(link).toHaveAttribute("href", "/more/debug");
    expect(window.localStorage.getItem("machbar:developer-mode")).toBe("true");
  });

  it("shows Home Assistant's current person locations in administration", async () => {
    renderWithProviders(<MorePage />);

    await userEvent.click(screen.getByText("Administration"));

    expect(screen.getByRole("heading", { name: "Zuletzt gemeldete Orte" }))
      .toBeInTheDocument();
    expect(screen.getByText("Aktueller Ort: Seligenstadt"))
      .toBeInTheDocument();
  });

  it("shows a shared-first unranked contribution summary", async () => {
    renderWithProviders(<MorePage />);

    expect(
      await screen.findByRole("heading", { name: "Gemeinsam geschafft" }),
    ).toBeInTheDocument();
    expect(screen.getByText("+7", { selector: ".contribution-total" })).toBeInTheDocument();
    const personalBreakdown = screen
      .getByText("Persönliche Aufteilung")
      .closest("details");
    expect(personalBreakdown).not.toHaveAttribute("open");
    await userEvent.click(screen.getByText("Persönliche Aufteilung"));
    expect(personalBreakdown).toHaveAttribute("open");
    expect(within(personalBreakdown!).getByText("Mira")).toBeInTheDocument();
    expect(screen.getByText("+4 erledigt · +1 geplant")).toBeInTheDocument();
    expect(
      screen.getByText("Gemeinsamer Beitrag ohne persönliche Zuordnung"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Platz|Rang|winner/i)).not.toBeInTheDocument();
  });

  it("groups destinations and settings by purpose", async () => {
    renderWithProviders(<MorePage />, { locale: "en" });

    expect(await screen.findByRole("heading", { name: "Household momentum" }))
      .toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Find and review" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Preferences" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Household" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "System" })).toBeInTheDocument();
    expect(screen.getByText("Administration").closest("details"))
      .not.toHaveAttribute("open");
  });

  it("renders English and switches locale immediately on this device", async () => {
    renderWithProviders(<MorePage />, { locale: "en" });

    expect(await screen.findByRole("heading", { name: "More" })).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Activity.*Changes to tasks and projects/ }),
    ).toHaveAttribute("href", "/more/activity");

    await userEvent.click(
      screen.getByRole("button", { name: "Deutsch" }),
    );
    expect(screen.getByRole("heading", { name: "Mehr" })).toBeInTheDocument();
    expect(window.localStorage.getItem("machbar:locale")).toBe("de");
  });

  it("offers touch-friendly appearance choices and persists dark mode", async () => {
    renderWithProviders(<MorePage />, { locale: "en" });

    const appearance = screen.getByRole("group", { name: "Theme" });
    const system = screen.getByRole("button", { name: "System" });
    const dark = screen.getByRole("button", { name: "Dark" });

    expect(appearance).toContainElement(system);
    expect(system).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(dark);

    expect(dark).toHaveAttribute("aria-pressed", "true");
    expect(window.localStorage.getItem("machbar:theme")).toBe("dark");
  });
});
