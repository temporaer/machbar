import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, type ProjectDetail } from "../lib/api";
import { useTaskWorkflow } from "../lib/taskWorkflowContext";
import { useProjectWorkflow } from "../lib/projectWorkflowContext";
import { useTaskActions } from "../lib/useTaskActions";
import { useProjectActions } from "../lib/useProjectActions";
import { useRefresh } from "../lib/refresh";
import { makeCriterion, makeMember, makeProject, makeTask } from "../test/fixtures";
import { renderWithProviders } from "../test/testUtils";
import { TaskWorkflowHost } from "./TaskWorkflowHost";
import { ProjectWorkflowHost } from "./ProjectWorkflowHost";

vi.mock("../lib/api", () => ({ api: {
  getMembers: vi.fn(), getTask: vi.fn(), getProject: vi.fn(),
  getTags: vi.fn().mockResolvedValue([]),
  getPhysicalContexts: vi.fn().mockResolvedValue([]),
  searchTasks: vi.fn().mockResolvedValue([]),
  getProjects: vi.fn().mockResolvedValue([]),
  previewTaskUpdate: vi.fn().mockResolvedValue({ decision: null, activatingProjects: [] }),
  updateTask: vi.fn(), updateProject: vi.fn(), completeProject: vi.fn(),
  returnProjectToBacklog: vi.fn(),
} }));
const mocked = vi.mocked(api, true);
const task = makeTask({ id: 1, title: "Retained task", scheduledDate: "2026-12-01" });
const project = makeProject({ id: 2, title: "Retained project", status: "active", ownerMemberId: 1 });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function Controls() {
  const tasks = useTaskActions([task]);
  const projects = useProjectActions([project]);
  const taskWorkflow = useTaskWorkflow();
  const projectWorkflow = useProjectWorkflow();
  const { bump } = useRefresh();
  return <>
    <main id="main-content" tabIndex={-1}>
      <button onClick={() => taskWorkflow.open("plan", task.id, "scheduled")}>Open task</button>
      <button onClick={() => projectWorkflow.open("assignDriver", project.id)}>Open project</button>
      <button onClick={() => projectWorkflow.open("completeWithDecisions", project.id)}>Complete project</button>
      <button onClick={() => projectWorkflow.open("defer", project.id)}>Defer project</button>
      <button onClick={() => tasks.update(task, { priority: 1 }, { priority: 1 }, true)}>Retain task</button>
      <button onClick={() => projects.update(project, { notes: "retained" }, { notes: "retained" }, true)}>Retain project</button>
      <button onClick={bump}>Refresh read</button>
    </main>
    <TaskWorkflowHost /><ProjectWorkflowHost />
  </>;
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  mocked.getMembers.mockResolvedValue([makeMember({ id: 1 })]);
  mocked.getTask.mockResolvedValue(task);
  mocked.getProject.mockResolvedValue({ ...project, tasks: [] });
  mocked.updateTask.mockResolvedValue({ ...task, revision: 2, priority: 1 });
  mocked.updateProject.mockResolvedValue({ ...project, revision: 2, notes: "retained" });
});

describe("focused workflow read recovery", () => {
  it.each(["task", "project"] as const)("keeps the %s opener through delayed recovery into its editor", async (role) => {
    mocked.getTask.mockRejectedValue(new Error("read offline"));
    mocked.getProject.mockRejectedValue(new Error("read offline"));
    renderWithProviders(<Controls />, { locale: "en" });
    const opener = screen.getByRole("button", { name: `Open ${role}` });
    await userEvent.click(opener);
    expect(await screen.findByRole("alert")).toHaveTextContent("read offline");
    const taskRetry = deferred<typeof task>();
    const projectRetry = deferred<ProjectDetail>();
    if (role === "task") mocked.getTask.mockReturnValue(taskRetry.promise);
    else mocked.getProject.mockReturnValue(projectRetry.promise);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByRole("button", { name: "Try again" })).toBeDisabled();
    await act(async () => {
      if (role === "task") taskRetry.resolve(task);
      else projectRetry.resolve({ ...project, tasks: [] });
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveAccessibleName(role === "task" ? "Planning" : `Assign a project lead: ${project.title}`);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(opener).toHaveFocus();
    expect(mocked.updateTask).not.toHaveBeenCalled();
    expect(mocked.updateProject).not.toHaveBeenCalled();
  });

  it.each(["task", "project"] as const)("opens a named loading sheet for an ID-only %s, then offers read-only retry and close", async (role) => {
    const pending = deferred<never>();
    mocked[role === "task" ? "getTask" : "getProject"].mockReturnValue(pending.promise);
    renderWithProviders(<Controls />, { locale: "en" });
    await userEvent.click(screen.getByRole("button", { name: `Open ${role}` }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAccessibleName(role === "task" ? "Planning" : "Assign a project lead");
    expect(within(dialog).getByRole("status")).toHaveTextContent("Loading");
    await act(async () => pending.reject(new Error("read offline")));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("read offline");
    const readsBefore = mocked[role === "task" ? "getTask" : "getProject"].mock.calls.length;
    await userEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(mocked[role === "task" ? "getTask" : "getProject"]).toHaveBeenCalledTimes(readsBefore + 1));
    expect(mocked.updateTask).not.toHaveBeenCalled();
    expect(mocked.updateProject).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: `Open ${role}` })).toHaveFocus();
  });

  it("keeps a retained task's exact editor and draft through initial failure and read retry", async () => {
    mocked.getTask.mockRejectedValue(new Error("read offline"));
    renderWithProviders(<Controls />, { locale: "en" });
    await userEvent.click(screen.getByRole("button", { name: "Retain task" }));
    await waitFor(() => expect(mocked.updateTask).toHaveBeenCalledOnce());
    await userEvent.click(screen.getByRole("button", { name: "Open task" }));
    const editor = await screen.findByRole("textbox", { name: "Planned for" });
    fireEvent.change(editor, { target: { value: "2026-12-05" } });
    fireEvent.blur(editor);
    const draft = (editor as HTMLInputElement).value;
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("read offline");
    const retry = deferred<typeof task>();
    mocked.getTask.mockReturnValue(retry.promise);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByRole("alert")).toBe(alert);
    expect(screen.getByRole("textbox", { name: "Planned for" })).toBe(editor);
    expect(editor).toHaveValue(draft);
    await act(async () => retry.resolve({ ...task, revision: 2, priority: 1 }));
    expect(editor).toHaveValue(draft);
    expect(mocked.updateTask).toHaveBeenCalledOnce();
  });

  it("does not treat retained project metadata as a complete empty task tree", async () => {
    mocked.getProject.mockRejectedValue(new Error("read offline"));
    renderWithProviders(<Controls />, { locale: "en" });
    await userEvent.click(screen.getByRole("button", { name: "Retain project" }));
    await waitFor(() => expect(mocked.updateProject).toHaveBeenCalledOnce());
    await userEvent.click(screen.getByRole("button", { name: "Complete project" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAccessibleName(/Complete project/);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("read offline");
    expect(within(dialog).queryByRole("button", { name: "Complete project" })).not.toBeInTheDocument();
    expect(mocked.completeProject).not.toHaveBeenCalled();
  });

  it("keeps withdrawal choice and date draft while waiting for real project detail", async () => {
    mocked.getProject.mockRejectedValue(new Error("read offline"));
    renderWithProviders(<Controls />, { locale: "en" });
    await userEvent.click(screen.getByRole("button", { name: "Retain project" }));
    await waitFor(() => expect(mocked.updateProject).toHaveBeenCalledOnce());
    await userEvent.click(screen.getByRole("button", { name: "Defer project" }));
    const dialog = await screen.findByRole("dialog");
    const withdrawal = within(dialog).getByRole("checkbox");
    await userEvent.click(withdrawal);
    await userEvent.click(within(dialog).getByRole("button", { name: "Date …" }));
    const editor = within(dialog).getByRole("textbox");
    fireEvent.change(editor, { target: { value: "2026-12-05" } });
    fireEvent.blur(editor);
    const draft = (editor as HTMLInputElement).value;
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Tomorrow" })).toBeDisabled();
    expect(mocked.returnProjectToBacklog).not.toHaveBeenCalled();
    const detail = deferred<ProjectDetail>();
    mocked.getProject.mockReturnValue(detail.promise);
    await userEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    expect(withdrawal).toBeChecked();
    expect(editor).toHaveValue(draft);
    await act(async () => detail.resolve({ ...project, revision: 2, tasks: [makeTask({ id: 3, projectId: project.id, revision: 7 })] }));
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeEnabled();
    expect(withdrawal).toBeChecked();
    expect(editor).toHaveValue(draft);
    expect(mocked.returnProjectToBacklog).not.toHaveBeenCalled();
  });

  it("preserves completion decisions after a background read fails without retrying the command", async () => {
    const child = makeTask({ id: 3, projectId: project.id, title: "Open child" });
    mocked.getProject.mockResolvedValue({ ...project, tasks: [child], acceptanceCriteria: [makeCriterion({ id: 4, projectId: project.id, text: "Ready" })] });
    renderWithProviders(<Controls />, { locale: "en" });
    await userEvent.click(screen.getByRole("button", { name: "Complete project" }));
    const dialog = await screen.findByRole("dialog");
    const criterion = within(dialog).getByRole("checkbox", { name: "Ready" });
    await userEvent.click(criterion);
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    mocked.getProject.mockRejectedValue(new Error("refresh offline"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh read", hidden: true }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("refresh offline");
    expect(within(dialog).getByRole("checkbox", { name: "Ready" })).toBe(criterion);
    expect(criterion).toBeChecked();
    await userEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveAttribute("aria-pressed", "true");
    expect(mocked.completeProject).not.toHaveBeenCalled();
  });
});
