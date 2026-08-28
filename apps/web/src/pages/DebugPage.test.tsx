import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../test/testUtils";
import { api } from "../lib/api";
import { DebugPage } from "./DebugPage";

vi.mock("../lib/api", () => ({
  api: {
    getAuthStatus: vi.fn().mockResolvedValue({
      enabled: false,
      authenticated: false,
      member: null,
    }),
    getMembers: vi.fn().mockResolvedValue([]),
    getDebugMetrics: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api);

describe("DebugPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.getDebugMetrics.mockResolvedValue({
      generatedAt: "2026-08-29T00:00:00.000Z",
      processStartedAt: "2026-08-28T22:00:00.000Z",
      processUptimeSeconds: 7200,
      database: {
        allocatedBytes: 225280,
        usedBytes: 221184,
        pageSizeBytes: 4096,
        pageCount: 55,
        freelistPages: 1,
        counts: {
          members: 2,
          projects: 12,
          tasks: 41,
          tags: 11,
          dependencies: 16,
          activityEvents: 50,
          contributionEvents: 11,
        },
        taskStatusCounts: {
          captured: 0,
          actionable: 21,
          waiting: 5,
          someday: 0,
          done: 15,
          cancelled: 0,
        },
        projectStatusCounts: {
          backlog: 3,
          active: 7,
          completed: 1,
          archived: 1,
        },
        maxTaskDepth: 2,
        tasksCreatedToday: 4,
        tasksCreatedLast7Days: 41,
        activityEventsCreatedLast7Days: 50,
      },
      graphLoads: {
        totalLoads: 23,
        recentSamples: 23,
        averageMs: 2.75,
        p50Ms: 2.6,
        p95Ms: 4.3,
        maxMs: 6.5,
        lastMs: 2.4,
        lastTaskCount: 41,
        lastProjectCount: 12,
      },
    });
  });

  it("shows database and graph-load metrics and refreshes them", async () => {
    renderWithProviders(<DebugPage />);

    expect((await screen.findAllByText("41")).length).toBeGreaterThan(0);
    expect(screen.getByText("216.0 KiB")).toBeInTheDocument();
    expect(screen.getByText("2.60 ms")).toBeInTheDocument();
    expect(screen.getByText("41 / 12")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Aktualisieren" }));
    expect(mockedApi.getDebugMetrics).toHaveBeenCalledTimes(2);
  });
});
