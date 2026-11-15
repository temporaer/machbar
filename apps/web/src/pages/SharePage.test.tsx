import { markdownValue } from "../test/markdownEditor";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SharePage } from "./SharePage";
import { api } from "../lib/api";
import { RefreshProvider } from "../lib/refresh";
import { makeProject, makeTask } from "../test/fixtures";
import {
  deletePendingShareTarget,
  readPendingShareTarget,
} from "../lib/pendingShareTarget";

vi.mock("../lib/api", () => ({
  api: {
    previewTaskCreation: vi.fn().mockResolvedValue({ decision: null, activatingProjects: [] }),
    getProjects: vi.fn(),
    getTags: vi.fn(),
    getHomeAssistantStatus: vi.fn(),
    searchTasks: vi.fn(),
    getAgenda: vi.fn(),
    appendTaskNotes: vi.fn(),
    appendProjectNotes: vi.fn(),
    updateTask: vi.fn(),
    updateProject: vi.fn(),
    createTask: vi.fn(),
    createProject: vi.fn(),
    uploadPaperlessDocument: vi.fn(),
    createIntake: vi.fn(),
  },
  paperlessDocumentThumbnailUrl: (id: number) =>
    `/api/integrations/paperless/documents/${id}/thumbnail`,
}));

vi.mock("../lib/pendingShareTarget", () => ({
  readPendingShareTarget: vi.fn(),
  deletePendingShareTarget: vi.fn(),
}));

vi.mock("../lib/identity", () => ({
  useIdentity: () => ({ currentMemberId: 1, members: [{ id: 1, name: "Mira" }] }),
}));

const mockedApi = vi.mocked(api, true);
const mockedReadPendingShareTarget = vi.mocked(readPendingShareTarget);
const mockedDeletePendingShareTarget = vi.mocked(deletePendingShareTarget);

function createLocalStorageMock() {
  let store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store = new Map<string, string>();
    },
  };
}

const localStorageMock = createLocalStorageMock();

const emptyAgenda = {
  projects: [],
  planned: [],
  overdue: [],
  dueToday: [],
  dueSoon: [],
  shared: [],
  unscheduled: [],
  revisit: [],
  completedToday: [],
  interventions: { running: [], review: [] },
};

function renderPage() {
  return render(
    <MemoryRouter>
      <RefreshProvider>
        <SharePage />
        <CurrentPath />
      </RefreshProvider>
    </MemoryRouter>,
  );
}

function CurrentPath() {
  const { pathname } = useLocation();
  return <output data-testid="current-path">{pathname}</output>;
}

async function appendToSelectedTarget() {
  await userEvent.click(screen.getByRole("button", { name: "An Notiz anhängen" }));
}

describe("SharePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, "localStorage", {
      value: localStorageMock,
      configurable: true,
    });
    window.localStorage.clear();
    mockedApi.getProjects.mockResolvedValue([]);
    mockedApi.getTags.mockResolvedValue([]);
    mockedApi.getHomeAssistantStatus.mockResolvedValue({
      connected: false,
      instanceId: null,
      protocolVersion: null,
      connectedAt: null,
      lastUpdateAt: null,
      stale: false,
      supportedProtocolVersion: 3,
      protocolOutdated: false,
      lastRequestPollAt: null,
      workerOnline: false,
      intake: null,
      intakeReady: false,
      people: [],
      contexts: [],
    });
    mockedApi.searchTasks.mockResolvedValue([]);
    mockedApi.getAgenda.mockResolvedValue(emptyAgenda);
    mockedDeletePendingShareTarget.mockResolvedValue();
    window.history.replaceState(null, "", "/");
  });

  it("prefills the reused Capture editor from a shared page", async () => {
    window.history.replaceState(
      null,
      "",
      "/?title=Farmladen&url=https%3A%2F%2Fmaps.example%2Ffarm#/share",
    );
    renderPage();

    await userEvent.click(screen.getByRole("button", { name: "Als Aufgabe erfassen" }));

    expect(screen.getByLabelText("Nur Titel reicht")).toHaveValue("Farmladen");
    expect(markdownValue(screen.getByLabelText("Notizen"))).toBe("https://maps.example/farm");
    expect(window.location.search).toBe("");
  });

  it.each([
    ["  Für später  ", "Geteilte Nachricht\n\nhttps://example.com/story\n\nFür später"],
    ["   ", "Geteilte Nachricht\n\nhttps://example.com/story"],
  ])("passes shared text/link and optional note to Verarbeiten (%s)", async (note, expectedText) => {
    mockedApi.createIntake.mockResolvedValue({ id: "intake-1" });
    window.history.replaceState(
      null,
      "",
      "/?text=Geteilte%20Nachricht&url=https%3A%2F%2Fexample.com%2Fstory#/share",
    );
    renderPage();
    await userEvent.type(screen.getByLabelText("Notiz"), note);
    await userEvent.click(screen.getByRole("button", { name: "Verarbeiten" }));
    await waitFor(() => expect(mockedApi.createIntake).toHaveBeenCalledWith({
      text: expectedText,
      files: [],
    }));
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

  it("shows a recoverable message when the service worker could not stage files", () => {
    window.history.replaceState(
      null,
      "",
      "/?shareError=storage#/share",
    );
    renderPage();

    expect(
      screen.getByText(
        "Der geteilte Inhalt konnte auf diesem Gerät nicht zwischengespeichert werden.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Zu Machbar" })).toBeInTheDocument();
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
    expect(mockedApi.appendTaskNotes).not.toHaveBeenCalled();
    await appendToSelectedTarget();

    await waitFor(() =>
      expect(mockedApi.appendTaskNotes).toHaveBeenCalledWith(
        8,
        "Gasthaus Gutenberg\n\nhttps://maps.example/g",
      ),
    );
    expect(await screen.findByText("Zu „Urlaub planen“ hinzugefügt")).toBeInTheDocument();
  });

  it("appends to Project notes only after the explicit action", async () => {
    const project = makeProject({ id: 14, title: "Sommerreise" });
    mockedApi.getProjects.mockResolvedValue([project]);
    mockedApi.appendProjectNotes.mockResolvedValue(project as never);
    window.history.replaceState(
      null,
      "",
      "/?text=Hotel%20pr%C3%BCfen&url=https%3A%2F%2Fhotel.example#/share",
    );
    renderPage();

    await userEvent.type(
      await screen.findByLabelText("Aufgaben und Projekte durchsuchen"),
      "Sommerreise",
    );
    await userEvent.click(screen.getByRole("button", { name: /Sommerreise/ }));
    expect(mockedApi.appendProjectNotes).not.toHaveBeenCalled();
    await appendToSelectedTarget();

    await waitFor(() =>
      expect(mockedApi.appendProjectNotes).toHaveBeenCalledWith(
        14,
        "Hotel prüfen\n\nhttps://hotel.example",
      ),
    );
    expect(mockedApi.createTask).not.toHaveBeenCalled();
  });

  it("saves editable shared content without a project and opens the new material", async () => {
    mockedApi.createTask.mockResolvedValue(
      makeTask({ id: 92, kind: "reference", title: "Bearbeiteter Titel" }),
    );
    window.history.replaceState(
      null,
      "",
      "/?title=Original&text=Zitierter%20Text&url=https%3A%2F%2Fexample.test#/share",
    );
    renderPage();

    const title = screen.getByLabelText("Titel");
    const source = screen.getByLabelText("Quelle");
    const annotation = screen.getByLabelText("Notiz");
    await userEvent.clear(title);
    await userEvent.type(title, "Bearbeiteter Titel");
    await userEvent.clear(source);
    await userEvent.type(source, "https://edited.example/source");
    await userEvent.type(annotation, "Für später prüfen");

    expect(screen.getByText("Das Material wird ohne Projekt gespeichert.")).toBeInTheDocument();
    expect(mockedApi.createTask).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "An Notiz anhängen" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Als Material speichern" }));

    await waitFor(() =>
      expect(mockedApi.createTask).toHaveBeenCalledWith(
        {
          kind: "reference",
          title: "Bearbeiteter Titel",
          notes: "https://edited.example/source\n\nFür später prüfen",
          projectId: null,
          parentTaskId: null,
        },
        expect.any(Object),
      ),
    );
    expect(await screen.findByRole("button", { name: "Ansehen" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Ansehen" }));
    expect(screen.getByTestId("current-path")).toHaveTextContent("/tasks/92");
  });

  it("shows a recent project before Today targets and creates a Reference under it", async () => {
    const project = makeProject({ id: 4, title: "Geburtstag" });
    mockedApi.getProjects.mockResolvedValue([project as never]);
    mockedApi.createTask.mockResolvedValue(
      makeTask({ id: 90, kind: "reference", title: "Kuchenidee", projectId: 4 }),
    );
    window.localStorage.setItem(
      "machbar:recent-share-targets",
      JSON.stringify([{ kind: "project", id: 4 }]),
    );
    window.history.replaceState(null, "", "/?text=Kuchenidee#/share");
    renderPage();

    expect(await screen.findByRole("heading", { name: "Zuletzt verwendet" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Geburtstag/ }));
    await userEvent.click(screen.getByRole("button", { name: "Als Material speichern" }));
    await waitFor(() =>
      expect(mockedApi.createTask).toHaveBeenCalledWith({
        kind: "reference",
        title: "Kuchenidee",
        notes: "",
        projectId: 4,
        parentTaskId: null,
      }, expect.any(Object)),
    );
    expect(mockedApi.appendProjectNotes).not.toHaveBeenCalled();
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
      "/?title=Elternabend&text=15.%20Sept.%202026%20%E2%80%A2%2019%3A00%E2%80%9321%3A00%20%E2%80%A2%20Details%20ansehen%0Ahttps%3A%2F%2Fcalendar.app.google%2Fabc123#/share",
    );
    renderPage();

    expect(await screen.findByText("Fällig: 15.09.2026")).toBeInTheDocument();
    await userEvent.type(
      await screen.findByLabelText("Aufgaben und Projekte durchsuchen"),
      "Elternabend vorbereiten",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Elternabend vorbereiten/ }),
    );
    await appendToSelectedTarget();

    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(8, {
        notes:
          "Bestehende Notiz\n\nElternabend\n\n15. Sept. 2026 • 19:00–21:00 • Details ansehen\nhttps://calendar.app.google/abc123",
        dueDate: "2026-09-15",
        expectedRevision: 3,
      }),
    );
    expect(mockedApi.appendTaskNotes).not.toHaveBeenCalled();
  });

  it("saves material in a Project and never applies a Calendar deadline", async () => {
    const project = makeProject({
      id: 4,
      title: "Geburtstag",
      dueDate: "2026-09-21",
    });
    mockedApi.getProjects.mockResolvedValue([project]);
    mockedApi.createTask.mockResolvedValue(
      makeTask({ id: 90, kind: "reference", title: "Pauls Geburtstag", projectId: 4 }),
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
    await userEvent.click(screen.getByRole("button", { name: "Als Material speichern" }));

    await waitFor(() =>
      expect(mockedApi.createTask).toHaveBeenCalledWith({
        kind: "reference",
        title: "Pauls Geburtstag",
        notes: "21. September 2026 • 15:00\nhttps://calendar.app.google/birthday",
        projectId: 4,
        parentTaskId: null,
      }, expect.any(Object)),
    );
    expect(mockedApi.updateProject).not.toHaveBeenCalled();
    expect(mockedApi.appendProjectNotes).not.toHaveBeenCalled();
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
    await appendToSelectedTarget();

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

  it("prefills the existing Capture form with the parsed Calendar deadline", async () => {
    window.history.replaceState(
      null,
      "",
      "/?title=Elternabend&text=15.%20September%202026%20%E2%80%A2%2019%3A00%0Ahttps%3A%2F%2Fcalendar.app.google%2Fabc123#/share",
    );
    renderPage();

    await userEvent.click(
      await screen.findByRole("button", { name: "Als Aufgabe erfassen" }),
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
    await appendToSelectedTarget();

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

  it("loads a mixed multi-file POST share and appends all references to an existing task", async () => {
    const task = makeTask({ id: 8, title: "Belege" });
    const files = [
      new File(["image"], "receipt.jpg", { type: "image/jpeg" }),
      new File(["pdf"], "manual.pdf", { type: "application/pdf" }),
    ];
    mockedReadPendingShareTarget.mockResolvedValue({
      title: "Unterlagen",
      text: "Bitte ablegen",
      url: "",
      files,
    });
    mockedApi.searchTasks.mockResolvedValue([task]);
    mockedApi.uploadPaperlessDocument
      .mockResolvedValueOnce({
        id: 41,
        title: "receipt",
        originalFileName: "receipt.jpg",
        mimeType: "image/jpeg",
      })
      .mockResolvedValueOnce({
        id: 42,
        title: "manual",
        originalFileName: "manual.pdf",
        mimeType: "application/pdf",
      });
    mockedApi.appendTaskNotes.mockResolvedValue(task);
    window.history.replaceState(null, "", "/?shareId=pending-1#/share");
    renderPage();

    expect(await screen.findByText("2 geteilte Anhänge")).toBeInTheDocument();
    await userEvent.type(
      await screen.findByLabelText("Aufgaben und Projekte durchsuchen"),
      "Belege",
    );
    await userEvent.click(screen.getByRole("button", { name: /Belege/ }));
    await appendToSelectedTarget();

    await waitFor(() =>
      expect(mockedApi.appendTaskNotes).toHaveBeenCalledWith(
        8,
        "Unterlagen\n\nBitte ablegen\n\n![receipt.jpg](paperless:41)\n\n[manual.pdf](paperless:42)",
      ),
    );
    expect(mockedDeletePendingShareTarget).toHaveBeenCalledWith("pending-1");
    expect(window.location.search).toBe("");
  });

  it("uploads pending files before the reused CaptureForm creates a task", async () => {
    const file = new File(["pdf"], "receipt.pdf", {
      type: "application/pdf",
    });
    mockedReadPendingShareTarget.mockResolvedValue({
      title: "Beleg",
      text: "",
      url: "",
      files: [file],
    });
    mockedApi.uploadPaperlessDocument.mockResolvedValue({
      id: 51,
      title: "receipt",
      originalFileName: "receipt.pdf",
      mimeType: "application/pdf",
    });
    const createdTask = makeTask({ id: 51, title: "Beleg" });
    mockedApi.createTask.mockResolvedValue(createdTask);
    window.history.replaceState(null, "", "/?shareId=pending-2#/share");
    renderPage();

    await userEvent.click(
      await screen.findByRole("button", { name: "Als Aufgabe erfassen" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Erstellen" }));

    await waitFor(() =>
      expect(mockedApi.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Beleg",
          notes: "[receipt.pdf](paperless:51)",
        }), expect.any(Object),
      ),
    );
    expect(mockedDeletePendingShareTarget).toHaveBeenCalledWith("pending-2");
  });

  it("preserves the optional share note when creating a new task", async () => {
    const file = new File(["pdf"], "receipt.pdf", {
      type: "application/pdf",
    });
    mockedReadPendingShareTarget.mockResolvedValue({
      title: "Beleg",
      text: "Bitte ablegen",
      url: "",
      files: [file],
    });
    mockedApi.uploadPaperlessDocument.mockResolvedValue({
      id: 52,
      title: "receipt",
      originalFileName: "receipt.pdf",
      mimeType: "application/pdf",
    });
    const createdTask = makeTask({ id: 52, title: "Beleg" });
    mockedApi.createTask.mockResolvedValue(createdTask);
    window.history.replaceState(null, "", "/?shareId=pending-4#/share");
    renderPage();

    await screen.findByLabelText("Titel");
    await userEvent.type(screen.getByLabelText("Notiz"), "Für die Steuer");
    await userEvent.click(screen.getByRole("button", { name: "Als Aufgabe erfassen" }));
    await userEvent.click(screen.getByRole("button", { name: "Erstellen" }));

    await waitFor(() =>
      expect(mockedApi.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Beleg",
          notes:
            "Bitte ablegen\n\n[receipt.pdf](paperless:52)\n\nFür die Steuer",
        }), expect.any(Object),
      ),
    );
  });

  it("reuses successful uploads when appending is retried", async () => {
    const task = makeTask({ id: 8, title: "Belege" });
    const file = new File(["pdf"], "receipt.pdf", {
      type: "application/pdf",
    });
    mockedReadPendingShareTarget.mockResolvedValue({
      title: "",
      text: "",
      url: "",
      files: [file],
    });
    mockedApi.searchTasks.mockResolvedValue([task]);
    mockedApi.uploadPaperlessDocument.mockResolvedValue({
      id: 61,
      title: "receipt",
      originalFileName: "receipt.pdf",
      mimeType: "application/pdf",
    });
    mockedApi.appendTaskNotes
      .mockRejectedValueOnce(new Error("Temporary append failure"))
      .mockResolvedValueOnce(task);
    window.history.replaceState(null, "", "/?shareId=pending-3#/share");
    renderPage();

    await userEvent.type(
      await screen.findByLabelText("Aufgaben und Projekte durchsuchen"),
      "Belege",
    );
    const destination = screen.getByRole("button", { name: /Belege/ });
    await userEvent.click(destination);
    await appendToSelectedTarget();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Temporary append failure",
    );
    await appendToSelectedTarget();

    await waitFor(() =>
      expect(mockedApi.appendTaskNotes).toHaveBeenCalledTimes(2),
    );
    expect(mockedApi.uploadPaperlessDocument).toHaveBeenCalledTimes(1);
  });
});
