import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LocaleProvider } from "../lib/locale";
import { RefreshProvider } from "../lib/refresh";
import { api } from "../lib/api";
import { ContributionCard } from "./ContributionCard";

vi.mock("../lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/api")>();
  return {
    ...original,
    api: { ...original.api, getContributionSummary: vi.fn() },
  };
});

const mockedSummary = vi.mocked(api.getContributionSummary);

describe("ContributionCard", () => {
  beforeEach(() => {
    mockedSummary.mockResolvedValue({
      windowStartedAt: "2026-08-21T10:00:00.000Z",
      windowEndedAt: "2026-08-28T10:00:00.000Z",
      sharedTotal: -1,
      sharedOnlyTotal: -1,
      sharedCategories: { completion: -1, planning: 0 },
      members: [],
      pulse: [],
    });
  });

  it("renders signed totals and shared-only penalties", async () => {
    render(
      <LocaleProvider initialLocale="de">
        <RefreshProvider>
          <ContributionCard />
        </RefreshProvider>
      </LocaleProvider>,
    );

    expect(await screen.findAllByText("-1")).not.toHaveLength(0);
    expect(
      screen.getByText("Gemeinsamer Beitrag ohne persönliche Zuordnung"),
    ).toBeInTheDocument();
    expect(screen.getByText("0")).toBeInTheDocument();
  });
});
