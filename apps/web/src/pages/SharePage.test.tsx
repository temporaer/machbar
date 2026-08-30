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
    updateTask: vi.fn(),
    updateProject: vi.fn(),
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

  it("previews and applies a Calendar deadline atomically to a Task without one", async () => {
    const task = makeTask({
      id: 8,
      revision: 3,
      title: "Elternabend vorbereiten",
      notes: "Bestehende Notiz",
    });
    mockedApi.searchTasks.mockResolvedValue([task]);
    mockedApi.updateTask.mockResolvedValue(
      makeTask({ ...task, revision: 4, dueDate: "2026-09-15" }),
    );
    window.history.replaceState(
      null,
      "",
      "/?title=Elternabend&text=15.%20Sept.%20%E2%80%A2%2019%3A00%E2%80%9321%3A00%20%E2%80%A2%20Details%20ansehen%0Ahttps%3A%2F%2Fcalendar.app.google%2Fabc123#/share",
    );
    renderPage();

    expect(await screen.findByText("Fällig: 15.09.2026")).toBeInTheDocument();
    await userEvent.type(
      screen.getByLabelText("Aufgaben und Projekte durchsuchen"),
      "Elternabend vorbereiten",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Elternabend vorbereiten/ }),
    );

    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(8, {
        notes:
          "Bestehende Notiz\n\nElternabend\n\n15. Sept. • 19:00–21:00 • Details ansehen\nhttps://calendar.app.google/abc123",
        dueDate: "2026-09-15",
        expectedRevision: 3,
      }),
    );
    expect(mockedApi.appendTaskNotes).not.toHaveBeenCalled();
  });

  it("uses the normal append endpoint when a Project already has the Calendar deadline", async () => {
    const project = makeProject({
      id: 4,
      title: "Geburtstag",
      dueDate: "2026-09-21",
    });
    mockedApi.getProjects.mockResolvedValue([project]);
    mockedApi.appendProjectNotes.mockResolvedValue(project);
    window.history.replaceState(
      null,
      "",
      "/?title=Pauls%20Geburtstag&text=21.%20September%202026%20%E2%80%A2%2015%3A00%0Ahttps%3A%2F%2Fcalendar.app.google%2Fbirthday#/share",
    );
    renderPage();

    await userEvent.type(
      await screen.findByLabelText("Aufgaben und Projekte durchsuchen"),
      "Geburtstag",
    );
    await userEvent.click(screen.getByRole("button", { name: /Geburtstag/ }));

    await waitFor(() =>
      expect(mockedApi.appendProjectNotes).toHaveBeenCalledWith(
        4,
        "Pauls Geburtstag\n\n21. September 2026 • 15:00\nhttps://calendar.app.google/birthday",
      ),
    );
    expect(mockedApi.updateProject).not.toHaveBeenCalled();
  });

  it("keeps an existing Task deadline after an inline Calendar conflict choice", async () => {
    const task = makeTask({
      id: 8,
      title: "Geschenk kaufen",
      dueDate: "2026-09-20",
    });
    mockedApi.searchTasks.mockResolvedValue([task]);
    mockedApi.appendTaskNotes.mockResolvedValue(task);
    window.history.replaceState(
      null,
      "",
      "/?title=Pauls%20Geburtstag&text=21.%20September%202026%20%E2%80%A2%2015%3A00%0Ahttps%3A%2F%2Fcalendar.app.google%2Fbirthday#/share",
    );
    renderPage();

    await userEvent.type(
      await screen.findByLabelText("Aufgaben und Projekte durchsuchen"),
      "Geschenk",
    );
    await userEvent.click(screen.getByRole("button", { name: /Geschenk kaufen/ }));

    expect(
      screen.getByText(
        "„Geschenk kaufen“ ist bereits am 20.09.2026 fällig. Kalendertermin: 21.09.2026.",
      ),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Bestehende Deadline behalten" }),
    );

    await waitFor(() =>
      expect(mockedApi.appendTaskNotes).toHaveBeenCalledOnce(),
    );
    expect(mockedApi.updateTask).not.toHaveBeenCalled();
  });

  it("replaces a conflicting Project deadline with one revision-checked PATCH", async () => {
    const project = makeProject({
      id: 4,
      revision: 5,
      title: "Geburtstag",
      notes: "Geschenkliste",
      dueDate: "2026-09-20",
    });
    mockedApi.getProjects.mockResolvedValue([project]);
    mockedApi.updateProject.mockResolvedValue(
      makeProject({ ...project, revision: 6, dueDate: "2026-09-21" }),
    );
    window.history.replaceState(
      null,
      "",
      "/?title=Pauls%20Geburtstag&text=21.%20September%202026%20%E2%80%A2%2015%3A00%0Ahttps%3A%2F%2Fcalendar.app.google%2Fbirthday#/share",
    );
    renderPage();

    await userEvent.type(
      await screen.findByLabelText("Aufgaben und Projekte durchsuchen"),
      "Geburtstag",
    );
    await userEvent.click(screen.getByRole("button", { name: /Geburtstag/ }));
    await userEvent.click(
      screen.getByRole("button", { name: "21.09.2026 übernehmen" }),
    );

    await waitFor(() =>
      expect(mockedApi.updateProject).toHaveBeenCalledWith(4, {
        notes:
          "Geschenkliste\n\nPauls Geburtstag\n\n21. September 2026 • 15:00\nhttps://calendar.app.google/birthday",
        dueDate: "2026-09-21",
        expectedRevision: 5,
      }),
    );
    expect(mockedApi.appendProjectNotes).not.toHaveBeenCalled();
  });

  it("prefills the existing Capture form with the parsed Calendar deadline", async () => {
    window.history.replaceState(
      null,
      "",
      "/?title=Elternabend&text=15.%20September%202026%20%E2%80%A2%2019%3A00%0Ahttps%3A%2F%2Fcalendar.app.google%2Fabc123#/share",
    );
    renderPage();

    await userEvent.click(
      await screen.findByRole("button", { name: "+ Neue Aufgabe" }),
    );

    expect(screen.getByLabelText("Fällig")).toHaveValue("15.09.2026");
  });

  it("reloads destinations and reports a stale atomic Calendar update", async () => {
    const task = makeTask({
      id: 8,
      revision: 3,
      title: "Elternabend vorbereiten",
      notes: "Bestehende Notiz",
    });
    mockedApi.searchTasks.mockResolvedValue([task]);
    mockedApi.updateTask.mockRejectedValue(
      Object.assign(new Error("stale"), {
        name: "ApiError",
        code: "stale_write_conflict",
      }),
    );
    window.history.replaceState(
      null,
      "",
      "/?title=Elternabend&text=15.%20September%202026%20%E2%80%A2%2019%3A00%0Ahttps%3A%2F%2Fcalendar.app.google%2Fabc123#/share",
    );
    renderPage();

    await userEvent.type(
      await screen.findByLabelText("Aufgaben und Projekte durchsuchen"),
      "Elternabend",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Elternabend vorbereiten/ }),
    );

    expect(
      await screen.findByText(
        "Dieser Eintrag wurde auf einem anderen Gerät geändert. Die neueste Version wurde geladen und dein Entwurf beibehalten.",
      ),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(mockedApi.getProjects).toHaveBeenCalledTimes(2);
      expect(mockedApi.searchTasks).toHaveBeenCalledTimes(2);
      expect(mockedApi.getAgenda).toHaveBeenCalledTimes(2);
    });
  });
});
