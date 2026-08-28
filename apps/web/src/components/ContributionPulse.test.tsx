import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ContributionPulseLevel,
  ContributionSummary,
} from "@machbar/shared";
import { LocaleProvider } from "../lib/locale";
import { RefreshProvider, useRefresh } from "../lib/refresh";
import { api } from "../lib/api";
import { ContributionPulse } from "./ContributionPulse";

vi.mock("../lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/api")>();
  return {
    ...original,
    api: { ...original.api, getContributionSummary: vi.fn() },
  };
});

const mockedGetContributionSummary = vi.mocked(api.getContributionSummary);

function summary(levels: ContributionPulseLevel[]): ContributionSummary {
  return {
    windowStartedAt: "2026-08-21T10:00:00.000Z",
    windowEndedAt: "2026-08-28T10:00:00.000Z",
    sharedTotal: 0,
    sharedOnlyTotal: 0,
    sharedCategories: { completion: 0, planning: 0 },
    members: [],
    pulse: levels.map((level, index) => ({
      startedAt: new Date(Date.UTC(2026, 7, 21 + index, 10)).toISOString(),
      endedAt: new Date(Date.UTC(2026, 7, 22 + index, 10)).toISOString(),
      level,
    })),
  };
}

function RefreshButton() {
  const { bump } = useRefresh();
  return <button type="button" onClick={bump}>Refresh</button>;
}

function renderPulse() {
  return render(
    <LocaleProvider initialLocale="de">
      <MemoryRouter>
        <RefreshProvider>
          <ContributionPulse />
          <RefreshButton />
        </RefreshProvider>
      </MemoryRouter>
    </LocaleProvider>,
  );
}

describe("ContributionPulse", () => {
  beforeEach(() => {
    mockedGetContributionSummary.mockReset();
  });

  it("keeps seven neutral segments at zero and refreshes their intensity", async () => {
    mockedGetContributionSummary
      .mockResolvedValueOnce(summary(Array(7).fill("none")))
      .mockResolvedValueOnce(
        summary(["none", "low", "medium", "high", "none", "low", "high"]),
      );
    const { container } = renderPulse();

    await waitFor(() =>
      expect(mockedGetContributionSummary).toHaveBeenCalledTimes(1),
    );
    expect(container.querySelectorAll(".contribution-pulse-none")).toHaveLength(7);

    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(container.querySelectorAll(".contribution-pulse-high")).toHaveLength(2),
    );
    expect(mockedGetContributionSummary).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("link", {
      name: /Von früher nach heute: keine, wenige, einige, viele, keine, wenige, viele/,
    })).toHaveAttribute("href", "/more");
  });

  it("shows retry on failure without inventing colored activity", async () => {
    mockedGetContributionSummary
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(summary(Array(7).fill("low")));
    const { container } = renderPulse();

    const retry = await screen.findByRole("button", {
      name: "Beiträge neu laden",
    });
    expect(container.querySelectorAll(".contribution-pulse-none")).toHaveLength(7);

    await userEvent.click(retry);
    await waitFor(() =>
      expect(container.querySelectorAll(".contribution-pulse-low")).toHaveLength(7),
    );
  });
});
