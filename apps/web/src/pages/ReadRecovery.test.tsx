import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Agenda, ReviewItem } from "@machbar/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { useRefresh } from "../lib/refresh";
import { makeMember, makeProject, makeTask } from "../test/fixtures";
import { renderWithProviders } from "../test/testUtils";
import { TodayPage } from "./TodayPage";
import { InboxPage } from "./InboxPage";
import { WaitingPage } from "./WaitingPage";
import { ProjectsPage } from "./ProjectsPage";
import { AllPage } from "./AllPage";
import { ReviewPage } from "./ReviewPage";
import { DiscussionPage } from "./DiscussionPage";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    getAgenda: vi.fn(),
    getInbox: vi.fn(),
    getWaiting: vi.fn(),
    getProjects: vi.fn(),
    getTags: vi.fn(),
    searchTasks: vi.fn(),
    getReviewItems: vi.fn(),
    getDiscussion: vi.fn(),
    getHomeAssistantStatus: vi.fn().mockResolvedValue(null),
    getActivityDigest: vi.fn().mockResolvedValue(null),
    getContributionSummary: vi.fn().mockResolvedValue(null),
    getRefinementOwners: vi.fn().mockResolvedValue([]),
    getRefinementTasks: vi.fn().mockResolvedValue([]),
    createProject: vi.fn(),
    updateTask: vi.fn(),
    updateProject: vi.fn(),
    acknowledgeProjectReview: vi.fn(),
    acknowledgeTaskReview: vi.fn(),
    acknowledgeActivityDigest: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);
const task = makeTask({ id: 11, title: "Saved task", status: "someday" });
const project = makeProject({ id: 21, title: "Saved project", status: "backlog" });
const issue: ReviewItem = {
  entityType: "task", entityId: task.id, entityTitle: task.title,
  projectId: null, projectTitle: null, category: "reconsider",
  reason: "standalone_someday_stale", suggestedAction: { code: "review_task" },
};
const emptyAgenda: Agenda = {
  projects: [], planned: [], overdue: [], dueToday: [], dueSoon: [],
  shared: [], unscheduled: [], revisit: [], completedToday: [],
  interventions: { running: [], review: [] },
};

function RefreshControl() {
  const { bump } = useRefresh();
  return <button onClick={bump}>External refresh</button>;
}

function expectNoWrites() {
  for (const method of [
    "createProject", "updateTask", "updateProject", "acknowledgeProjectReview",
    "acknowledgeTaskReview", "acknowledgeActivityDigest",
  ] as const) expect(mockedApi[method]).not.toHaveBeenCalled();
}

const primaryReads = [
  { Page: TodayPage, method: "getAgenda", resource: "Today", marker: task.title },
  { Page: InboxPage, method: "getInbox", resource: "Inbox", marker: task.title },
  { Page: WaitingPage, method: "getWaiting", resource: "Waiting", marker: task.title },
  { Page: ProjectsPage, method: "getProjects", resource: "Projects", marker: project.title },
  { Page: AllPage, method: "getProjects", resource: "Projects", marker: project.title },
  { Page: ReviewPage, method: "getReviewItems", resource: "Review", marker: task.title },
  { Page: DiscussionPage, method: "getDiscussion", resource: "Discuss", marker: task.title },
] as const;

describe("page-owned read recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.localStorage.setItem("machbar:identity-member-id", "1");
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1 })]);
    mockedApi.getAgenda.mockResolvedValue({ ...emptyAgenda, revisit: [task] });
    mockedApi.getInbox.mockResolvedValue([task]);
    mockedApi.getWaiting.mockResolvedValue([{
      task: { ...task, blocked: true, externalWait: { waitingFor: "Reply", revisitDate: null } },
      reasons: [{ type: "external", waitingFor: "Reply", revisitDate: null }],
    }]);
    mockedApi.getProjects.mockResolvedValue([project]);
    mockedApi.getTags.mockResolvedValue([]);
    mockedApi.searchTasks.mockResolvedValue([task]);
    mockedApi.getReviewItems.mockResolvedValue([issue]);
    mockedApi.getDiscussion.mockResolvedValue({ tasks: [task], projects: [] });
  });

  it.each(primaryReads)("retains $resource content and retries only its failed read ($method)", async ({ Page, method, resource, marker }) => {
    renderWithProviders(<><RefreshControl /><Page /></>, { locale: "en" });
    expect(await screen.findByText(marker)).toBeInTheDocument();
    mockedApi[method].mockRejectedValueOnce(new Error("offline"));
    await userEvent.click(screen.getByRole("button", { name: "External refresh" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(`Could not refresh ${resource}.`);
    expect(screen.getByText(marker)).toBeInTheDocument();
    const counts = primaryReads.map(({ method: read }) => mockedApi[read].mock.calls.length);
    await userEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    primaryReads.forEach(({ method: read }, index) => {
      expect(mockedApi[read]).toHaveBeenCalledTimes(counts[index]! + (read === method ? 1 : 0));
    });
    expect(screen.getByText(marker)).toBeInTheDocument();
    expectNoWrites();
  });

  it.each(primaryReads)("shows refresh failure alongside empty $resource content ($method)", async ({ Page, method, resource }) => {
    mockedApi.getAgenda.mockResolvedValue(emptyAgenda);
    mockedApi.getInbox.mockResolvedValue([]);
    mockedApi.getWaiting.mockResolvedValue([]);
    mockedApi.getProjects.mockResolvedValue([]);
    mockedApi.searchTasks.mockResolvedValue([]);
    mockedApi.getReviewItems.mockResolvedValue([]);
    mockedApi.getDiscussion.mockResolvedValue({ tasks: [], projects: [] });
    const { container } = renderWithProviders(<><RefreshControl /><Page /></>, { locale: "en" });
    await waitFor(() => expect(container.querySelector(".empty-state")).not.toBeNull());
    mockedApi[method].mockRejectedValueOnce(new Error("offline"));
    await userEvent.click(screen.getByRole("button", { name: "External refresh" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(`Could not refresh ${resource}.`);
    expect(container.querySelector(".empty-state")).not.toBeNull();
    expectNoWrites();
  });

  it("attributes simultaneous All failures and preserves filters during independent retries", async () => {
    renderWithProviders(<><RefreshControl /><AllPage /></>, { locale: "en" });
    expect(await screen.findByText(task.title)).toBeInTheDocument();
    const search = screen.getByRole("textbox", { name: "Search" });
    await userEvent.type(search, "Saved");
    mockedApi.getProjects.mockRejectedValueOnce(new Error("projects offline"));
    mockedApi.searchTasks.mockRejectedValueOnce(new Error("tasks offline"));
    mockedApi.getTags.mockRejectedValueOnce(new Error("tags offline"));
    await userEvent.click(screen.getByRole("button", { name: "External refresh" }));
    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(3));
    const taskCount = mockedApi.searchTasks.mock.calls.length;
    const tagCount = mockedApi.getTags.mock.calls.length;
    const projectAlert = screen.getByText("Could not refresh Projects.").closest('[role="alert"]')!;
    await userEvent.click(within(projectAlert as HTMLElement).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(2));
    expect(mockedApi.searchTasks).toHaveBeenCalledTimes(taskCount);
    expect(mockedApi.getTags).toHaveBeenCalledTimes(tagCount);
    expect(search).toHaveValue("Saved");
    expect(screen.getByText(task.title)).toBeInTheDocument();
    expectNoWrites();
  });

  it("keeps All inventory usable when the tag catalog initially fails", async () => {
    mockedApi.getTags.mockRejectedValueOnce(new Error("tags offline"));
    renderWithProviders(<AllPage />, { locale: "en" });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not load Tags.");
    expect(await screen.findByText(task.title)).toBeInTheDocument();
    const tasksBefore = mockedApi.searchTasks.mock.calls.length;
    const projectsBefore = mockedApi.getProjects.mock.calls.length;
    await userEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(mockedApi.searchTasks).toHaveBeenCalledTimes(tasksBefore);
    expect(mockedApi.getProjects).toHaveBeenCalledTimes(projectsBefore);
    expectNoWrites();
  });

  it.each(["getProjects", "searchTasks"] as const)("keeps Review issues reachable when supporting %s fails initially", async (method) => {
    mockedApi[method].mockRejectedValueOnce(new Error("lookup offline"));
    renderWithProviders(<ReviewPage />, { locale: "en" });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(`Could not load ${method === "getProjects" ? "Projects" : "Task"}.`);
    expect(await screen.findByText(task.title)).toBeInTheDocument();
    const issueCount = mockedApi.getReviewItems.mock.calls.length;
    await userEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(mockedApi.getReviewItems).toHaveBeenCalledTimes(issueCount);
    expectNoWrites();
  });
});
