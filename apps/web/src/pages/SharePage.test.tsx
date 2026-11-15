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

async function openMoreActions() {
  const summary = await screen.findByText("Weitere Aktionen");
  if (!summary.closest("details")?.open) await userEvent.click(summary);
}

async function openMaterialSearch() {
  if (!screen.queryByLabelText("Aufgaben und Projekte durchsuchen")) {
    await userEvent.click(screen.getByRole("button", { name: "Ziel suchen …" }));
  }
  return screen.findByLabelText("Aufgaben und Projekte durchsuchen");
}

async function openNoteSearch() {
  await openMoreActions();
  if (!screen.queryByLabelText("Notizziele durchsuchen")) {
    await userEvent.click(screen.getByRole("button", { name: "Notizziel suchen …" }));
  }
  return screen.findByLabelText("Notizziele durchsuchen");
}

async function setAnnotation(value: string) {
  await userEvent.click(
    await screen.findByRole("button", { name: /Anmerkung hinzufügen|Anmerkung bearbeiten/ }),
  );
  await userEvent.type(screen.getByLabelText("Notiz"), value);
  await userEvent.click(screen.getByRole("button", { name: "Speichern" }));
}

async function editShareContent(title: string, source: string) {
  await userEvent.click(screen.getByRole("button", { name: "Inhalt bearbeiten" }));
  await userEvent.clear(screen.getByLabelText("Titel"));
  await userEvent.type(screen.getByLabelText("Titel"), title);
  await userEvent.clear(screen.getByLabelText("Quelle"));
  await userEvent.type(screen.getByLabelText("Quelle"), source);
  await userEvent.click(screen.getByRole("button", { name: "Speichern" }));
}

function CurrentPath() {
  const { pathname } = useLocation();
  return <output data-testid="current-path">{pathname}</output>;
}

async function appendToSelectedTarget() {
  await userEvent.click(screen.getByRole("button", { name: /An Notizen/ }));
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

    await openMoreActions();
    await userEvent.click(screen.getByRole("button", { name: "Als Aufgabe erfassen" }));

    expect(screen.getByLabelText("Nur Titel reicht")).toHaveValue("Farmladen");
    expect(markdownValue(screen.getByLabelText("Notizen"))).toBe("https://maps.example/farm");
    expect(window.location.search).toBe("");
  });

  it("refreshes untouched capture fields from saved share edits when reopened", async () => {
    window.history.replaceState(
      null,
      "",
      "/?title=Original&text=Ursprüngliche%20Quelle#/share",
    );
    renderPage();

    await openMoreActions();
    await userEvent.click(screen.getByRole("button", { name: "Als Aufgabe erfassen" }));
    await userEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    await editShareContent("Aktueller Titel", "Aktuelle Quelle");
    await openMoreActions();
    await userEvent.click(screen.getByRole("button", { name: "Als Aufgabe erfassen" }));

    expect(screen.getByLabelText("Nur Titel reicht")).toHaveValue("Aktueller Titel");
    expect(markdownValue(screen.getByLabelText("Notizen"))).toBe("Aktuelle Quelle");
  });

  it("preserves task-specific capture edits while saved share edits refresh untouched fields", async () => {
    window.history.replaceState(
      null,
      "",
      "/?title=Original&text=Ursprüngliche%20Quelle#/share",
    );
    renderPage();

    await openMoreActions();
    await userEvent.click(screen.getByRole("button", { name: "Als Aufgabe erfassen" }));
    await userEvent.clear(screen.getByLabelText("Nur Titel reicht"));
    await userEvent.type(screen.getByLabelText("Nur Titel reicht"), "Aufgabentitel");
    await userEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    await editShareContent("Aktueller Titel", "Aktuelle Quelle");
    await openMoreActions();
    await userEvent.click(screen.getByRole("button", { name: "Als Aufgabe erfassen" }));

    expect(screen.getByLabelText("Nur Titel reicht")).toHaveValue("Aufgabentitel");
    expect(markdownValue(screen.getByLabelText("Notizen"))).toBe("Aktuelle Quelle");
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
    await setAnnotation(note);
    await openMoreActions();
    await userEvent.click(screen.getByRole("button", { name: "Mit KI verarbeiten" }));
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

    await userEvent.type(await openNoteSearch(), "Urlaub");
    await userEvent.click(screen.getByRole("button", { name: /Urlaub planen/ }));
    expect(screen.queryByLabelText("Notizziele durchsuchen")).not.toBeInTheDocument();
    expect(mockedApi.appendTaskNotes).not.toHaveBeenCalled();
    await appendToSelectedTarget();

    await waitFor(() =>
      expect(mockedApi.appendTaskNotes).toHaveBeenCalledWith(
        8,
        "Gasthaus Gutenberg\n\nhttps://maps.example/g",
      ),
    );
    expect(await screen.findByText("Zu „Urlaub planen“ hinzugefügt")).toBeInTheDocument();
    expect(
      JSON.parse(window.localStorage.getItem("machbar:recent-share-note-targets") ?? "[]"),
    ).toEqual([{ kind: "task", id: 8 }]);
    expect(window.localStorage.getItem("machbar:recent-share-targets")).toBeNull();
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

    await userEvent.type(await openNoteSearch(), "Sommerreise");
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

    await editShareContent("Bearbeiteter Titel", "https://edited.example/source");
    await userEvent.click(screen.getByRole("button", { name: "Inhalt bearbeiten" }));
    await userEvent.clear(screen.getByLabelText("Titel"));
    await userEvent.type(screen.getByLabelText("Titel"), "Verwerfen");
    await userEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(screen.getByRole("heading", { name: "Bearbeiteter Titel" })).toBeInTheDocument();
    await openMoreActions();
    await userEvent.click(screen.getByText("Weitere Aktionen"));
    expect(screen.getByRole("heading", { name: "Bearbeiteter Titel" })).toBeInTheDocument();
    await setAnnotation("Für später prüfen");

    expect(
      screen.getByText(
        (_, element) => element?.classList.contains("share-current-destination") ?? false,
      ),
    ).toHaveTextContent("Aktuelles Ziel: Ohne Projekt");
    expect(mockedApi.createTask).not.toHaveBeenCalled();
    await openMoreActions();
    expect(screen.getByRole("button", { name: "An Notizen anhängen" })).toBeDisabled();
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

  it("shows recent material destinations and creates a Reference under the selected Project", async () => {
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
    expect(screen.queryByRole("heading", { name: "Heute" })).not.toBeInTheDocument();
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

  it("fills recent material slots from eligible destinations after stale entries", async () => {
    const projects = [
      makeProject({ id: 4, title: "Ziel vier" }),
      makeProject({ id: 5, title: "Ziel fünf" }),
    ];
    mockedApi.getProjects.mockResolvedValue(projects);
    mockedApi.searchTasks.mockResolvedValue([
      makeTask({ id: 1, title: "Aktion eins", kind: "action" }),
      makeTask({ id: 2, title: "Aktion zwei", kind: "action" }),
      makeTask({ id: 3, title: "Aktion drei", kind: "action" }),
    ]);
    window.localStorage.setItem(
      "machbar:recent-share-targets",
      JSON.stringify([
        { kind: "task", id: 1 },
        { kind: "task", id: 2 },
        { kind: "task", id: 3 },
        { kind: "project", id: 4 },
        { kind: "project", id: 5 },
      ]),
    );
    window.history.replaceState(null, "", "/?title=Material#/share");
    renderPage();

    expect(await screen.findByRole("button", { name: /Ziel vier/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Ziel fünf/ })).toBeInTheDocument();
  });

  it("shows project ancestors reached through a task parent", async () => {
    const outer = makeProject({ id: 4, title: "Außen" });
    const subproject = makeProject({ id: 5, title: "Teilprojekt", parentId: 11 });
    const container = makeTask({
      id: 11,
      kind: "reference",
      title: "Behälter",
      projectId: 4,
    });
    mockedApi.getProjects.mockResolvedValue([outer, subproject]);
    mockedApi.searchTasks.mockResolvedValue([container]);
    window.localStorage.setItem(
      "machbar:recent-share-targets",
      JSON.stringify([{ kind: "project", id: 5 }]),
    );
    window.history.replaceState(null, "", "/?title=Material#/share");
    renderPage();

    const recent = await screen.findByRole("button", { name: /Teilprojekt/ });
    expect(recent).toHaveTextContent("Außen › Behälter › Teilprojekt");
  });

  it("closes material destination search after choosing a result", async () => {
    mockedApi.getProjects.mockResolvedValue([
      makeProject({ id: 4, title: "Geburtstag" }),
    ]);
    window.history.replaceState(null, "", "/?title=Kuchenidee#/share");
    renderPage();

    await userEvent.type(await openMaterialSearch(), "Geburtstag");
    await userEvent.click(await screen.findByRole("button", { name: /Geburtstag/ }));

    expect(screen.queryByLabelText("Aufgaben und Projekte durchsuchen")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Als Material speichern" }),
    ).toBeVisible();
    expect(
      screen.getByText(
        (_, element) => element?.classList.contains("share-current-destination") ?? false,
      ),
    ).toHaveTextContent("Geburtstag");
  });

  it("files into the exact recent nested Reference in two taps", async () => {
    const project = makeProject({ id: 4, title: "Sommerurlaub" });
    const parent = makeTask({
      id: 11,
      kind: "reference",
      title: "Unterkunft",
      projectId: 4,
      projectTitle: "Sommerurlaub",
    });

    const destination = makeTask({
      id: 12,
      kind: "reference",
      title: "Unterkunft B",
      projectId: 4,
      parentTaskId: 11,
      projectTitle: "Sommerurlaub",
    });
    mockedApi.getProjects.mockResolvedValue([project]);
    mockedApi.searchTasks.mockResolvedValue([parent, destination]);
    mockedApi.createTask.mockResolvedValue(
      makeTask({ id: 93, kind: "reference", title: "Buchungsbestätigung" }),
    );
    window.localStorage.setItem(
      "machbar:recent-share-targets",
      JSON.stringify([{ kind: "task", id: 12 }]),
    );
    window.history.replaceState(null, "", "/?title=Bestätigung&url=https%3A%2F%2Fexample.test#/share");
    renderPage();

    const recent = await screen.findByRole("button", { name: /Unterkunft B/ });
    expect(recent).toHaveTextContent("Sommerurlaub › Unterkunft › Unterkunft B");
    await userEvent.click(recent);
    expect(
      screen.getByText(
        (_, element) => element?.classList.contains("share-current-destination") ?? false,
      ),
    ).toHaveTextContent("Sommerurlaub › Unterkunft › Unterkunft B");
    await userEvent.click(screen.getByRole("button", { name: "Als Material speichern" }));

    await waitFor(() =>
      expect(mockedApi.createTask).toHaveBeenCalledWith(
        {
          kind: "reference",
          title: "Bestätigung",
          notes: "https://example.test",
          projectId: 4,
          parentTaskId: 12,
        },
        expect.any(Object),
      ),
    );
    expect(JSON.parse(window.localStorage.getItem("machbar:recent-share-targets") ?? "[]")).toEqual([
      { kind: "task", id: 12 },
    ]);
  });

  it("keeps the first screen compact with a long title and three recent targets", async () => {
    const projects = [
      makeProject({ id: 1, title: "Ziel Eins" }),
      makeProject({ id: 2, title: "Ziel Zwei" }),
      makeProject({ id: 3, title: "Ziel Drei" }),
    ];
    const longTitle =
      "Eine ungewöhnlich lange Überschrift für einen geteilten Reiseartikel";
    mockedApi.getProjects.mockResolvedValue(projects);
    window.localStorage.setItem(
      "machbar:recent-share-targets",
      JSON.stringify([
        { kind: "project", id: 1 },
        { kind: "project", id: 2 },
        { kind: "project", id: 3 },
      ]),
    );
    window.history.replaceState(
      null,
      "",
      `/?title=${encodeURIComponent(longTitle)}&url=https%3A%2F%2Fexample.test%2Farticle#/share`,
    );
    renderPage();

    expect(await screen.findByRole("heading", { name: longTitle })).toBeInTheDocument();
    expect(screen.getByText("example.test")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Ziel Eins/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Ziel Zwei/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Ziel Drei/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Als Material speichern" })).toBeEnabled();
    expect(screen.queryByLabelText("Titel")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Aufgaben und Projekte durchsuchen")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Notiz")).not.toBeInTheDocument();
  });

  it("never turns a stale selected material destination into a standalone save", async () => {
    const destination = makeTask({
      id: 17,
      kind: "reference",
      title: "Reiseplan",
      projectId: 4,
      projectTitle: "Sommerurlaub",
    });
    mockedApi.searchTasks
      .mockResolvedValueOnce([destination])
      .mockResolvedValueOnce([]);
    mockedApi.createTask
      .mockRejectedValueOnce(
        Object.assign(new Error("stale"), {
          name: "ApiError",
          code: "stale_write_conflict",
        }),
      )
      .mockResolvedValueOnce(makeTask({ id: 94, kind: "reference", title: "Link" }));
    window.localStorage.setItem(
      "machbar:recent-share-targets",
      JSON.stringify([{ kind: "task", id: 17 }]),
    );
    window.history.replaceState(null, "", "/?title=Link&url=https%3A%2F%2Fexample.test#/share");
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: /Reiseplan/ }));
    await userEvent.click(screen.getByRole("button", { name: "Als Material speichern" }));
    await waitFor(() => expect(mockedApi.searchTasks).toHaveBeenCalledTimes(2));
    expect(
      screen.getByText(
        (_, element) => element?.classList.contains("share-current-destination") ?? false,
      ),
    ).toHaveTextContent("Dieses Ziel ist nicht mehr verfügbar");
    expect(screen.getByRole("button", { name: "Als Material speichern" })).toBeDisabled();
    expect(mockedApi.createTask).toHaveBeenCalledOnce();

    await userEvent.click(screen.getByRole("button", { name: "Ohne Projekt" }));
    await userEvent.click(screen.getByRole("button", { name: "Als Material speichern" }));
    await waitFor(() =>
      expect(mockedApi.createTask).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: null, parentTaskId: null }),
        expect.any(Object),
      ),
    );
  });

  it("keeps action tasks eligible for note append but excludes them from material filing", async () => {
    const action = makeTask({
      id: 18,
      title: "Flug buchen",
      projectId: 4,
      projectTitle: "Sommerurlaub",
    });
    mockedApi.searchTasks.mockResolvedValue([action]);
    mockedApi.appendTaskNotes.mockResolvedValue(action);
    window.history.replaceState(null, "", "/?text=Preisvergleich#/share");
    renderPage();

    await userEvent.click(screen.getByRole("button", { name: "Ziel suchen …" }));
    await userEvent.type(
      await screen.findByLabelText("Aufgaben und Projekte durchsuchen"),
      "Flug buchen",
    );
    expect(screen.queryByRole("button", { name: /Flug buchen/ })).not.toBeInTheDocument();
    expect(screen.getByText("Kein Ziel passt zu dieser Suche.")).toBeInTheDocument();

    await userEvent.type(await openNoteSearch(), "Flug buchen");
    await userEvent.click(screen.getByRole("button", { name: /Flug buchen/ }));
    await userEvent.click(screen.getByRole("button", { name: /An Notizen bei/ }));
    await waitFor(() =>
      expect(mockedApi.appendTaskNotes).toHaveBeenCalledWith(18, "Preisvergleich"),
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
      "/?title=Elternabend&text=15.%20Sept.%202026%20%E2%80%A2%2019%3A00%E2%80%9321%3A00%20%E2%80%A2%20Details%20ansehen%0Ahttps%3A%2F%2Fcalendar.app.google%2Fabc123#/share",
    );
    renderPage();

    expect(await screen.findByText("Fällig: 15.09.2026")).toBeInTheDocument();
    await userEvent.type(await openNoteSearch(), "Elternabend vorbereiten");
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

    await userEvent.type(await openMaterialSearch(), "Geburtstag");
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

    await userEvent.type(await openNoteSearch(), "Geschenk");
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

    await openMoreActions();
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

    await userEvent.type(await openNoteSearch(), "Elternabend");
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
    await userEvent.type(await openNoteSearch(), "Belege");
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

    await openMoreActions();
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

    await setAnnotation("Für die Steuer");
    await openMoreActions();
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

    await userEvent.type(await openNoteSearch(), "Belege");
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
