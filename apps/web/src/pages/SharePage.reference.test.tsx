import { markdownValue } from "../test/markdownEditor";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SharePage } from "./SharePage";
import { api } from "../lib/api";
import { RefreshProvider } from "../lib/refresh";
import { makeProject, makeTask } from "../test/fixtures";
import {
  deletePendingShareTarget,
  readPendingShareTarget,
} from "../lib/pendingShareTarget";

// This file mirrors SharePage.test.tsx but avoids calling
// `window.localStorage.clear()` directly in `beforeEach`, which triggers a
// pre-existing, unrelated jsdom/Node 22 interaction bug in this repo's test
// environment (confirmed identical on a clean checkout). Reference-specific
// Share invariants are covered here instead so they can actually execute.

vi.mock("../lib/api", () => ({
  api: {
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
const mockedDeletePendingShareTarget = vi.mocked(deletePendingShareTarget);
const mockedReadPendingShareTarget = vi.mocked(readPendingShareTarget);

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

describe("SharePage reference destinations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("creates a Reference as a direct child of a Project destination", async () => {
    const project = makeProject({ id: 4, title: "Schweiz Urlaub" });
    mockedApi.getProjects.mockResolvedValue([project]);
    mockedApi.createTask.mockResolvedValue(
      makeTask({ id: 90, kind: "reference", title: "Camping Wang", projectId: 4 }),
    );
    window.history.replaceState(
      null,
      "",
      "/?title=Camping%20Wang&url=https%3A%2F%2Fcamping-wang.ch%2F#/share",
    );
    renderPage();

    await userEvent.type(
      await openMaterialSearch(),
      "Schweiz",
    );
    await userEvent.click(
      screen.getAllByRole("button", { name: /Schweiz Urlaub/ }).at(-1)!,
    );
    await userEvent.click(screen.getByRole("button", { name: "Als Material speichern" }));

    await waitFor(() =>
      expect(mockedApi.createTask).toHaveBeenCalledWith({
        kind: "reference",
        title: "Camping Wang",
        notes: "https://camping-wang.ch/",
        projectId: 4,
        parentTaskId: null,
      }, expect.any(Object)),
    );
    expect(mockedApi.appendProjectNotes).not.toHaveBeenCalled();
    expect(mockedApi.updateProject).not.toHaveBeenCalled();
  });

  it.each([
    ["URL-only share", "url=https%3A%2F%2Fexample.test%2Farticle"],
    ["bare URL text", "text=https%3A%2F%2Fexample.test%2Farticle"],
  ])("keeps a %s in task-capture notes", async (_label, payload) => {
    window.history.replaceState(null, "", `/?${payload}#/share`);
    renderPage();

    await openMoreActions();
    await userEvent.click(await screen.findByRole("button", { name: "Als Aufgabe erfassen" }));

    expect(markdownValue(screen.getByLabelText("Notizen"))).toBe(
      "https://example.test/article",
    );
  });

  it("locks share editors and destinations while task capture owns the draft", async () => {
    const project = makeProject({ id: 4, title: "Urlaub" });
    mockedApi.getProjects.mockResolvedValue([project]);
    let finishCreate!: (task: ReturnType<typeof makeTask>) => void;
    mockedApi.createTask.mockImplementation(
      () => new Promise((resolve) => {
        finishCreate = resolve as (task: ReturnType<typeof makeTask>) => void;
      }),
    );
    window.history.replaceState(
      null,
      "",
      "/?title=Camping&url=https%3A%2F%2Fexample.test#/share",
    );
    renderPage();

    await userEvent.type(await openMaterialSearch(), "Urlaub");
    await userEvent.click(screen.getAllByRole("button", { name: /Urlaub/ }).at(-1)!);
    await openMoreActions();
    await userEvent.click(screen.getByRole("button", { name: "Als Aufgabe erfassen" }));

    expect(screen.getByRole("button", { name: "Inhalt bearbeiten" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Anmerkung hinzufügen" })).toBeDisabled();
    expect(screen.getByLabelText("Aufgaben und Projekte durchsuchen")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Ohne Projekt" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Als Material speichern" })).toBeDisabled();
    expect(
      screen.getAllByRole("button", { name: /Urlaub/ }).every((button) =>
        button.hasAttribute("disabled"),
      ),
    ).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Erstellen" }));
    await waitFor(() => expect(mockedApi.createTask).toHaveBeenCalledOnce());
    await waitFor(() => expect(mockedApi.createTask).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "Inhalt bearbeiten" })).toBeDisabled();
    expect(screen.getByLabelText("Aufgaben und Projekte durchsuchen")).toBeDisabled();

    finishCreate(makeTask());
  });

  it.each([
    ["sentence prefix", "Article discusses household planning.", "Article\n\nArticle discusses household planning."],
    ["standalone title line", "Article\n\nMore details follow.", "Article\n\nMore details follow."],
  ])("preserves source prose when the title is a %s", async (_label, text, expected) => {
    mockedApi.createIntake.mockResolvedValue({ id: "intake-1" });
    window.history.replaceState(
      null,
      "",
      `/?title=Article&text=${encodeURIComponent(text)}#/share`,
    );
    renderPage();

    await openMoreActions();
    await userEvent.click(await screen.findByRole("button", { name: "Mit KI verarbeiten" }));

    await waitFor(() =>
      expect(mockedApi.createIntake).toHaveBeenCalledWith({
        text: expected,
        files: [],
      }),
    );
  });

  it("keeps a title-prefixed sentence intact when appending it to a task", async () => {
    const task = makeTask({ id: 8, title: "Zu lesen", notes: "" });
    mockedApi.searchTasks.mockResolvedValue([task]);
    mockedApi.appendTaskNotes.mockResolvedValue(task);
    window.history.replaceState(
      null,
      "",
      `/?title=Article&text=${encodeURIComponent("Article discusses household planning.")}#/share`,
    );
    renderPage();

    await userEvent.type(await openNoteSearch(), "Zu lesen");
    await userEvent.click(screen.getByRole("button", { name: /Zu lesen/ }));
    await userEvent.click(screen.getByRole("button", { name: /An Notizen bei/ }));

    await waitFor(() =>
      expect(mockedApi.appendTaskNotes).toHaveBeenCalledWith(
        8,
        "Article\n\nArticle discusses household planning.",
      ),
    );
  });

  it("creates a Reference as a child of an existing Reference destination", async () => {
    const reference = makeTask({
      id: 12,
      kind: "reference",
      title: "Unterkunft",
      projectId: 4,
      projectTitle: "Schweiz Urlaub",
    });
    mockedApi.searchTasks.mockResolvedValue([reference]);
    mockedApi.createTask.mockResolvedValue(
      makeTask({ id: 91, kind: "reference", title: "Ferienwohnung Beatenberg" }),
    );
    window.history.replaceState(
      null,
      "",
      "/?title=Ferienwohnung%20Beatenberg&url=https%3A%2F%2Fbooking.example%2Ffw#/share",
    );
    renderPage();

    await userEvent.type(await openMaterialSearch(), "Unterkunft");
    expect(screen.getByText("Schweiz Urlaub › Unterkunft")).toBeInTheDocument();
    const matchingDestinations = screen.getAllByRole("button", {
      name: /Unterkunft/,
    });
    await userEvent.click(matchingDestinations.at(-1)!);
    await userEvent.click(screen.getByRole("button", { name: "Als Material speichern" }));

    await waitFor(() =>
      expect(mockedApi.createTask).toHaveBeenCalledWith({
        kind: "reference",
        title: "Ferienwohnung Beatenberg",
        notes: "https://booking.example/fw",
        projectId: 4,
        parentTaskId: 12,
      }, expect.any(Object)),
    );
  });

  it("still appends to notes for an Action destination", async () => {
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
    await userEvent.click(screen.getAllByRole("button", { name: /Urlaub planen/ }).at(-1)!);
    await userEvent.click(screen.getByRole("button", { name: /An Notizen bei/ }));

    await waitFor(() =>
      expect(mockedApi.appendTaskNotes).toHaveBeenCalledWith(
        8,
        "Gasthaus Gutenberg\n\nhttps://maps.example/g",
      ),
    );
    expect(mockedApi.createTask).not.toHaveBeenCalled();
  });

  it("preserves the optional share note for Project, Reference, and Action destinations", async () => {
    const project = makeProject({ id: 4, title: "Schweiz Urlaub" });
    mockedApi.getProjects.mockResolvedValue([project]);
    mockedApi.createTask.mockResolvedValue(
      makeTask({ id: 90, kind: "reference", title: "Camping Wang" }),
    );
    window.history.replaceState(
      null,
      "",
      "/?title=Camping%20Wang&url=https%3A%2F%2Fcamping-wang.ch%2F#/share",
    );
    renderPage();

    await setAnnotation("Direkt am See, scheint gut für die Kinder");
    await userEvent.type(
      await openMaterialSearch(),
      "Schweiz",
    );
    await userEvent.click(
      screen.getAllByRole("button", { name: /Schweiz Urlaub/ }).at(-1)!,
    );
    await userEvent.click(screen.getByRole("button", { name: "Als Material speichern" }));

    await waitFor(() =>
      expect(mockedApi.createTask).toHaveBeenCalledWith({
        kind: "reference",
        title: "Camping Wang",
        notes:
          "https://camping-wang.ch/\n\nDirekt am See, scheint gut für die Kinder",
        projectId: 4,
        parentTaskId: null,
      }, expect.any(Object)),
    );
  });

  it("retains a staged material draft and reuses uploads and creation identity on retry", async () => {
    const file = new File(["receipt"], "receipt.pdf", {
      type: "application/pdf",
    });
    mockedReadPendingShareTarget.mockResolvedValue({
      title: "Beleg",
      text: "Rechnung prüfen",
      url: "",
      files: [file],
    });
    mockedApi.uploadPaperlessDocument.mockResolvedValue({
      id: 93,
      title: "receipt",
      originalFileName: "receipt.pdf",
      mimeType: "application/pdf",
    });
    mockedApi.createTask
      .mockRejectedValueOnce(new Error("Temporary create failure"))
      .mockResolvedValueOnce(
        makeTask({ id: 93, kind: "reference", title: "Beleg" }),
      );
    window.history.replaceState(null, "", "/?shareId=material-retry#/share");
    renderPage();

    await setAnnotation("Für die Steuer");
    await userEvent.click(screen.getByRole("button", { name: "Als Material speichern" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Temporary create failure",
    );
    expect(screen.getByRole("heading", { name: "Beleg" })).toBeInTheDocument();
    expect(screen.getByText("Für die Steuer")).toBeInTheDocument();
    expect(mockedApi.uploadPaperlessDocument).toHaveBeenCalledOnce();
    expect(mockedDeletePendingShareTarget).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Als Material speichern" }));
    await waitFor(() => expect(mockedApi.createTask).toHaveBeenCalledTimes(2));
    const expectedInput = {
      kind: "reference",
      title: "Beleg",
      notes: "Rechnung prüfen\n\n[receipt.pdf](paperless:93)\n\nFür die Steuer",
      projectId: null,
      parentTaskId: null,
    };
    expect(mockedApi.createTask.mock.calls[0]?.[0]).toEqual(expectedInput);
    expect(mockedApi.createTask.mock.calls[1]?.[0]).toEqual(expectedInput);
    expect(mockedApi.createTask.mock.calls[0]?.[1]).toBe(
      mockedApi.createTask.mock.calls[1]?.[1],
    );
    expect(mockedApi.uploadPaperlessDocument).toHaveBeenCalledOnce();
    expect(mockedDeletePendingShareTarget).toHaveBeenCalledWith("material-retry");
  });

  it("does not apply a Calendar deadline when sharing to a Reference destination", async () => {
    const reference = makeTask({
      id: 12,
      kind: "reference",
      title: "Unterkunft",
      projectId: 4,
      projectTitle: "Schweiz Urlaub",
    });
    mockedApi.searchTasks.mockResolvedValue([reference]);
    mockedApi.createTask.mockResolvedValue(
      makeTask({ id: 91, kind: "reference", title: "Konzert" }),
    );
    window.history.replaceState(
      null,
      "",
      "/?title=Konzert&text=21.%20September%202026%20%E2%80%A2%2015%3A00%0Ahttps%3A%2F%2Fcalendar.app.google%2Fbirthday#/share",
    );
    renderPage();

    await userEvent.type(await openMaterialSearch(), "Unterkunft");
    const matchingDestinations = screen.getAllByRole("button", {
      name: /Unterkunft/,
    });
    await userEvent.click(matchingDestinations.at(-1)!);
    await userEvent.click(screen.getByRole("button", { name: "Als Material speichern" }));

    await waitFor(() =>
      expect(mockedApi.createTask).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "reference", parentTaskId: 12 }), expect.any(Object),
      ),
    );
    expect(mockedApi.updateTask).not.toHaveBeenCalled();
    expect(mockedApi.updateProject).not.toHaveBeenCalled();
  });
});
