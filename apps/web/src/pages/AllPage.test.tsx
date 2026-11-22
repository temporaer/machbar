import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { makeProject, makeTask } from "../test/fixtures";
import { renderWithProviders } from "../test/testUtils";
import { AllPage } from "./AllPage";
import { useTaskDetail } from "../lib/taskDetailContext";
import { useRefresh } from "../lib/refresh";

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
    completeTask: vi.fn(),
    getPaperlessStatus: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

function OpenTaskProbe() {
  const { openTaskId } = useTaskDetail();
  return <output data-testid="open-task-id">{openTaskId ?? "none"}</output>;
}

function ForceRefresh() {
  const { bump } = useRefresh();
  return <button type="button" onClick={() => { void bump(); }}>Refresh reads</button>;
}

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
    notes: "[Quelle][source]\n\n[Dokument][document]\n\nWichtige Bedingungen. [Weitere Hinweise](https://other.example) und info@example.org\n\n[source]: https://www.source.example/material\n[document]: paperless:72",
  });
  const standaloneMaterial = makeTask({
    id: 32,
    kind: "reference",
    title: "Kassenbeleg",
    notes: "[Beleg](paperless:73)",
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.getPaperlessStatus.mockResolvedValue({
      configured: true,
      documentUiBaseUrl: "https://paperless.example/archive",
    });
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
  afterEach(() => { vi.useRealTimers(); });

  it("keeps text search first in the inventory and waits for intentional focus", async () => {
    renderWithProviders(<AllPage />);
    const search = screen.getByRole("textbox", { name: "Suchen" });
    expect(search).not.toHaveFocus();
    await userEvent.tab();
    expect(search).toHaveFocus();
    await userEvent.type(search, "Projektfarbe");
    expect(await screen.findByText("Projektfarbe auswählen")).toBeInTheDocument();
  });

  it("acknowledges a committed checkbox in place and delays only the matching list query", async () => {
    mockedApi.completeTask.mockResolvedValue({ ...standaloneChild, status: "done", revision: 2 });
    renderWithProviders(<AllPage />);
    const row = (await screen.findByText(standaloneChild.title)).closest<HTMLElement>(".task-row")!;
    const checkbox = within(row).getByRole("button", { name: "Erledigt" });
    mockedApi.searchTasks.mockClear();
    mockedApi.getProjects.mockClear();

    fireEvent.click(checkbox);
    await waitFor(() => expect(mockedApi.completeTask).toHaveBeenCalledOnce());
    await waitFor(() => expect(row.querySelector(".task-row-title")).toHaveClass("done"));
    expect(document.querySelector(".view-completion-notice")?.textContent ?? "").not.toContain(standaloneChild.title);
    expect(mockedApi.searchTasks).not.toHaveBeenCalled();
    await waitFor(() => expect(mockedApi.getProjects).toHaveBeenCalled());
    expect(within(row).getByRole("button", { name: "Wieder öffnen" })).toBeDisabled();

    await new Promise(resolve => setTimeout(resolve, 3_100));
    await waitFor(() => expect(mockedApi.searchTasks).toHaveBeenCalled());
  }, 10_000);

  it("does not acknowledge a rejected checkbox completion", async () => {
    mockedApi.completeTask.mockRejectedValueOnce(new Error("Write rejected"));
    renderWithProviders(<AllPage />);
    const row = (await screen.findByText(standaloneChild.title)).closest<HTMLElement>(".task-row")!;
    await userEvent.click(within(row).getByRole("button", { name: "Erledigt" }));
    expect(await within(row).findByRole("alert")).toHaveTextContent("Write rejected");
    expect(row.querySelector(".task-row-title")).not.toHaveClass("done");
    expect(document.querySelector(".view-completion-notice")?.textContent ?? "").not.toContain(standaloneChild.title);
  });

  it("keeps a slow completion pending, then acknowledges only after its write commits", async () => {
    let commit!: (value: typeof standaloneChild) => void;
    mockedApi.completeTask.mockImplementationOnce(() => new Promise(resolve => { commit = resolve; }));
    renderWithProviders(<AllPage />);
    const row = (await screen.findByText(standaloneChild.title)).closest<HTMLElement>(".task-row")!;
    fireEvent.click(within(row).getByRole("button", { name: "Erledigt" }));
    expect(await within(row).findByText("Wird erledigt …")).toBeInTheDocument();
    expect(row.querySelector(".task-row-title")).not.toHaveClass("done");
    expect(document.querySelector(".view-completion-notice")?.textContent ?? "").not.toContain(standaloneChild.title);

    await act(async () => { commit({ ...standaloneChild, status: "done", revision: 2 }); });
    await waitFor(() => expect(row.querySelector(".task-row-title")).toHaveClass("done"));
    expect(document.querySelector(".view-completion-notice")?.textContent ?? "").not.toContain(standaloneChild.title);
  });

  it("lets a normal refresh shorten the source-query hold", async () => {
    mockedApi.completeTask.mockResolvedValue({ ...standaloneChild, status: "done", revision: 2 });
    renderWithProviders(<><AllPage /><ForceRefresh /></>);
    const row = (await screen.findByText(standaloneChild.title)).closest<HTMLElement>(".task-row")!;
    mockedApi.searchTasks.mockClear();
    fireEvent.click(within(row).getByRole("button", { name: "Erledigt" }));
    await waitFor(() => expect(row.querySelector(".task-row-title")).toHaveClass("done"));
    expect(mockedApi.searchTasks).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Refresh reads" }));
    await waitFor(() => expect(mockedApi.searchTasks).toHaveBeenCalled());
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
    await waitFor(() => expect(mockedApi.searchTasks).toHaveBeenLastCalledWith(
      { text: "Wohnung", includeTerminal: true },
      expect.any(AbortSignal),
    ));
    expect(await screen.findByText("Wohnung streichen")).toBeInTheDocument();
    expect(screen.queryByText("Eigenständige Aufgabe")).not.toBeInTheDocument();

    await userEvent.clear(search);
    await userEvent.type(search, "Projektfarbe");
    await waitFor(() =>
      expect(mockedApi.searchTasks).toHaveBeenLastCalledWith({
        text: "Projektfarbe",
        includeTerminal: true,
      }, expect.any(AbortSignal)),
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
      }, expect.any(AbortSignal)),
    );
    expect(await screen.findByRole("heading", { name: "Material" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Material öffnen: Haftpflichtbedingungen" }))
      .toBeVisible();
    expect(within(screen.getAllByRole("article")[0]!).getByText("Wohnung streichen"))
      .toBeVisible();
    expect(screen.getByRole("button", { name: "Material öffnen: Kassenbeleg" }))
      .toBeVisible();
    expect(document.querySelector(".material-card-inline")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Link öffnen: source.example" }))
      .toHaveAttribute("href", "https://www.source.example/material");
    const preview = document.querySelector(".material-card-notes")!;
    expect(preview).toHaveTextContent("Weitere Hinweise");
    expect(preview.querySelectorAll("a, button, [tabindex]")).toHaveLength(0);
    expect(document.querySelector('img[src="/api/integrations/paperless/documents/72/thumbnail"]'))
      .toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Dokument" })).toHaveAttribute(
      "href",
      "/api/integrations/paperless/documents/72/download",
    );
    await waitFor(() => expect(mockedApi.getPaperlessStatus).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("link", { name: "Dokument in Paperless öffnen" }))
      .toHaveAttribute("href", "https://paperless.example/archive/documents/72/details");
    expect(document.querySelector('img[src="/api/integrations/paperless/documents/73/thumbnail"]'))
      .toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Projekte" })).not.toBeInTheDocument();
  });

  it("clears action status when enabling Material and allows it again after disabling or resetting", async () => {
    renderWithProviders(<AllPage />);
    await userEvent.click(screen.getByRole("button", { name: "Filter" }));
    const status = screen.getByRole("combobox", { name: "Status" });
    const material = screen.getByRole("button", { name: "Material" });
    await userEvent.selectOptions(status, "captured");
    await waitFor(() => expect(mockedApi.searchTasks).toHaveBeenLastCalledWith({
      status: "captured",
      includeTerminal: true,
    }, expect.any(AbortSignal)));

    await userEvent.click(material);
    expect(status).toHaveValue("");
    expect(status).toBeDisabled();
    await waitFor(() => expect(mockedApi.searchTasks).toHaveBeenLastCalledWith({
      kinds: ["reference"],
      includeTerminal: true,
    }, expect.any(AbortSignal)));
    expect(await screen.findByRole("button", { name: "Material öffnen: Kassenbeleg" })).toBeVisible();

    await userEvent.click(material);
    expect(status).toBeEnabled();
    await userEvent.selectOptions(status, "actionable");
    await userEvent.click(material);
    await userEvent.click(screen.getByRole("button", { name: "Filter zurücksetzen" }));
    expect(status).toBeEnabled();
    expect(status).toHaveValue("");
  });

  it("uses theme-aware colors for the selected Material filter", async () => {
    renderWithProviders(<AllPage />);
    await userEvent.click(screen.getByRole("button", { name: "Filter" }));
    const materialFilter = screen.getByRole("button", { name: "Material" });
    await userEvent.click(materialFilter);

    expect(materialFilter).toHaveAttribute("aria-pressed", "true");
    expect(materialFilter.style.getPropertyValue("--tag-color"))
      .toBe("var(--color-primary)");
    expect(materialFilter.style.getPropertyValue("--color-tag-contrast"))
      .toBe("var(--color-primary-contrast)");
  });

  it("keeps Material results keyboard navigable and opens them with Enter and m", async () => {
    renderWithProviders(
      <>
        <AllPage />
        <OpenTaskProbe />
      </>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Filter" }));
    const materialFilter = screen.getByRole("button", { name: "Material" });
    await userEvent.click(materialFilter);

    const first = screen.getByRole("button", {
      name: "Material öffnen: Haftpflichtbedingungen",
    });
    const second = screen.getByRole("button", { name: "Material öffnen: Kassenbeleg" });
    await userEvent.keyboard("j");
    expect(first).toHaveFocus();
    await userEvent.keyboard("j");
    expect(second).toHaveFocus();
    await userEvent.keyboard("{enter}");
    expect(screen.getByTestId("open-task-id")).toHaveTextContent("32");

    await userEvent.keyboard("k");
    expect(first).toHaveFocus();
    await userEvent.keyboard("m");
    expect(screen.getByTestId("open-task-id")).toHaveTextContent("31");
  });
  it("ignores an obsolete search response after rapid typing", async () => {
    const pending: Array<(tasks: ReturnType<typeof makeTask>[]) => void> = [];
    mockedApi.searchTasks.mockImplementation(
      () => new Promise((resolve) => pending.push(resolve)),
    );
    renderWithProviders(<AllPage />);
    await waitFor(() => expect(mockedApi.searchTasks).toHaveBeenCalledTimes(1));
    const search = screen.getByRole("textbox", { name: "Suchen" });

    fireEvent.change(search, { target: { value: "alt" } });
    await waitFor(() => expect(mockedApi.searchTasks).toHaveBeenCalledTimes(2));

    fireEvent.change(search, { target: { value: "neu" } });
    await waitFor(() => expect(mockedApi.searchTasks).toHaveBeenCalledTimes(3));

    await act(async () => {
      pending[2]!([makeTask({ id: 91, title: "Neueste Suche" })]);
    });
    expect(await screen.findByText("Neueste Suche")).toBeInTheDocument();

    await act(async () => {
      pending[1]!([makeTask({ id: 92, title: "Veraltete Suche" })]);
    });
    expect(screen.getByText("Neueste Suche")).toBeInTheDocument();
    expect(screen.queryByText("Veraltete Suche")).not.toBeInTheDocument();
  });

});
