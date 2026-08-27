import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityEvent } from "@machbar/shared";
import { api } from "../lib/api";
import { RefreshProvider, useRefresh } from "../lib/refresh";
import { RecentActivity } from "./RecentActivity";

vi.mock("../lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/api")>();
  return {
    ...original,
    api: { ...original.api, getActivity: vi.fn() },
  };
});

const mockedGetActivity = vi.mocked(api.getActivity);

function event(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: 1,
    createdAt: new Date(2026, 7, 27, 18, 0).toISOString(),
    kind: "task_created",
    actor: { id: 7, name: "Mira", color: "#123456", pictureUrl: null },
    entity: { type: "task", title: "Kisten packen", taskId: 42, projectId: 9 },
    metadata: {},
    ...overrides,
  };
}

function RefreshButton() {
  const { bump } = useRefresh();
  return <button type="button" onClick={bump}>Refresh</button>;
}

function renderActivity(
  filters: { taskId?: number; projectId?: number },
) {
  return render(
    <MemoryRouter>
      <RefreshProvider>
        <RecentActivity filters={filters} idPrefix="context-activity" />
        <RefreshButton />
      </RefreshProvider>
    </MemoryRouter>,
  );
}

describe("RecentActivity", () => {
  beforeEach(() => {
    mockedGetActivity.mockReset();
  });

  it("stays collapsed and does not fetch until opened", async () => {
    mockedGetActivity.mockResolvedValue({ items: [event()], nextCursor: null });
    renderActivity({ taskId: 42 });

    const disclosure = screen.getByText("Letzte Aktivitäten").closest("details")!;
    expect(disclosure).not.toHaveAttribute("open");
    expect(mockedGetActivity).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(mockedGetActivity).not.toHaveBeenCalled();

    await userEvent.click(within(disclosure).getByText("Letzte Aktivitäten"));

    expect(await screen.findByText("Kisten packen")).toBeInTheDocument();
    expect(mockedGetActivity).toHaveBeenCalledWith({ taskId: 42, limit: 5 });
    expect(screen.getByRole("link", { name: "Alle Aktivitäten anzeigen" })).toHaveAttribute(
      "href",
      "/mehr/aktivitaeten?taskId=42",
    );
  });

  it("uses project filtering and shows compact empty and retry states", async () => {
    mockedGetActivity
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ items: [], nextCursor: null });
    renderActivity({ projectId: 9 });

    await userEvent.click(screen.getByText("Letzte Aktivitäten"));
    expect(await screen.findByText("Aktivitäten konnten nicht geladen werden.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));

    expect(await screen.findByText("Noch keine Aktivitäten.")).toBeInTheDocument();
    expect(mockedGetActivity).toHaveBeenLastCalledWith({ projectId: 9, limit: 5 });
    expect(screen.getByRole("link", { name: "Alle Aktivitäten anzeigen" })).toHaveAttribute(
      "href",
      "/mehr/aktivitaeten?projectId=9",
    );
  });

  it("reloads an open feed after a refresh bump", async () => {
    mockedGetActivity
      .mockResolvedValueOnce({ items: [event()], nextCursor: null })
      .mockResolvedValueOnce({
        items: [event({ id: 2, entity: { type: "task", title: "Neue Aktivität", taskId: 42, projectId: 9 } })],
        nextCursor: null,
      });
    renderActivity({ taskId: 42 });

    await userEvent.click(screen.getByText("Letzte Aktivitäten"));
    expect(await screen.findByText("Kisten packen")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(await screen.findByText("Neue Aktivität")).toBeInTheDocument();
    expect(mockedGetActivity).toHaveBeenCalledTimes(2);
  });

  it("defers a collapsed refresh until reopened", async () => {
    mockedGetActivity
      .mockResolvedValueOnce({ items: [event()], nextCursor: null })
      .mockResolvedValueOnce({ items: [], nextCursor: null });
    renderActivity({ taskId: 42 });

    const summary = screen.getByText("Letzte Aktivitäten");
    await userEvent.click(summary);
    expect(await screen.findByText("Kisten packen")).toBeInTheDocument();
    await userEvent.click(summary);
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(mockedGetActivity).toHaveBeenCalledTimes(1);
    await userEvent.click(summary);
    expect(await screen.findByText("Noch keine Aktivitäten.")).toBeInTheDocument();
    expect(mockedGetActivity).toHaveBeenCalledTimes(2);
  });

  it("ignores an obsolete response after filters change", async () => {
    let resolveTask: ((value: Awaited<ReturnType<typeof api.getActivity>>) => void) | undefined;
    mockedGetActivity
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveTask = resolve;
      }))
      .mockResolvedValueOnce({
        items: [event({ id: 2, entity: { type: "project", title: "Neues Projekt", taskId: null, projectId: 9 } })],
        nextCursor: null,
      });

    const view = render(
      <MemoryRouter>
        <RefreshProvider>
          <RecentActivity filters={{ taskId: 42 }} idPrefix="context-activity" />
        </RefreshProvider>
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByText("Letzte Aktivitäten"));
    await waitFor(() =>
      expect(mockedGetActivity).toHaveBeenCalledWith({ taskId: 42, limit: 5 }),
    );

    view.rerender(
      <MemoryRouter>
        <RefreshProvider>
          <RecentActivity filters={{ projectId: 9 }} idPrefix="context-activity" />
        </RefreshProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText("Neues Projekt")).toBeInTheDocument();
    resolveTask?.({ items: [event()], nextCursor: null });

    expect(screen.queryByText("Kisten packen")).not.toBeInTheDocument();
    expect(mockedGetActivity).toHaveBeenLastCalledWith({ projectId: 9, limit: 5 });
  });
});
