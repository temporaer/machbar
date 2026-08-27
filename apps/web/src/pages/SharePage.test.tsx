import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SharePage } from "./SharePage";
import { api } from "../lib/api";
import { RefreshProvider } from "../lib/refresh";
import { makeProject, makeTask } from "../test/fixtures";

vi.mock("../lib/api", () => ({
  api: {
    getProjects: vi.fn(),
    searchTasks: vi.fn(),
    getAgenda: vi.fn(),
    appendTaskNotes: vi.fn(),
    appendProjectNotes: vi.fn(),
    createTask: vi.fn(),
    createProject: vi.fn(),
  },
}));

vi.mock("../lib/identity", () => ({
  useIdentity: () => ({ currentMemberId: 1 }),
}));

const mockedApi = vi.mocked(api, true);

const emptyAgenda = {
  projects: [],
  planned: [],
  overdue: [],
  dueToday: [],
  dueSoon: [],
  shared: [],
  unscheduled: [],
  followUp: [],
  revisit: [],
};

function renderPage() {
  return render(
    <MemoryRouter>
      <RefreshProvider>
        <SharePage />
      </RefreshProvider>
    </MemoryRouter>,
  );
}

describe("SharePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockedApi.getProjects.mockResolvedValue([]);
    mockedApi.searchTasks.mockResolvedValue([]);
    mockedApi.getAgenda.mockResolvedValue(emptyAgenda);
    window.history.replaceState(null, "", "/");
  });

  it("prefills the reused Capture editor from a shared page", async () => {
    window.history.replaceState(
      null,
      "",
      "/?title=Farmladen&url=https%3A%2F%2Fmaps.example%2Ffarm#/share",
    );
    renderPage();

    await userEvent.click(screen.getByRole("button", { name: "+ Neue Aufgabe" }));

    expect(screen.getByLabelText("Nur Titel reicht")).toHaveValue("Farmladen");
    expect(screen.getByLabelText("Notizen")).toHaveValue("https://maps.example/farm");
    expect(window.location.search).toBe("");
  });

  it("shows an explicit exit instead of inert targets for an empty payload", async () => {
    window.history.replaceState(null, "", "/#/share");
    renderPage();

    expect(
      screen.getByText("Es wurde kein Inhalt zum Teilen übergeben."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Zu Machbar" })).toBeInTheDocument();
    expect(screen.queryByText("+ Neue Aufgabe")).not.toBeInTheDocument();
  });

  it("searches tasks and appends the incoming block immediately", async () => {
    const task = makeTask({ id: 8, title: "Urlaub planen", projectTitle: "Sommer" });
    mockedApi.searchTasks.mockResolvedValue([task]);
    mockedApi.appendTaskNotes.mockResolvedValue(task);
    window.history.replaceState(
      null,
      "",
      "/?text=Gasthaus%20Gutenberg&url=https%3A%2F%2Fmaps.example%2Fg#/share",
    );
    renderPage();

    await userEvent.type(
      await screen.findByLabelText("Aufgaben und Projekte durchsuchen"),
      "Urlaub",
    );
    await userEvent.click(screen.getByRole("button", { name: /Urlaub planen/ }));

    await waitFor(() =>
      expect(mockedApi.appendTaskNotes).toHaveBeenCalledWith(
        8,
        "Gasthaus Gutenberg\n\nhttps://maps.example/g",
      ),
    );
    expect(await screen.findByText("Zu „Urlaub planen“ hinzugefügt")).toBeInTheDocument();
  });

  it("shows a recent project before Today targets and appends to it", async () => {
    const project = makeProject({ id: 4, title: "Geburtstag" });
    mockedApi.getProjects.mockResolvedValue([project as never]);
    mockedApi.appendProjectNotes.mockResolvedValue(project as never);
    window.localStorage.setItem(
      "machbar:recent-share-targets",
      JSON.stringify([{ kind: "project", id: 4 }]),
    );
    window.history.replaceState(null, "", "/?text=Kuchenidee#/share");
    renderPage();

    expect(await screen.findByRole("heading", { name: "Zuletzt verwendet" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Geburtstag/ }));
    await waitFor(() =>
      expect(mockedApi.appendProjectNotes).toHaveBeenCalledWith(4, "Kuchenidee"),
    );
  });
});
