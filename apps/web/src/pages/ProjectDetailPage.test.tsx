import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import {
  makeCriterion,
  makeMember,
  makePhysicalContext,
  makeProject,
  makeTag,
  makeTask,
} from "../test/fixtures";
import { renderWithProviders } from "../test/testUtils";
import { ProjectDetailPage } from "./ProjectDetailPage";
import { de as strings } from "../i18n/de";
import { useTaskDetail } from "../lib/taskDetailContext";
import { useTaskWorkflow } from "../lib/taskWorkflowContext";
import { TaskDetailSheet } from "../components/TaskDetailSheet";
import { TaskWorkflowHost } from "../components/TaskWorkflowHost";

vi.mock("../lib/api", () => ({
  paperlessDocumentDownloadUrl: (id: number) =>
    `/api/integrations/paperless/documents/${id}/download`,
  paperlessDocumentPreviewUrl: (id: number) =>
    `/api/integrations/paperless/documents/${id}/preview`,
  paperlessDocumentThumbnailUrl: (id: number) =>
    `/api/integrations/paperless/documents/${id}/thumbnail`,
  api: {
    getMembers: vi.fn(),
    getProject: vi.fn(),
    getTags: vi.fn(),
    getProjects: vi.fn(),
    getHomeAssistantStatus: vi.fn(),
    getTask: vi.fn(),
    updateTask: vi.fn(),
    updateProject: vi.fn(),
    getActivity: vi.fn(),
    uploadPaperlessDocument: vi.fn(),
    searchPaperlessDocuments: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

function ProjectRouteLocation() {
  const location = useLocation();
  const reviewReturn = (
    location.state as {
      reviewReturn?: { issueKey: string };
    } | null
  )?.reviewReturn;
  return (
    <output aria-label="project-route">
      {location.pathname}
      {location.search}|{reviewReturn?.issueKey ?? "none"}
    </output>
  );
}

function TaskRouteState() {
  const { openTaskId, focusField, open } = useTaskDetail();
  return (
    <>
      <output aria-label="task-route-state">
        {openTaskId ?? "none"}|{focusField ?? "none"}
      </output>
      <TaskWorkflowRouteState />
      <button type="button" onClick={() => open(8)}>Open another task</button>
      <PlanAnotherTaskControl />
    </>
  );
}

function PlanAnotherTaskControl() {
  const { open } = useTaskWorkflow();
  return (
    <button type="button" onClick={() => open("plan", 8)}>
      Plan another task
    </button>
  );
}

function TaskWorkflowRouteState() {
  const { current } = useTaskWorkflow();
  return (
    <output aria-label="task-workflow-state">
      {current?.kind ?? "none"}|{current?.taskId ?? "none"}
    </output>
  );
}

function TaskDetailHost() {
  const { openTaskId } = useTaskDetail();
  return openTaskId === null ? null : <TaskDetailSheet />;
}

function RouteControls() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  return (
    <>
      <button type="button" onClick={() => navigate(-1)}>Back</button>
      <button type="button" onClick={() => navigate("/projects/42?focus=planning")}>
        Navigate to planning
      </button>
      <button
        type="button"
        onClick={() =>
          navigate("/projects/42", {
            state: {
              reviewReturn: {
                issueKey: "project:42:missing_driver:",
                issueIndex: 0,
              },
            },
          })
        }
      >
        Open from Review
      </button>
      <button
        type="button"
        onClick={() => {
          const next = new URLSearchParams(searchParams);
          next.delete("focus");
          setSearchParams(next);
        }}
      >
        Remove planning focus
      </button>
    </>
  );
}

function renderProjectRoute(entry: string, initialEntries = [entry]) {
  return renderWithProviders(
    <>
      <Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />} />
        <Route path="/projects" element={<p>Projects destination</p>} />
        <Route path="/more/review" element={<p>Review destination</p>} />
      </Routes>
      <TaskDetailHost />
      <TaskWorkflowHost />
      <ProjectRouteLocation />
      <TaskRouteState />
      <RouteControls />
    </>,
    { initialEntries },
  );
}

describe("ProjectDetailPage task explanations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1, name: "Mira" })]);
    mockedApi.getTags.mockResolvedValue([]);
    mockedApi.getProjects.mockResolvedValue([]);
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
    mockedApi.getProject.mockResolvedValue({
      ...makeProject({ id: 42, title: "Sommerfest planen", ownerMemberId: 1 }),
      tasks: [makeTask({ id: 7, projectId: 42, title: "Ort reservieren" })],
    });
    mockedApi.getTask.mockImplementation(async (id) =>
      makeTask({
        id,
        projectId: 42,
        title: id === 7 ? "Ort reservieren" : "Catering bestätigen",
      }),
    );
    mockedApi.updateTask.mockImplementation(async (id, input) =>
      makeTask({ id, projectId: 42, ...input }),
    );
    mockedApi.getActivity.mockResolvedValue({ items: [], nextCursor: null });
    mockedApi.uploadPaperlessDocument.mockResolvedValue({
      id: 73,
      title: "plan",
      originalFileName: "plan.pdf",
      mimeType: "application/pdf",
    });
  });

  it("renders nested stories and ancestor breadcrumbs", async () => {
    mockedApi.getProject.mockResolvedValue({
      ...makeProject({
        id: 42,
        title: "Gästezimmer renovieren",
        parentId: 3,
      }),
      ancestors: [{ id: 3, title: "Haus verbessern" }],
      childStories: [
        makeProject({
          id: 73,
          parentId: 42,
          title: "Wände vorbereiten",
          status: "backlog",
        }),
      ],
      tasks: [],
    });

    renderProjectRoute("/projects/42");

    expect(
      await screen.findByRole("heading", {
        name: "Gästezimmer renovieren",
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Haus verbessern" })).toHaveAttribute(
      "href",
      "/projects/3",
    );
    expect(screen.getByText("Wände vorbereiten")).toBeInTheDocument();
  });

  it("renders present project facts as direct controls and keeps status read-only", async () => {
    const office = makeTag({ id: 10, name: "büro" });
    mockedApi.getTags.mockResolvedValue([office]);
    mockedApi.getProject.mockResolvedValue({
      ...makeProject({
        id: 42,
        title: "Sommerfest planen",
        status: "active",
        ownerMemberId: 1,
        dueDate: "2026-09-15",
        scheduledDate: "2026-09-10",
        tags: [office],
        contexts: [
          makePhysicalContext({
            id: 77,
            name: "Zuhause",
          }),
        ],
        acceptanceCriteria: [
          makeCriterion({
            id: 4,
            projectId: 42,
            text: "Ort steht",
            checked: false,
          }),
        ],
      }),
      tasks: [],
    });

    renderProjectRoute("/projects/42");

    const overview = await screen.findByLabelText(strings.projectOverview);
    const statusBadge = within(overview).getByText("Aktiv");
    expect(statusBadge).toHaveClass("badge");
    expect(statusBadge.closest("button")).toBeNull();
    expect(
      within(overview).getByRole("button", { name: /Verantwortlich.*Mira/ }),
    ).toBeInTheDocument();
    expect(
      within(overview).getByRole("button", { name: /Fällig.*15\.09\.2026/ }),
    ).toBeInTheDocument();
    expect(
      within(overview).getByRole("button", {
        name: /Wiedervorlage.*10\.09\.2026/,
      }),
    ).toBeInTheDocument();
    expect(
      within(overview).getByRole("button", {
        name: /Erledigt, wenn ….*0\/1/,
      }),
    ).toBeInTheDocument();
    expect(within(overview).getByText("büro")).toBeInTheDocument();
    expect(within(overview).getByText("Zuhause")).toBeInTheDocument();

    await userEvent.click(
      within(overview).getByRole("button", {
        name: /Wiedervorlage.*10\.09\.2026/,
      }),
    );

    expect(
      await screen.findByRole("heading", {
        name: "Wiedervorlage & Fälligkeit",
      }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Wiedervorlage")).toHaveValue("10.09.2026");
  });

  it("omits optional project facts when they have no value", async () => {
    mockedApi.getProject.mockResolvedValue({
      ...makeProject({
        id: 42,
        title: "Sommerfest planen",
        ownerMemberId: null,
        dueDate: null,
        scheduledDate: null,
        tags: [],
        contexts: [],
        acceptanceCriteria: [],
      }),
      tasks: [],
    });

    renderProjectRoute("/projects/42");

    const overview = await screen.findByLabelText(strings.projectOverview);
    expect(within(overview).getByText("Aktiv")).toHaveClass("badge");
    expect(within(overview).queryByText("Niemand zugewiesen")).not.toBeInTheDocument();
    expect(
      within(overview).queryByRole("button", { name: /Verantwortlich/ }),
    ).not.toBeInTheDocument();
    expect(
      within(overview).queryByRole("button", { name: /Fällig/ }),
    ).not.toBeInTheDocument();
    expect(
      within(overview).queryByRole("button", { name: /Wiedervorlage/ }),
    ).not.toBeInTheDocument();
    expect(
      within(overview).queryByRole("button", { name: /Tags/ }),
    ).not.toBeInTheDocument();
  });

  it("loads project and recorded task activity only after opening the disclosure", async () => {
    renderWithProviders(<ProjectDetailPage />);
    expect(await screen.findByText("Ort reservieren")).toBeInTheDocument();

    expect(mockedApi.getActivity).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText("Letzte Aktivitäten"));
    await waitFor(() =>
      expect(mockedApi.getActivity).toHaveBeenCalledWith({ projectId: 42, limit: 5 }),
    );
  });

  it("opens and closes the project task purpose with the shared info control", async () => {
    renderWithProviders(<ProjectDetailPage />);

    expect(await screen.findByText("Ort reservieren")).toBeInTheDocument();
    const purpose =
      "Diese Liste zeigt den Weg zum Projektergebnis: vom nächsten machbaren Schritt über Abhängigkeiten bis zu späterer Arbeit.";
    const button = screen.getByRole("button", {
      name: "Hinweise zu dieser Seite anzeigen",
    });

    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(purpose)).not.toBeInTheDocument();

    await userEvent.click(button);

    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(button).toHaveAccessibleName("Hinweise zu dieser Seite ausblenden");
    expect(screen.getByText(purpose)).toBeInTheDocument();

    await userEvent.click(button);

    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(purpose)).not.toBeInTheDocument();
  });

  it("uses distinct icon-only actions for the project header and notes editors", async () => {
    renderWithProviders(<ProjectDetailPage />);

    expect(await screen.findByText("Ort reservieren")).toBeInTheDocument();
    const projectHeader = screen.getByRole("heading", { level: 1, name: "Sommerfest planen" })
      .closest<HTMLElement>(".page-header")!;
    const notesSection = screen.getByRole("heading", { name: "Notizen" }).closest("section")!;
    const headerEdit = within(projectHeader).getByRole("button", { name: "Bearbeiten" });
    const notesEdit = within(notesSection).getByRole("button", { name: "Bearbeiten" });

    expect(screen.getAllByRole("button", { name: "Bearbeiten" })).toEqual([
      headerEdit,
      notesEdit,
    ]);
    for (const editButton of [headerEdit, notesEdit]) {
      expect(editButton).toHaveClass("icon-action-button");
      expect(editButton).toHaveAttribute("title", "Bearbeiten");
      expect(editButton).not.toHaveTextContent("Bearbeiten");
      editButton.focus();
      expect(editButton).toHaveFocus();
    }

    await userEvent.click(headerEdit);

    const projectEditor = screen.getByRole("dialog", { name: strings.editProject });
    expect(within(projectEditor).getByDisplayValue("Sommerfest planen")).toBeInTheDocument();
    expect(within(notesSection).queryByRole("textbox")).not.toBeInTheDocument();

    await userEvent.click(within(projectEditor).getByRole("button", { name: strings.close }));

    await userEvent.click(notesEdit);

    const notesEditor = screen.getByRole("dialog", { name: strings.editProject });
    const notesInput = within(notesEditor).getByLabelText(strings.notes);
    await waitFor(() => expect(notesInput).toHaveFocus());
    expect(notesInput).toBeEnabled();
    expect(
      within(notesEditor).getByRole("button", {
        name: `${strings.save}: ${strings.notes}`,
      }),
    ).toBeInTheDocument();
    expect(
      within(notesEditor).getByRole("button", {
        name: `${strings.cancel}: ${strings.notes}`,
      }),
    ).toBeInTheDocument();
    expect(within(notesSection).queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("keeps confirmed project metadata after the editor closes while refresh is stale", async () => {
    mockedApi.updateProject.mockResolvedValue({
      ...makeProject({
        id: 42,
        title: "Sommerfest planen",
        ownerMemberId: 1,
        notes: "Neue Notiz",
        revision: 2,
      }),
    });
    renderWithProviders(<ProjectDetailPage />);
    await screen.findByText("Ort reservieren");

    const notesSection = screen.getByRole("heading", { name: "Notizen" }).closest("section")!;
    await userEvent.click(within(notesSection).getByRole("button", { name: "Bearbeiten" }));
    const editor = screen.getByRole("dialog", { name: strings.editProject });
    const notesInput = within(editor).getByLabelText(strings.notes);
    await userEvent.type(notesInput, "Neue Notiz");
    await userEvent.click(
      within(editor).getByRole("button", {
        name: `${strings.save}: ${strings.notes}`,
      }),
    );
    await waitFor(() =>
      expect(mockedApi.updateProject).toHaveBeenCalledWith(42, {
        notes: "Neue Notiz",
        expectedRevision: 1,
      }),
    );
    await userEvent.click(within(editor).getByRole("button", { name: strings.close }));

    expect(await screen.findByText("Neue Notiz")).toBeInTheDocument();
    await userEvent.click(within(notesSection).getByRole("button", { name: "Bearbeiten" }));
    expect(
      within(screen.getByRole("dialog", { name: strings.editProject })).getByLabelText(
        strings.notes,
      ),
    ).toHaveValue("Neue Notiz");
  });

  it("shows Calendar export beside Share only for a dated Project", async () => {
    mockedApi.getProject.mockResolvedValue({
      ...makeProject({
        id: 42,
        title: "Sommerfest planen",
        ownerMemberId: 1,
        dueDate: "2026-09-15",
      }),
      tasks: [],
    });
    renderWithProviders(<ProjectDetailPage />);

    expect(
      await screen.findByRole("button", { name: "Teilen" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "In Kalender" }),
    ).toBeInTheDocument();
    const titleRow = screen
      .getByRole("heading", { level: 1, name: "Sommerfest planen" })
      .closest(".project-page-title-row");
    const actions = titleRow?.querySelector(".project-page-actions");
    expect(titleRow).toHaveClass("project-page-title-row");
    expect(actions).toHaveClass("project-page-actions");
    expect(within(actions as HTMLElement).getAllByRole("button")).toHaveLength(4);
  });

  it("does not show Calendar export for a Project without a deadline", async () => {
    renderWithProviders(<ProjectDetailPage />);

    expect(
      await screen.findByRole("button", { name: "Teilen" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "In Kalender" }),
    ).not.toBeInTheDocument();
  });

  it("appends attachments through canonical project actions", async () => {
    mockedApi.getProject.mockResolvedValue({
      ...makeProject({
        id: 42,
        title: "Sommerfest planen",
        ownerMemberId: 1,
        notes: "Bestehende Notiz",
      }),
      tasks: [],
    });
    mockedApi.updateProject.mockResolvedValue(
      makeProject({
        id: 42,
        title: "Sommerfest planen",
        ownerMemberId: 1,
        notes: "Bestehende Notiz\n\n[plan.pdf](paperless:73)",
        revision: 2,
      }),
    );
    renderWithProviders(<ProjectDetailPage />);
    await screen.findByText("Sommerfest planen");

    await userEvent.click(screen.getByRole("button", { name: "Anhang hinzufügen" }));
    await userEvent.upload(
      screen.getByLabelText("Datei auswählen"),
      new File(["pdf"], "plan.pdf", { type: "application/pdf" }),
    );

    await waitFor(() =>
      expect(mockedApi.updateProject).toHaveBeenCalledWith(42, {
        notes: "Bestehende Notiz\n\n[plan.pdf](paperless:73)",
        expectedRevision: 1,
      }),
    );
    expect(await screen.findByLabelText("1 Anhang")).toBeInTheDocument();
  });

  it("returns full project details to the originating Review item", async () => {
    renderProjectRoute("/more/review");

    await userEvent.click(
      screen.getByRole("button", { name: "Open from Review" }),
    );
    expect(await screen.findByText("Sommerfest planen")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("link", { name: `← ${strings.reviewTitle}` }),
    );

    expect(screen.getByText("Review destination")).toBeInTheDocument();
    expect(screen.getByLabelText("project-route")).toHaveTextContent(
      "/more/review|project:42:missing_driver:",
    );
  });

  it("opens the focused outcome editor on direct navigation and clears only the focus query when closed", async () => {
    renderProjectRoute("/projects/42?focus=outcome");

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(`${strings.criteria}: Sommerfest planen`)).toBeInTheDocument();
    expect(within(dialog).getByPlaceholderText(strings.addCriterionPlaceholder)).toHaveFocus();

    await userEvent.click(
      within(dialog).getAllByRole("button", { name: strings.close })[0]!,
    );
    expect(screen.getByLabelText("project-route")).toHaveTextContent("/projects/42");
    expect(screen.getByLabelText("project-route")).not.toHaveTextContent("focus=");
  });

  it.each([
    ["driver", "button", "Mira"],
    ["completion", "button", strings.completeStory],
  ] as const)(
    "opens and focuses the existing project edit surface for %s repair links",
    async (focus, role, name) => {
      renderProjectRoute(`/projects/42?focus=${focus}`);

      const control = await screen.findByRole(role, { name });
      await waitFor(() => expect(control).toHaveFocus());
    },
  );

  it("opens the project-scoped task capture sheet for a next-action repair link", async () => {
    renderProjectRoute("/projects/42?focus=next-action");

    const input = await screen.findByPlaceholderText(strings.quickAddPlaceholder);
    await waitFor(() => expect(input).toHaveFocus());
    expect(screen.getByLabelText("project-route")).toHaveTextContent(
      "/projects/42?focus=next-action",
    );
  });

  it("opens the one focused planning workflow on the initial planning target", async () => {
    renderProjectRoute("/projects/42?focus=planning");

    // A planning repair link is the `task.plan` intent, so it must reach the
    // same focused workflow as the rail, keyboard and detail value — not a
    // route-specific inspector or a focus field inside the task details.
    const dialog = await screen.findByRole("dialog", {
      name: `${strings.railCommandLabels["task.plan"]}: Ort reservieren`,
    });
    await waitFor(() =>
      expect(within(dialog).getByLabelText(strings.taskPlanQuestion)).toHaveFocus(),
    );
    expect(screen.getByLabelText("task-workflow-state")).toHaveTextContent("plan|7");
    expect(screen.getByLabelText("task-route-state")).toHaveTextContent("none|none");
  });

  it("keeps the initial planning target open until its planning workflow commits", async () => {
    mockedApi.updateTask.mockImplementation(async (id, input) =>
      makeTask({ id, projectId: 42, ...input }),
    );

    renderProjectRoute("/projects/42?focus=planning");

    const dialog = await screen.findByRole("dialog", {
      name: `${strings.railCommandLabels["task.plan"]}: Ort reservieren`,
    });
    await userEvent.click(
      within(dialog).getByRole("button", {
        name: strings.scheduleShortcutLabels.today,
      }),
    );
    expect(dialog).toBeInTheDocument();

    await userEvent.click(
      within(dialog).getByRole("button", { name: strings.confirmDone }),
    );

    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(7, {
        scheduledDate: expect.any(String),
        dueDate: null,
        expectedRevision: 1,
      }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("task-workflow-state")).toHaveTextContent(
        "none|none",
      ),
    );
    expect(mockedApi.getTask).not.toHaveBeenCalledWith(8);
  });

  it.each([
    ["focus removal", ["/projects/42?focus=planning"], "Remove planning focus"],
    ["Back navigation", ["/projects", "/projects/42?focus=planning"], "Back"],
  ])("closes its route-owned planning workflow on %s", async (_name, entries, action) => {
    renderProjectRoute(entries.at(-1)!, entries);

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: action }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.getByLabelText("task-workflow-state")).toHaveTextContent("none|none");
    if (action === "Back") {
      expect(screen.getByText("Projects destination")).toBeInTheDocument();
    } else {
      expect(screen.getByLabelText("project-route")).toHaveTextContent("/projects/42");
      expect(screen.getByLabelText("project-route")).not.toHaveTextContent("focus=");
    }
  });

  it("does not close a workflow that replaced the route-owned planning workflow", async () => {
    renderProjectRoute("/projects/42?focus=planning");

    expect(
      await screen.findByRole("dialog", {
        name: `${strings.railCommandLabels["task.plan"]}: Ort reservieren`,
      }),
    ).toBeInTheDocument();

    // Once the user steers the single workflow slot elsewhere, the route no
    // longer owns it and must not close it when it drops its focus query.
    await userEvent.click(screen.getByRole("button", { name: "Plan another task" }));

    expect(
      await screen.findByRole("dialog", {
        name: `${strings.railCommandLabels["task.plan"]}: Catering bestätigen`,
      }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByLabelText("project-route")).not.toHaveTextContent("focus="),
    );
    expect(screen.getByLabelText("task-workflow-state")).toHaveTextContent("plan|8");
  });

  it("preserves a user-opened task sheet across planning navigation and Back", async () => {
    renderProjectRoute("/projects", ["/projects"]);

    await userEvent.click(screen.getByRole("button", { name: "Open another task" }));
    const userDialog = await screen.findByRole("dialog", { name: strings.taskDetails });
    expect(
      await within(userDialog).findByText("Catering bestätigen", {
        selector: "strong",
      }),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Navigate to planning" }));
    expect(await screen.findByText("Sommerfest planen")).toBeInTheDocument();
    expect(
      within(userDialog).getByText("Catering bestätigen", {
        selector: "strong",
      }),
    ).toBeInTheDocument();
    expect(mockedApi.getTask).not.toHaveBeenCalledWith(7);

    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByText("Projects destination")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: strings.taskDetails })).toBeInTheDocument();
    expect(screen.getByLabelText("task-route-state")).toHaveTextContent("8|none");
  });
});
