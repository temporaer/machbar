import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityEvent } from "@machbar/shared";
import { api } from "../lib/api";
import { ActivityPage, activityFiltersFromSearchParams } from "./ActivityPage";

vi.mock("../lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/api")>();
  return {
    ...original,
    api: {
      ...original.api,
      getActivity: vi.fn(),
    },
  };
});

const mockedGetActivity = vi.mocked(api.getActivity);

function event(id: number, title: string): ActivityEvent {
  return {
    id,
    createdAt: new Date(2026, 7, 27, 18, id).toISOString(),
    kind: "task_created",
    actor: { id: 1, name: "Mira", color: "#123456" },
    entity: { type: "task", title, taskId: id, projectId: null },
    metadata: {},
  };
}

describe("ActivityPage", () => {
  beforeEach(() => {
    mockedGetActivity.mockReset();
  });

  it("shows the shared loading state while the initial request is pending", () => {
    mockedGetActivity.mockReturnValue(new Promise(() => {}));
    render(
      <MemoryRouter>
        <ActivityPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Lädt");
  });

  it("passes optional URL filters and bounded page size to the API", async () => {
    mockedGetActivity.mockResolvedValue({ items: [], nextCursor: null });
    render(
      <MemoryRouter initialEntries={["/mehr/aktivitaeten?actorId=2&taskId=3&projectId=4"]}>
        <ActivityPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Noch keine Aktivitäten vorhanden.")).toBeInTheDocument();
    expect(mockedGetActivity).toHaveBeenCalledWith({
      actorId: 2,
      taskId: 3,
      projectId: 4,
      limit: 25,
    });
  });

  it("loads another cursor page and appends its events", async () => {
    mockedGetActivity
      .mockResolvedValueOnce({ items: [event(1, "Erste Aufgabe")], nextCursor: "next" })
      .mockResolvedValueOnce({ items: [event(2, "Zweite Aufgabe")], nextCursor: null });
    render(
      <MemoryRouter>
        <ActivityPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Erste Aufgabe")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Mehr laden" }));
    expect(await screen.findByText("Zweite Aufgabe")).toBeInTheDocument();
    expect(mockedGetActivity).toHaveBeenLastCalledWith({
      cursor: "next",
      limit: 25,
    });
    expect(screen.queryByRole("button", { name: "Mehr laden" })).toBeNull();
  });

  it("shows an error and retries the initial request", async () => {
    mockedGetActivity
      .mockRejectedValueOnce(new Error("Netzwerk nicht erreichbar"))
      .mockResolvedValueOnce({ items: [], nextCursor: null });
    render(
      <MemoryRouter>
        <ActivityPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Netzwerk nicht erreichbar")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    expect(await screen.findByText("Noch keine Aktivitäten vorhanden.")).toBeInTheDocument();
    expect(mockedGetActivity).toHaveBeenCalledTimes(2);
  });
});

describe("activityFiltersFromSearchParams", () => {
  it("ignores invalid filter values", () => {
    expect(
      activityFiltersFromSearchParams(
        new URLSearchParams("actorId=0&taskId=nope&projectId=-1"),
      ),
    ).toEqual({});
  });
});
