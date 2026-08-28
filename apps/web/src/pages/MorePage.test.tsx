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
