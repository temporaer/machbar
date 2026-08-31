import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReviewItem } from "@machbar/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Link, Route, Routes, useLocation } from "react-router-dom";
import { api } from "../lib/api";
import { makeProject, makeTask } from "../test/fixtures";
import { renderWithProviders } from "../test/testUtils";
import { ReviewPage } from "./ReviewPage";

vi.mock("../lib/api", () => ({
  api: {
    getAuthStatus: vi.fn().mockResolvedValue({
      enabled: false,
      authenticated: false,
      member: null,
    }),
    getMembers: vi.fn().mockResolvedValue([]),
    getReviewItems: vi.fn(),
    getProjects: vi.fn(),
    searchTasks: vi.fn(),
    getRefinementOwners: vi.fn().mockResolvedValue([]),
    getRefinementTasks: vi.fn().mockResolvedValue([]),
    acknowledgeProjectReview: vi.fn(),
    acknowledgeTaskReview: vi.fn(),
    updateTask: vi.fn(),
    activateProject: vi.fn(),
    returnProjectToBacklog: vi.fn(),
    completeProject: vi.fn(),
    archiveProject: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

function ReviewProjectDestination() {
  const location = useLocation();
  return (
    <>
      <output aria-label="repair-location">{location.pathname}{location.search}</output>
      <Link to="/more/review" state={location.state}>Back to Review</Link>
    </>
  );
}

describe("ReviewPage", () => {
  const project = makeProject({
    id: 4,
    title: "Küche renovieren",
    status: "active",
    ownerMemberId: 1,
  });
  const task = makeTask({
    id: 8,
    title: "Alte Lampen prüfen",
    status: "someday",
  });
  const staleProject = makeProject({
    id: 5,
    title: "Flur neu ordnen",
    status: "active",
    ownerMemberId: 1,
    nextAction: makeTask({ id: 9, projectId: 5 }),
  });
  const reviewItems: ReviewItem[] = [
    {
      entityType: "project",
      entityId: 4,
      entityTitle: project.title,
      projectId: 4,
      projectTitle: project.title,
      category: "clarification_repair",
      reason: "no_viable_progress_path",
      suggestedAction: { code: "add_next_action" },
    },
    {
      entityType: "project",
      entityId: 5,
      entityTitle: staleProject.title,
      projectId: 5,
      projectTitle: staleProject.title,
      category: "reconsider",
      reason: "active_stale",
      suggestedAction: { code: "review_project" },
    },
    {
      entityType: "task",
      entityId: 8,
      entityTitle: task.title,
      projectId: null,
      projectTitle: null,
      category: "reconsider",
      reason: "standalone_someday_stale",
      suggestedAction: { code: "review_task" },
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.getReviewItems.mockResolvedValue(reviewItems);
    mockedApi.getProjects.mockResolvedValue([project, staleProject]);
    mockedApi.searchTasks.mockResolvedValue([task]);
    mockedApi.acknowledgeProjectReview.mockResolvedValue({
      ...staleProject,
      revision: 2,
      reviewedAt: "2026-08-31T20:00:00.000Z",
    });
    mockedApi.acknowledgeTaskReview.mockResolvedValue({
      ...task,
      revision: 2,
      reviewedAt: "2026-08-31T20:00:00.000Z",
    });
  });

  it("renders grouped decisions with reasons and keeps refinement tools optional", async () => {
    renderWithProviders(<ReviewPage />);

    expect(await screen.findByRole("heading", { name: "Fortschritt ermöglichen" }))
      .toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Bewusst bestätigen" })).toBeInTheDocument();
    expect(screen.getByText(/keinen ausführbaren nächsten Schritt/)).toBeInTheDocument();
    expect(screen.getAllByText(/länger nicht bewusst bestätigt/)).toHaveLength(2);
    const tools = screen.getByText("Optionale Planungswerkzeuge").closest("details");
    expect(tools).not.toHaveAttribute("open");
  });

  it("reveals the preserved sizing and assignment tools only on demand", async () => {
    mockedApi.getRefinementOwners.mockResolvedValue([
      { ownerId: null, ownerName: null, S: 1, M: 0, L: 0, XL: 0, unestimated: 0, total: 1 },
    ]);
    mockedApi.getRefinementTasks.mockResolvedValue([
      {
        id: 19,
        revision: 1,
        title: "Werkzeug sortieren",
        status: "actionable",
        size: "S",
        projectId: null,
        projectTitle: null,
        effectiveOwnerId: null,
        effectiveOwnerSource: "none",
        position: 0,
        updatedAt: "2026-08-31T00:00:00.000Z",
        blocked: false,
        executable: true,
        externalWait: null,
        nextBlockerAttentionDate: null,
        blockers: [],
        dependencies: [],
        effectiveTags: [],
      },
    ]);
    renderWithProviders(<ReviewPage />);

    await userEvent.click(
      await screen.findByText("Optionale Planungswerkzeuge"),
    );

    expect(await screen.findByText("Werkzeug sortieren")).toBeInTheDocument();
    expect(screen.getByText("Aufwand überblicken")).toBeInTheDocument();
  });

  it("acknowledges projects and tasks only from explicit decisions", async () => {
    renderWithProviders(<ReviewPage />);
    const projectCard = (await screen.findByText(project.title)).closest("article")!;
    const staleProjectCard = screen.getByText(staleProject.title).closest("article")!;
    const taskCard = screen.getByText(task.title).closest("article")!;

    expect(mockedApi.acknowledgeProjectReview).not.toHaveBeenCalled();
    expect(within(projectCard).queryByRole("button", { name: "So beibehalten" }))
      .not.toBeInTheDocument();
    await userEvent.click(
      within(staleProjectCard).getByRole("button", { name: "So beibehalten" }),
    );
    await userEvent.click(within(taskCard).getByRole("button", { name: "So beibehalten" }));

    await waitFor(() =>
      expect(mockedApi.acknowledgeProjectReview).toHaveBeenCalledWith(5, {
        expectedRevision: 1,
      }),
    );
    expect(mockedApi.acknowledgeTaskReview).toHaveBeenCalledWith(8, 1);
    expect(within(staleProjectCard).getByText("Für jetzt bestätigt")).toBeInTheDocument();
    expect(within(taskCard).getByText("Für jetzt bestätigt")).toBeInTheDocument();
  });

  it("reuses the canonical task lifecycle action for a Someday decision", async () => {
    mockedApi.updateTask.mockResolvedValue({ ...task, status: "actionable", revision: 2 });
    renderWithProviders(<ReviewPage />);
    const taskCard = (await screen.findByText(task.title)).closest("article")!;

    await userEvent.click(within(taskCard).getByRole("button", { name: "Machbar" }));

    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(8, {
        status: "actionable",
        expectedRevision: 1,
      }),
    );
  });

  it("returns from project repair to the originating focused queue item", async () => {
    renderWithProviders(
      <Routes>
        <Route path="/more/review" element={<ReviewPage />} />
        <Route path="/projects/:id" element={<ReviewProjectDestination />} />
      </Routes>,
      { initialEntries: ["/more/review"] },
    );
    const card = (await screen.findByText(project.title)).closest("article")!;

    await userEvent.click(
      within(card).getByRole("button", { name: "Nächsten Schritt hinzufügen" }),
    );
    expect(screen.getByLabelText("repair-location")).toHaveTextContent(
      "/projects/4?focus=next-action",
    );
    await userEvent.click(screen.getByRole("link", { name: "Back to Review" }));

    await waitFor(() =>
      expect(screen.getByText(project.title).closest("article")).toHaveFocus(),
    );
  });

  it("routes a project plan repair without a task target to project planning", async () => {
    mockedApi.getReviewItems.mockResolvedValue([
      {
        entityType: "project",
        entityId: 4,
        entityTitle: project.title,
        projectId: 4,
        projectTitle: project.title,
        category: "clarification_repair",
        reason: "due_without_credible_plan",
        suggestedAction: { code: "plan_task" },
      },
    ]);
    renderWithProviders(
      <Routes>
        <Route path="/more/review" element={<ReviewPage />} />
        <Route path="/projects/:id" element={<ReviewProjectDestination />} />
      </Routes>,
      { initialEntries: ["/more/review"] },
    );

    await userEvent.click(await screen.findByRole("button", { name: "Planen" }));

    expect(screen.getByLabelText("repair-location")).toHaveTextContent(
      "/projects/4?focus=planning",
    );
  });
});
