import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { makeProject, makeTask } from "../test/fixtures";
import { renderWithProviders } from "../test/testUtils";
import { AllPage } from "./AllPage";

vi.mock("../lib/api", () => ({
  paperlessDocumentDownloadUrl: (id: number) =>
    `/api/integrations/paperless/documents/${id}/download`,
  paperlessDocumentPreviewUrl: (id: number) =>
    `/api/integrations/paperless/documents/${id}/preview`,
  paperlessDocumentThumbnailUrl: (id: number) =>
    `/api/integrations/paperless/documents/${id}/thumbnail`,
  api: {
    getAuthStatus: vi.fn().mockResolvedValue({
      enabled: false,
      authenticated: false,
      member: null,
    }),
    getMembers: vi.fn().mockResolvedValue([]),
    getTags: vi.fn().mockResolvedValue([]),
    getProjects: vi.fn(),
    searchTasks: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

describe("AllPage", () => {
  const nested = makeTask({
    id: 12,
    title: "Projektfarbe auswählen",
    projectId: 2,
    parentTaskId: 11,
  });
  const projectTask = makeTask({
    id: 11,
    title: "Projektwurzel",
    projectId: 2,
    children: [nested],
  });
  const standaloneChild = makeTask({
    id: 22,
    title: "Eigenständiges Kind",
    parentTaskId: 21,
  });
  const standalone = makeTask({
    id: 21,
    title: "Eigenständige Aufgabe",
    children: [standaloneChild],
  });
  const cancelled = makeTask({
    id: 23,
    title: "Verworfene Aufgabe",
    status: "cancelled",
  });
  const projectMaterial = makeTask({
    id: 31,
    kind: "reference",
    title: "Haftpflichtbedingungen",
    projectId: 2,
    projectTitle: "Wohnung streichen",
    notes: "[Quelle](https://www.source.example/material)\n\nWichtige Bedingungen.",
  });
  const standaloneMaterial = makeTask({
    id: 32,
    kind: "reference",
    title: "Kassenbeleg",
    notes: "[Beleg](paperless:73)",
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.getProjects.mockResolvedValue([
      makeProject({ id: 4, title: "Archivprojekt", status: "archived" }),
      makeProject({ id: 3, title: "Fertiges Projekt", status: "completed" }),
      makeProject({ id: 2, title: "Wohnung streichen", status: "backlog" }),
      makeProject({ id: 1, title: "Aktivprojekt", status: "active" }),
    ]);
    mockedApi.searchTasks.mockImplementation(async (filters) => {
      if (filters.kinds?.includes("reference")) {
        return [projectMaterial, standaloneMaterial];
      }
      if (filters.text === "Projektfarbe") return [nested];
      if (filters.text) return [];
      return [projectTask, nested, standalone, standaloneChild, cancelled];
    });
  });

  it("keeps text search first in the inventory and waits for intentional focus", async () => {
    renderWithProviders(<AllPage />);
    const search = screen.getByRole("textbox", { name: "Suchen" });
    expect(search).not.toHaveFocus();
    await userEvent.tab();
    expect(search).toHaveFocus();
    await userEvent.type(search, "Projektfarbe");
    expect(await screen.findByText("Projektfarbe auswählen")).toBeInTheDocument();
  });

  it("shows every project status and standalone trees without project descendants by default", async () => {
    renderWithProviders(<AllPage />);

    expect(await screen.findByText("Aktivprojekt")).toBeInTheDocument();
    expect(screen.getByText("Wohnung streichen")).toBeInTheDocument();
    expect(screen.getByText("Fertiges Projekt")).toBeInTheDocument();
    expect(screen.getByText("Archivprojekt")).toBeInTheDocument();
    expect(screen.getByText("Eigenständige Aufgabe")).toBeInTheDocument();
    expect(screen.getByText("Eigenständiges Kind")).toBeInTheDocument();
    expect(screen.getByText("Verworfene Aufgabe")).toBeInTheDocument();
    expect(screen.queryByText("Projektwurzel")).not.toBeInTheDocument();
    expect(screen.queryByText("Projektfarbe auswählen")).not.toBeInTheDocument();
    const projectRows = screen.getByRole("heading", {
      name: "Projekte",
    }).nextElementSibling!;
    expect(projectRows).toHaveTextContent(
      /Aktivprojekt.*Wohnung streichen.*Fertiges Projekt.*Archivprojekt/,
    );
  });

  it("finds projects and directly matching nested tasks", async () => {
    renderWithProviders(<AllPage />);
    const search = await screen.findByRole("textbox", { name: "Suchen" });

    await userEvent.type(search, "Wohnung");
    expect(await screen.findByText("Wohnung streichen")).toBeInTheDocument();
    expect(screen.queryByText("Eigenständige Aufgabe")).not.toBeInTheDocument();

    await userEvent.clear(search);
    await userEvent.type(search, "Projektfarbe");
    await waitFor(() =>
      expect(mockedApi.searchTasks).toHaveBeenLastCalledWith({
        text: "Projektfarbe",
        includeTerminal: true,
      }),
    );
    expect(await screen.findByText("Projektfarbe auswählen")).toBeInTheDocument();
    expect(screen.queryByText("Projektwurzel")).not.toBeInTheDocument();
  });

  it("filters and presents standalone and project material with separate open actions", async () => {
    renderWithProviders(<AllPage />);
    await userEvent.click(screen.getByRole("button", { name: "Filter" }));
    await userEvent.click(screen.getByRole("button", { name: "Material" }));

    await waitFor(() =>
      expect(mockedApi.searchTasks).toHaveBeenLastCalledWith({
        kinds: ["reference"],
        includeTerminal: true,
      }),
    );
    expect(await screen.findByRole("heading", { name: "Material" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Material öffnen: Haftpflichtbedingungen" }))
      .toBeVisible();
    expect(within(screen.getAllByRole("article")[0]!).getByText("Wohnung streichen"))
      .toBeVisible();
    expect(screen.getByRole("button", { name: "Material öffnen: Kassenbeleg" }))
      .toBeVisible();
    expect(screen.getByRole("link", { name: "Link öffnen: source.example" }))
      .toHaveAttribute("href", "https://www.source.example/material");
    expect(screen.getByText("PDF")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Projekte" })).not.toBeInTheDocument();
  });
});
