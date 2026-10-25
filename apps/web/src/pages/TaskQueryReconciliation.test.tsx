import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { useTaskActions } from "../lib/useTaskActions";
import { makeTask } from "../test/fixtures";
import { renderWithProviders } from "../test/testUtils";
import { InboxPage } from "./InboxPage";
import { AllPage } from "./AllPage";

vi.mock("../lib/api", () => ({ api: {
  getMembers: vi.fn().mockResolvedValue([]), getTags: vi.fn().mockResolvedValue([]),
  getProjects: vi.fn().mockResolvedValue([]), getInbox: vi.fn(), searchTasks: vi.fn(),
  updateTask: vi.fn(),
} }));
const mockedApi = vi.mocked(api, true);

describe("nested task query reconciliation", () => {
  beforeEach(() => { vi.clearAllMocks(); window.localStorage.clear(); });
  afterEach(() => { vi.useRealTimers(); });
  it.each([InboxPage, AllPage])("reconciles a nested task from its raw query owner: %s", async Page => {
    const child = makeTask({ id: 2, title: "Nested task", parentTaskId: 1 });
    const parent = makeTask({ id: 1, title: "Parent task", status: "captured", children: [child] });
    const renamed = { ...child, title: "Renamed nested task", revision: 2 };
    let saved = false;
    const load = async () => [{ ...parent, children: [saved ? renamed : child] }];
    mockedApi.getInbox.mockImplementation(load);
    mockedApi.searchTasks.mockImplementation(load);
    mockedApi.updateTask.mockImplementation(async () => { saved = true; return renamed; });
    function Controls() {
      const actions = useTaskActions();
      return <>
        <button onClick={() => void actions.update(child, { title: renamed.title })}>Rename nested task</button>
        <output data-testid="nested-overlay">{String(actions.retained.has(child.id))}</output>
      </>;
    }
    renderWithProviders(<><Page /><Controls /></>);
    await screen.findByText(parent.title);
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Rename nested task" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByTestId("nested-overlay")).toHaveTextContent("true");
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(screen.getByTestId("nested-overlay")).toHaveTextContent("false");
  });
});
