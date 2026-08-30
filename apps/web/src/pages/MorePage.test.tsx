import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
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

  it("keeps diagnostics at the bottom of settings", async () => {
    const { container } = renderWithProviders(<MorePage />);

    const link = await screen.findByRole("link", { name: /Debug/ });
    expect(link).toHaveAttribute("href", "/more/debug");
    expect(link.parentElement?.lastElementChild).toBe(link);
  });

  it("shows a shared-first unranked contribution summary", async () => {
    const { container } = renderWithProviders(<MorePage />);

    expect(
      await screen.findByRole("heading", { name: "Gemeinsam geschafft" }),
    ).toBeInTheDocument();
    expect(screen.getByText("+7", { selector: ".contribution-total" })).toBeInTheDocument();
    expect(screen.getByText("Mira")).toBeInTheDocument();
    expect(screen.getByText("+4 erledigt · +1 geplant")).toBeInTheDocument();
    expect(
      screen.getByText("Gemeinsamer Beitrag ohne persönliche Zuordnung"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Platz|Rang|winner/i)).not.toBeInTheDocument();
    expect(container.querySelector(".stack > :first-child")).toHaveClass(
      "contribution-card",
    );
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
