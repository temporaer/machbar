import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/testUtils";
import { api } from "../lib/api";
import type { OwnerSizeCounts, RefinementTaskRow } from "../lib/api";
import { REFINEMENT_RETENTION_MS } from "../lib/useRefinementActions";
import { makeTask } from "../test/fixtures";
import { RefinementPage } from "./RefinementPage";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    searchTasks: vi.fn(),
    getRefinementOwners: vi.fn(),
    getRefinementTasks: vi.fn(),
    getRefinementIssues: vi.fn(),
    updateTask: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

function ownerRow(overrides: Partial<OwnerSizeCounts> = {}): OwnerSizeCounts {
  return { ownerId: 1, ownerName: "Mira", S: 0, M: 0, L: 0, XL: 0, unestimated: 0, total: 0, ...overrides };
}

function taskRow(overrides: Partial<RefinementTaskRow> = {}): RefinementTaskRow {
  return {
    id: 1,
    title: "Beispielaufgabe",
    status: "actionable",
    size: null,
    projectId: null,
    projectTitle: null,
    effectiveOwnerId: null,
    effectiveOwnerSource: "none",
    position: 0,
    updatedAt: "2026-01-01T09:00:00.000Z",
    ...overrides,
  };
}

async function flushMicrotasks(times = 3) {
  for (let i = 0; i < times; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
}

describe("RefinementPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.getMembers.mockResolvedValue([]);
    mockedApi.searchTasks.mockResolvedValue([]);
    mockedApi.getRefinementIssues.mockResolvedValue({ issues: [], projects: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the owner x size matrix including the shared/unassigned ('Gemeinsam / offen') bucket, and the open task list with story/owner/size", async () => {
    mockedApi.getRefinementOwners.mockResolvedValue([
      ownerRow({ ownerId: 1, ownerName: "Mira", M: 1, total: 1 }),
      ownerRow({ ownerId: null, ownerName: null, S: 1, total: 1 }),
    ]);
    mockedApi.getRefinementTasks.mockResolvedValue([
      taskRow({
        id: 101,
        title: "Angebot einholen",
        size: "M",
        projectId: 5,
        projectTitle: "Hausumbau",
        effectiveOwnerId: 1,
        effectiveOwnerSource: "task",
      }),
      taskRow({ id: 102, title: "Rasen mähen", size: "S", effectiveOwnerId: null }),
    ]);

    renderWithProviders(<RefinementPage />);

    await screen.findByText("Angebot einholen");
    expect(screen.getByRole("button", { name: "Mira" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Gemeinsam / offen" })).toBeInTheDocument();
    expect(screen.getByText(/Hausumbau/)).toBeInTheDocument();
    expect(screen.getByText("Rasen mähen")).toBeInTheDocument();
  });

  it("merges blocked/waiting-for context from the unfiltered task search into the refinement list", async () => {
    mockedApi.getRefinementOwners.mockResolvedValue([ownerRow({ ownerId: null, ownerName: null })]);
    mockedApi.getRefinementTasks.mockResolvedValue([
      taskRow({ id: 201, title: "Handwerker anrufen", status: "waiting", effectiveOwnerId: null }),
    ]);
    mockedApi.searchTasks.mockResolvedValue([
      makeTask({ id: 201, status: "waiting", waitingFor: "Rückruf vom Handwerker", blocked: true }),
    ]);

    renderWithProviders(<RefinementPage />);

    await screen.findByText("Handwerker anrufen");
    expect(screen.getByText(/Rückruf vom Handwerker/)).toBeInTheDocument();
    expect(screen.getByLabelText("Blockiert durch")).toBeInTheDocument();
  });

  it("filters the task list by clicking a matrix cell, and resets via the reset button", async () => {
    mockedApi.getRefinementOwners.mockResolvedValue([
      ownerRow({ ownerId: 1, ownerName: "Mira", M: 1, total: 1 }),
      ownerRow({ ownerId: null, ownerName: null, S: 1, total: 1 }),
    ]);
    mockedApi.getRefinementTasks.mockResolvedValue([
      taskRow({ id: 301, title: "Mira-Aufgabe", size: "M", effectiveOwnerId: 1 }),
      taskRow({ id: 302, title: "Geteilte Aufgabe", size: "S", effectiveOwnerId: null }),
    ]);

    renderWithProviders(<RefinementPage />);
    await screen.findByText("Mira-Aufgabe");
    expect(screen.getByText("Geteilte Aufgabe")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Mira" }));

    expect(screen.getByText("Mira-Aufgabe")).toBeInTheDocument();
    expect(screen.queryByText("Geteilte Aufgabe")).not.toBeInTheDocument();
    expect(screen.getByText(/Gefiltert nach/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Filter zurücksetzen" }));
    expect(screen.getByText("Geteilte Aufgabe")).toBeInTheDocument();
  });

  it("shows the empty state when no open task matches the current filter", async () => {
    mockedApi.getRefinementOwners.mockResolvedValue([ownerRow({ ownerId: 1, ownerName: "Mira" })]);
    mockedApi.getRefinementTasks.mockResolvedValue([]);

    renderWithProviders(<RefinementPage />);
    expect(await screen.findByText("Keine offenen Aufgaben in dieser Übersicht.")).toBeInTheDocument();
  });

  it("defers the owner/list refetch (so the matrix regrouping is visible) until the retention window elapses after a swipe-driven size change", async () => {
    vi.useFakeTimers();
    mockedApi.getRefinementOwners.mockResolvedValue([
      ownerRow({ ownerId: null, ownerName: null, unestimated: 1, total: 1 }),
    ]);
    mockedApi.getRefinementTasks.mockResolvedValue([
      taskRow({ id: 401, title: "Neue Story schätzen", size: null, effectiveOwnerId: null }),
    ]);
    mockedApi.updateTask.mockResolvedValue(
      makeTask({ id: 401, size: "S" }),
    );

    const { container } = renderWithProviders(<RefinementPage />);
    await act(async () => {
      await flushMicrotasks();
    });
    expect(screen.getByText("Neue Story schätzen")).toBeInTheDocument();
    expect(mockedApi.getRefinementOwners).toHaveBeenCalledTimes(1);

    const content = container.querySelector(".refinement-row-content") as HTMLElement;
    fireEvent.pointerDown(content, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(content, { clientX: 100, pointerId: 1 });
    fireEvent.pointerUp(content, { clientX: 100, pointerId: 1 });

    await act(async () => {
      await flushMicrotasks();
    });
    expect(mockedApi.updateTask).toHaveBeenCalledWith(401, { size: "S" });

    // Row still rendered (retained) and the matrix/list have not refetched yet.
    expect(screen.getByText("Neue Story schätzen")).toBeInTheDocument();
    expect(mockedApi.getRefinementOwners).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFINEMENT_RETENTION_MS + 500);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    // Retention elapsed: the deferred global refresh finally triggered a refetch.
    expect(mockedApi.getRefinementOwners).toHaveBeenCalledTimes(2);
  });
});
