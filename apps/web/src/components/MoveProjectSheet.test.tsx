import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "../lib/api";
import { de as strings } from "../i18n/de";
import { makeProject } from "../test/fixtures";
import { renderWithProviders } from "../test/testUtils";
import { MoveProjectSheet } from "./MoveProjectSheet";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, api: { ...actual.api, getMembers: vi.fn(), getProjects: vi.fn(), getProject: vi.fn(), moveProject: vi.fn() } };
});
const mockedApi = vi.mocked(api);
const source = { ...makeProject({ id: 1, title: "Moving" }), tasks: [], hierarchyRevisions: [{ id: 1, revision: 1 }, { id: 3, revision: 1 }] };
const target = { ...makeProject({ id: 2, title: "Destination" }), tasks: [], ancestors: [], hierarchyRevisions: [{ id: 2, revision: 1 }] };

describe("project movement decisions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.getMembers.mockResolvedValue([]);
    mockedApi.getProjects.mockResolvedValue([source, target, makeProject({ id: 3, title: "Child project" }), makeProject({ id: 4, title: "Private", scope: "work" })]);
    mockedApi.getProject.mockImplementation(async (id) => id === 1 ? source : target);
    mockedApi.moveProject.mockResolvedValue(source);
  });
  it("filters scope and descendants, searches destinations, and cancels without writing", async () => {
    const close = vi.fn();
    renderWithProviders(<MoveProjectSheet story={source} onClose={close} />);
    const search = await screen.findByRole("searchbox");
    expect(screen.queryByRole("button", { name: "Child project" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Private" })).not.toBeInTheDocument();
    await userEvent.type(search, "dest");
    await userEvent.click(screen.getByRole("button", { name: "Destination" }));
    await userEvent.click(screen.getByRole("button", { name: strings.cancel }));
    expect(close).toHaveBeenCalledOnce();
    expect(mockedApi.moveProject).not.toHaveBeenCalled();
  });
  it("retains the destination after a stale write and retries with refreshed revisions", async () => {
    mockedApi.moveProject.mockRejectedValueOnce(new ApiError(409, "Changed", "stale_write_conflict"));
    const close = vi.fn();
    renderWithProviders(<MoveProjectSheet story={source} onClose={close} />);
    await userEvent.click(await screen.findByRole("button", { name: "Destination" }));
    const save = screen.getByRole("button", { name: strings.moveHere });
    await waitFor(() => expect(save).toBeEnabled());
    await userEvent.click(save);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Destination" })).toHaveAttribute("aria-pressed", "true");
    expect(close).not.toHaveBeenCalled();
    await userEvent.click(save);
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(mockedApi.moveProject).toHaveBeenLastCalledWith(1, { parentId: 2, expectedRevision: 1, expectedHierarchyRevisions: [{ id: 1, revision: 1 }, { id: 3, revision: 1 }, { id: 2, revision: 1 }] });
  });
});
