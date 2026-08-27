import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
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
  it("links to the dedicated tag catalogue instead of expanding it inline", async () => {
    const { container } = renderWithProviders(<MorePage />);

    const link = await screen.findByRole("link", { name: /Tags verwalten/ });
    expect(link).toHaveAttribute("href", "/mehr/tags");
    expect(container.querySelector(".tag-manager")).toBeNull();
  });

  it("links to the global activity feed", async () => {
    renderWithProviders(<MorePage />);

    expect(await screen.findByRole("link", { name: /Aktivitäten/ })).toHaveAttribute(
      "href",
      "/mehr/aktivitaeten",
    );
  });
});
