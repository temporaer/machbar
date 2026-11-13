import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@machbar/shared";
import { ApiError, api } from "../lib/api";
import { useTaskWorkflow } from "../lib/taskWorkflowContext";
import { renderWithProviders } from "../test/testUtils";
import { makeMember, makeTask } from "../test/fixtures";
import { TaskWorkflowHost } from "./TaskWorkflowHost";
import { TaskPlanningSheet } from "./TaskPlanningSheet";

const task = makeTask({
  id: 731,
  title: "Protected planning task",
  externalWait: { waitingFor: "Original waiting reason", revisitDate: null },
});
const candidate = makeTask({ id: 732, title: "Current prerequisite" });
const searchLabel = "Aufgabe suchen, die zuerst erledigt werden muss";
const addCandidate = `Abhängigkeit hinzufügen: ${candidate.title}`;

function Controls() {
  const workflow = useTaskWorkflow();
  return <>
    <button onClick={() => workflow.open("plan", task.id, "waiting")}>Open planning</button>
    <TaskWorkflowHost />
  </>;
}

function SuspendedPlanningHarness({ onFailure }: { onFailure: (cause: unknown) => void }) {
  const [suspended, setSuspended] = useState(false);
  return <>
    <button onClick={() => setSuspended(true)}>Suspend planning</button>
    <button onClick={() => setSuspended(false)}>Resume planning</button>
    <TaskPlanningSheet
      task={task}
      initialTarget="dependencies"
      suspended={suspended}
      onClose={() => undefined}
      onFailure={onFailure}
    />
  </>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function openDraft() {
  await userEvent.click(screen.getByRole("button", { name: "Open planning" }));
  const draft = await screen.findByRole("textbox", { name: "Wartet auf" });
  fireEvent.change(draft, { target: { value: "Authored waiting draft" } });
  await userEvent.click(screen.getByRole("button", { name: "+ Voraussetzungen" }));
  return { draft, search: screen.getByLabelText(searchLabel) };
}

describe("TaskPlanningSheet dependency search ownership", () => {
  beforeEach(() => {
    localStorage.setItem("machbar:identity-member-id", "1");
    vi.spyOn(api, "getMembers").mockResolvedValue([makeMember({ id: 1 })]);
    vi.spyOn(api, "getAuthStatus").mockResolvedValue({ enabled: false, authenticated: false, member: null });
    vi.spyOn(api, "getTask").mockResolvedValue(task);
    vi.spyOn(api, "searchTasks").mockResolvedValue([candidate]);
    vi.spyOn(api, "addDependency").mockResolvedValue({
      ...task,
      revision: 2,
      dependencies: [{ id: 1, taskId: task.id, dependsOnTaskId: candidate.id, title: candidate.title, resolved: false }],
    });
    vi.spyOn(api, "updateTask");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it.each([401, 403, 404])("ignores superseded search denial %s after newer success without discarding the planning draft", async status => {
    const old = deferred<Task[]>();
    vi.mocked(api.searchTasks).mockReturnValueOnce(old.promise);
    renderWithProviders(<Controls />);
    const { draft, search } = await openDraft();
    fireEvent.change(search, { target: { value: "old" } });
    fireEvent.change(search, { target: { value: "current" } });
    await screen.findByRole("button", { name: addCandidate });
    await act(async () => old.reject(new ApiError(status, "Obsolete search denial")));
    expect(draft).toBeInTheDocument();
    expect(draft).toHaveValue("Authored waiting draft");
    expect(screen.getByRole("button", { name: addCandidate })).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(api.addDependency).not.toHaveBeenCalled();
    expect(api.updateTask).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404])("ends the current editor on a live search denial %s", async status => {
    vi.mocked(api.searchTasks).mockRejectedValueOnce(new ApiError(status, "Live search denial"));
    renderWithProviders(<Controls />);
    await openDraft();
    fireEvent.change(screen.getByLabelText(searchLabel), { target: { value: "current" } });
    await screen.findByRole("alert");
    expect(screen.getByRole("dialog")).not.toHaveTextContent(task.title);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(api.addDependency).not.toHaveBeenCalled();
  });

  it.each(["success", "denial"] as const)("retires pending %s when the search is cleared to whitespace without another GET", async outcome => {
    const old = deferred<Task[]>();
    vi.mocked(api.searchTasks).mockReturnValueOnce(old.promise);
    renderWithProviders(<Controls />);
    const { draft, search } = await openDraft();
    expect(api.searchTasks).not.toHaveBeenCalled();
    fireEvent.change(search, { target: { value: "old" } });
    await waitFor(() => expect(api.searchTasks).toHaveBeenCalledOnce());
    fireEvent.change(search, { target: { value: "   " } });
    await act(async () => {
      if (outcome === "success") old.resolve([candidate]);
      else old.reject(new ApiError(403, "Cleared search denial"));
    });
    expect(draft).toBeInTheDocument();
    expect(draft).toHaveValue("Authored waiting draft");
    expect(search).toHaveValue("   ");
    expect(screen.queryByRole("button", { name: addCandidate })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(api.searchTasks).toHaveBeenCalledOnce();
  });

  it("does not replace a newer search error with a superseded error, and a new search clears it", async () => {
    const old = deferred<Task[]>();
    vi.mocked(api.searchTasks).mockReturnValueOnce(old.promise)
      .mockRejectedValueOnce(new Error("Current search unavailable"));
    renderWithProviders(<Controls />);
    const { draft, search } = await openDraft();
    fireEvent.change(search, { target: { value: "old" } });
    fireEvent.change(search, { target: { value: "current" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Current search unavailable");
    await act(async () => old.reject(new Error("Obsolete search unavailable")));
    expect(screen.getByRole("alert")).toHaveTextContent("Current search unavailable");
    fireEvent.change(search, { target: { value: "retry" } });
    await screen.findByRole("button", { name: addCandidate });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(draft).toHaveValue("Authored waiting draft");
  });

  it("does not expose superseded candidates while the latest search is pending", async () => {
    const old = deferred<Task[]>();
    const current = deferred<Task[]>();
    vi.mocked(api.searchTasks).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    renderWithProviders(<Controls />);
    const { search } = await openDraft();
    fireEvent.change(search, { target: { value: "old" } });
    fireEvent.change(search, { target: { value: "current" } });
    await act(async () => old.resolve([makeTask({ id: 733, title: "Obsolete prerequisite" })]));
    expect(screen.queryByRole("button", { name: /Abhängigkeit hinzufügen:/ })).not.toBeInTheDocument();
    await act(async () => current.resolve([candidate]));
    expect(await screen.findByRole("button", { name: addCandidate })).toBeVisible();
  });

  it("keeps a replacement opening intact when the closed search later denies access", async () => {
    const old = deferred<Task[]>();
    vi.mocked(api.searchTasks).mockReturnValueOnce(old.promise);
    renderWithProviders(<Controls />);
    const { search } = await openDraft();
    fireEvent.change(search, { target: { value: "old" } });
    await userEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    const replacement = await openDraft();
    await act(async () => old.reject(new ApiError(404, "Closed search denial")));
    expect(replacement.draft).toHaveValue("Authored waiting draft");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("retires the hidden planning search during detail inspection and searches afresh on resume", async () => {
    const old = deferred<Task[]>();
    vi.mocked(api.searchTasks).mockReturnValueOnce(old.promise);
    const onFailure = vi.fn();
    renderWithProviders(<SuspendedPlanningHarness onFailure={onFailure} />);
    fireEvent.change(screen.getByLabelText(searchLabel), { target: { value: "current" } });
    await userEvent.click(screen.getByRole("button", { name: "Suspend planning" }));
    await act(async () => old.reject(new ApiError(403, "Suspended search denial")));
    expect(onFailure).not.toHaveBeenCalled();
    expect(api.searchTasks).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Resume planning" }));
    expect(await screen.findByRole("button", { name: addCandidate })).toBeVisible();
    expect(api.searchTasks).toHaveBeenCalledTimes(2);
  });

  it("preserves candidate filters and submits one explicit revision-bound selection without replay", async () => {
    vi.mocked(api.searchTasks).mockResolvedValue([
      task, makeTask({ id: 734, status: "done" }), makeTask({ id: 735, status: "cancelled" }), candidate,
    ]);
    renderWithProviders(<Controls />);
    const { draft, search } = await openDraft();
    fireEvent.change(search, { target: { value: "  prerequisite  " } });
    await userEvent.click(await screen.findByRole("button", { name: addCandidate }));
    await waitFor(() => expect(api.addDependency).toHaveBeenCalledExactlyOnceWith(task.id, candidate.id, task.revision));
    expect(api.searchTasks).toHaveBeenCalledExactlyOnceWith({ text: "  prerequisite  ", kinds: ["action"] });
    expect(search).toHaveValue("");
    expect(screen.queryByRole("button", { name: /Abhängigkeit hinzufügen:/ })).not.toBeInTheDocument();
    expect(draft).toHaveValue("Authored waiting draft");
  });
});
