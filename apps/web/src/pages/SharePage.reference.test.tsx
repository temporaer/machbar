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
void readPendingShareTarget;

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
      await screen.findByLabelText("Aufgaben und Projekte durchsuchen"),
      "Schweiz",
    );
    await userEvent.click(
      screen.getAllByRole("button", { name: /Schweiz Urlaub/ }).at(-1)!,
    );

    await waitFor(() =>
      expect(mockedApi.createTask).toHaveBeenCalledWith({
        kind: "reference",
        title: "Camping Wang",
        notes: "https://camping-wang.ch/",
        projectId: 4,
        parentTaskId: null,
      }),
    );
    expect(mockedApi.appendProjectNotes).not.toHaveBeenCalled();
    expect(mockedApi.updateProject).not.toHaveBeenCalled();
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

    await userEvent.type(
      await screen.findByLabelText("Aufgaben und Projekte durchsuchen"),
      "Unterkunft",
    );
    expect(screen.getByText("Material · Schweiz Urlaub")).toBeInTheDocument();
    const matchingDestinations = screen.getAllByRole("button", {
      name: /Unterkunft/,
    });
    await userEvent.click(matchingDestinations.at(-1)!);

    await waitFor(() =>
      expect(mockedApi.createTask).toHaveBeenCalledWith({
        kind: "reference",
        title: "Ferienwohnung Beatenberg",
        notes: "https://booking.example/fw",
        projectId: 4,
        parentTaskId: 12,
      }),
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

    await userEvent.click(screen.getByRole("button", { name: "+ Notiz hinzufügen" }));
    await userEvent.type(
      screen.getByLabelText("Notiz"),
      "Direkt am See, scheint gut für die Kinder",
    );
    await userEvent.type(
      await screen.findByLabelText("Aufgaben und Projekte durchsuchen"),
      "Schweiz",
    );
    await userEvent.click(
      screen.getAllByRole("button", { name: /Schweiz Urlaub/ }).at(-1)!,
    );

    await waitFor(() =>
      expect(mockedApi.createTask).toHaveBeenCalledWith({
        kind: "reference",
        title: "Camping Wang",
        notes:
          "https://camping-wang.ch/\n\nDirekt am See, scheint gut für die Kinder",
        projectId: 4,
        parentTaskId: null,
      }),
    );
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

    await userEvent.type(
      await screen.findByLabelText("Aufgaben und Projekte durchsuchen"),
      "Unterkunft",
    );
    const matchingDestinations = screen.getAllByRole("button", {
      name: /Unterkunft/,
    });
    await userEvent.click(matchingDestinations.at(-1)!);

    await waitFor(() =>
      expect(mockedApi.createTask).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "reference", parentTaskId: 12 }),
      ),
    );
    expect(mockedApi.updateTask).not.toHaveBeenCalled();
    expect(mockedApi.updateProject).not.toHaveBeenCalled();
  });
});
