import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, type DiscussionListResponse } from "../lib/api";
import { useRefresh } from "../lib/refresh";
import { de as strings } from "../i18n/de";
import { makeMember, makeProject, makeTask } from "../test/fixtures";
import { renderWithProviders } from "../test/testUtils";
import { DiscussionPage } from "./DiscussionPage";

vi.mock("../lib/api", async importOriginal => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, api: { getMembers: vi.fn(), getDiscussion: vi.fn() } };
});

function RefreshControl() {
  const { bump } = useRefresh();
  return <button onClick={bump}>Refresh discussion</button>;
}

function renderDiscussion() {
  renderWithProviders(<><RefreshControl /><DiscussionPage /></>);
}

const nominated = (): DiscussionListResponse => ({
  tasks: [makeTask({ title: "Discuss task", discussionRequested: true })],
  projects: [makeProject({ title: "Discuss project", status: "backlog", discussionRequested: true })],
});

describe("Discussion read recovery", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.getMembers).mockResolvedValue([makeMember()]);
  });

  it.each([new TypeError("Failed to fetch"), new ApiError(503, "Unavailable")])(
    "keeps initial failure distinct from an empty list and retries: %s",
    async failure => {
      vi.mocked(api.getDiscussion).mockRejectedValueOnce(failure).mockResolvedValueOnce(nominated());
      renderDiscussion();
      expect(await screen.findByRole("alert")).toBeVisible();
      expect(screen.queryByText(strings.discussionEmpty)).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: strings.retry }));
      expect(await screen.findByRole("button", { name: "Discuss task" })).toBeVisible();
      expect(screen.getByRole("button", { name: /Discuss project/ })).toBeVisible();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(api.getDiscussion).toHaveBeenCalledTimes(2);
    },
  );

  it.each([false, true])("retains the last list across repeated outages, including empty=%s", async empty => {
    const initial = empty ? { tasks: [], projects: [] } : nominated();
    const fresh = nominated();
    fresh.tasks[0]!.title = "Current task";
    fresh.projects[0]!.title = "Current project";
    vi.mocked(api.getDiscussion).mockResolvedValueOnce(initial)
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockRejectedValueOnce(new ApiError(503, "Unavailable"))
      .mockResolvedValueOnce(fresh);
    renderDiscussion();
    if (empty) await screen.findByText(strings.discussionEmpty);
    else await screen.findByRole("button", { name: "Discuss task" });
    const expectRetained = () => {
      if (empty) expect(screen.getByText(strings.discussionEmpty)).toBeVisible();
      else {
        expect(screen.getByRole("button", { name: "Discuss task" })).toBeVisible();
        expect(screen.getByRole("button", { name: /Discuss project/ })).toBeVisible();
      }
    };
    fireEvent.click(screen.getByRole("button", { name: "Refresh discussion" }));
    await screen.findByRole("alert");
    expectRetained();
    await userEvent.click(screen.getByRole("button", { name: strings.retry }));
    await waitFor(() => expect(api.getDiscussion).toHaveBeenCalledTimes(3));
    await screen.findByRole("alert");
    expectRetained();
    await userEvent.click(screen.getByRole("button", { name: strings.retry }));
    expect(await screen.findByRole("button", { name: "Current task" })).toBeVisible();
    expect(screen.getByRole("button", { name: /Current project/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Discuss task" })).not.toBeInTheDocument();
    expect(screen.queryByText(strings.discussionEmpty)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(api.getDiscussion).toHaveBeenCalledTimes(4);
  });

  it.each([401, 403, 404])("removes retained protected rows after a live %s response", async status => {
    vi.mocked(api.getDiscussion).mockResolvedValueOnce(nominated())
      .mockRejectedValueOnce(new ApiError(status, "Access ended"));
    renderDiscussion();
    await screen.findByRole("button", { name: "Discuss task" });
    fireEvent.click(screen.getByRole("button", { name: "Refresh discussion" }));
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "Discuss task" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Discuss project/ })).not.toBeInTheDocument();
    expect(screen.queryByText(strings.discussionEmpty)).not.toBeInTheDocument();
  });
});
