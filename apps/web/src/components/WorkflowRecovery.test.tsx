import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, type ProjectDetail } from "../lib/api";
import { useTaskWorkflow } from "../lib/taskWorkflowContext";
import { useProjectWorkflow } from "../lib/projectWorkflowContext";
import { useTaskActions } from "../lib/useTaskActions";
import { useProjectActions } from "../lib/useProjectActions";
import { useRefresh } from "../lib/refresh";
import { useIdentity } from "../lib/identity";
import { useTaskDetail, type TaskDetailHandoff } from "../lib/taskDetailContext";
import { makeCriterion, makeMember, makeProject, makeTask } from "../test/fixtures";
import { renderWithProviders } from "../test/testUtils";
import { TaskWorkflowHost } from "./TaskWorkflowHost";
import { ProjectWorkflowHost } from "./ProjectWorkflowHost";
import { IdentityGate } from "./IdentityGate";

vi.mock("../lib/api", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/api")>(), api: {
  getMembers: vi.fn(), getTask: vi.fn(), getProject: vi.fn(), getAuthStatus: vi.fn(),
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

function PendingTaskControls() {
  const actions = useTaskActions([task]);
  const workflow = useTaskWorkflow();
  return <>
    <button onClick={() => void actions.update(task, { priority: 1 })}>Start task save</button>
    <button onClick={() => workflow.open("plan", task.id, "scheduled")}>Open pending task</button>
    <TaskWorkflowHost />
  </>;
}

function PendingProjectControls() {
  const actions = useProjectActions([project]);
  const workflow = useProjectWorkflow();
  return <>
    <button onClick={() => void actions.update(project, { notes: "pending" })}>Start project save</button>
    <button onClick={() => workflow.open("defer", project.id)}>Open pending project</button>
    <ProjectWorkflowHost />
  </>;
}

function IdentityControls() {
  const { currentMemberId, setCurrentMemberId } = useIdentity();
  return <>
    <span>Member: {currentMemberId}</span>
    <button onClick={() => setCurrentMemberId(1)}>Member 1</button>
    <button onClick={() => setCurrentMemberId(2)}>Member 2</button>
  </>;
}

function AuthControls() {
  const { reloadAuth } = useIdentity();
  return <button onClick={reloadAuth}>Refresh authentication</button>;
}

function InspectionControls() {
  const workflow = useTaskWorkflow();
  const projects = useProjectWorkflow();
  const detail = useTaskDetail();
  const expired = useRef<{
    workflow: typeof workflow; projects: typeof projects; detail: typeof detail; snapshot: TaskDetailHandoff | null;
  } | null>(null);
  return <>
    <button onClick={() => detail.openQueue([7, 8], "notes")}>Open detail queue</button>
    <button onClick={() => {
      const snapshot = detail.suspendForHandoff();
      expired.current = { workflow, projects, detail, snapshot };
      workflow.suspendForDetail(snapshot);
      detail.open(9);
    }}>Inspect prerequisite</button>
    <button onClick={() => {
      const old = expired.current;
      if (!old) throw new Error("Expected an expired inspection");
      old.workflow.resumeFromDetail();
      old.workflow.open("plan", 99);
      old.projects.open("defer", project.id);
      if (old.snapshot) old.detail.resumeAfterHandoff(old.snapshot);
    }}>Run expired callbacks</button>
    <output data-testid="inspection-state">{JSON.stringify({
      task: workflow.current?.taskId ?? null, project: projects.current?.projectId ?? null,
      inspections: workflow.detailInspections.length, detail: detail.openTaskId, queue: detail.queueActive, suspended: detail.suspended,
    })}</output>
  </>;
}

function ProjectReceiptProbe({ detail }: { detail: ProjectDetail }) {
  const actions = useProjectActions();
  return <output data-testid="project-receipt">{JSON.stringify({
    confirmed: actions.getConfirmedStory(project.id),
    projected: actions.projectStory(detail),
  })}</output>;
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  mocked.getMembers.mockResolvedValue([makeMember({ id: 1 })]);
  mocked.getAuthStatus.mockResolvedValue({ enabled: false, authenticated: false, member: null });
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

  it.each(["task", "project"] as const)("keeps a retained-only %s editor, draft and save error after failed Save and read recovery", async (role) => {
    mocked.getTask.mockRejectedValue(new Error("read offline"));
    mocked.getProject.mockRejectedValue(new Error("read offline"));
    renderWithProviders(<Controls />, { locale: "en" });
    await userEvent.click(screen.getByRole("button", { name: `Retain ${role}` }));
    await userEvent.click(screen.getByRole("button", { name: role === "task" ? "Open task" : "Defer project" }));
    const dialog = await screen.findByRole("dialog");
    if (role === "project") {
      await userEvent.click(within(dialog).getByRole("button", { name: "Date …" }));
    }
    const editor = within(dialog).getByRole("textbox", role === "task" ? { name: "Planned for" } : {});
    fireEvent.change(editor, { target: { value: "2026-12-05" } });
    fireEvent.blur(editor);
    const draft = (editor as HTMLInputElement).value;
    if (role === "task") mocked.updateTask.mockRejectedValue(new Error("save offline"));
    else mocked.returnProjectToBacklog.mockRejectedValue(new Error("save offline"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await screen.findByText("save offline");
    expect(within(dialog).getByRole("textbox", role === "task" ? { name: "Planned for" } : {})).toBe(editor);
    expect(editor).toHaveValue(draft);
    const taskRetry = deferred<typeof task>();
    const projectRetry = deferred<ProjectDetail>();
    if (role === "task") mocked.getTask.mockReturnValue(taskRetry.promise);
    else mocked.getProject.mockReturnValue(projectRetry.promise);
    await userEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    expect(editor).toHaveValue(draft);
    expect(screen.getByText("save offline")).toBeInTheDocument();
    await act(async () => {
      if (role === "task") taskRetry.resolve({ ...task, revision: 2, priority: 1 });
      else projectRetry.resolve({ ...project, revision: 2, notes: "retained", tasks: [] });
    });
    expect(within(dialog).getByRole("textbox", role === "task" ? { name: "Planned for" } : {})).toBe(editor);
    expect(editor).toHaveValue(draft);
    expect(screen.getByText("save offline")).toBeInTheDocument();
    expect(mocked.updateTask).toHaveBeenCalledTimes(role === "task" ? 2 : 0);
    expect(mocked.returnProjectToBacklog).toHaveBeenCalledTimes(role === "project" ? 1 : 0);
    if (role === "task") mocked.updateTask.mockResolvedValue({ ...task, revision: 3, scheduledDate: "2026-12-05" });
    else mocked.returnProjectToBacklog.mockResolvedValue({ ...project, revision: 3, status: "backlog", revisitAt: "2026-12-05T06:00:00.000Z" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    if (role === "task") expect(mocked.updateTask).toHaveBeenLastCalledWith(task.id, expect.objectContaining({ expectedRevision: 2, scheduledDate: "2026-12-05" }));
    else expect(mocked.returnProjectToBacklog).toHaveBeenLastCalledWith(project.id, expect.objectContaining({ expectedRevision: 2, withdrawCommitments: false }));
  });

  it("does not preserve an optimistic-only target as a confirmed input after its first Save fails", async () => {
    mocked.getTask.mockRejectedValue(new Error("read offline"));
    const pending = deferred<typeof task>();
    mocked.updateTask.mockReturnValue(pending.promise);
    renderWithProviders(<PendingTaskControls />, { locale: "en" });
    await userEvent.click(screen.getByRole("button", { name: "Start task save" }));
    await userEvent.click(screen.getByRole("button", { name: "Open pending task" }));
    await screen.findByRole("textbox", { name: "Planned for" });
    await act(async () => pending.reject(new Error("save offline")));
    expect(screen.queryByRole("textbox", { name: "Planned for" })).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("read offline");
  });

  it("does not certify optimistic-only project metadata as confirmed after its first Save fails", async () => {
    mocked.getProject.mockRejectedValue(new Error("read offline"));
    const pending = deferred<typeof project>();
    mocked.updateProject.mockReturnValue(pending.promise);
    renderWithProviders(<PendingProjectControls />, { locale: "en" });
    await userEvent.click(screen.getByRole("button", { name: "Start project save" }));
    await userEvent.click(screen.getByRole("button", { name: "Open pending project" }));
    await screen.findByText(project.title);
    await act(async () => pending.reject(new Error("save offline")));
    expect(screen.queryByText(project.title)).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("read offline");
  });

  it.each([
    ["task", 403, false], ["task", 404, true],
    ["project", 403, false], ["project", 404, true],
  ] as const)("revalidates a %s write HTTP %s without inferring source read loss (denied source: %s)", async (role, writeStatus, deniedSource) => {
    mocked.getTask.mockRejectedValue(new Error("read offline"));
    mocked.getProject.mockRejectedValue(new Error("read offline"));
    renderWithProviders(<Controls />, { locale: "en" });
    await userEvent.click(screen.getByRole("button", { name: `Retain ${role}` }));
    await userEvent.click(screen.getByRole("button", { name: role === "task" ? "Open task" : "Defer project" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByRole("alert");
    if (role === "project") await userEvent.click(within(dialog).getByRole("button", { name: "Date …" }));
    const editor = within(dialog).getByRole("textbox", role === "task" ? { name: "Planned for" } : {});
    fireEvent.change(editor, { target: { value: "2026-12-05" } });
    fireEvent.blur(editor);
    const draft = (editor as HTMLInputElement).value;
    const readsBefore = mocked[role === "task" ? "getTask" : "getProject"].mock.calls.length;
    if (role === "task") mocked.updateTask.mockRejectedValue(new ApiError(writeStatus, "Write denied"));
    else mocked.returnProjectToBacklog.mockRejectedValue(new ApiError(writeStatus, "Write denied"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await screen.findAllByText(/^Something went wrong\.?$/);
    await waitFor(() => expect(mocked[role === "task" ? "getTask" : "getProject"].mock.calls.length).toBeGreaterThan(readsBefore));
    expect(editor).toHaveValue(draft);
    expect(within(dialog).getByRole("textbox", role === "task" ? { name: "Planned for" } : {})).toBe(editor);
    if (deniedSource) {
      mocked.getTask.mockRejectedValue(new ApiError(403, "Source read denied"));
      mocked.getProject.mockRejectedValue(new ApiError(403, "Source read denied"));
    } else {
      mocked.getTask.mockResolvedValue({ ...task, revision: 2, priority: 1 });
      mocked.getProject.mockResolvedValue({ ...project, revision: 2, notes: "retained", tasks: [] });
    }
    await userEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    if (deniedSource) {
      await waitFor(() => expect(screen.queryByRole("textbox")).not.toBeInTheDocument());
      expect(screen.queryByText(role === "task" ? task.title : project.title)).not.toBeInTheDocument();
    } else {
      await waitFor(() => expect(screen.queryByText("read offline")).not.toBeInTheDocument());
      expect(editor).toHaveValue(draft);
      expect(screen.getAllByText(/^Something went wrong\.?$/).length).toBeGreaterThan(0);
    }
    expect(mocked.updateTask).toHaveBeenCalledTimes(role === "task" ? 2 : 0);
    expect(mocked.returnProjectToBacklog).toHaveBeenCalledTimes(role === "project" ? 1 : 0);
  });

  it.each(["task", "project"] as const)("does not revive a %s opening or receipt after A-to-B-to-A identity changes", async (role) => {
    mocked.getMembers.mockResolvedValue([makeMember({ id: 1 }), makeMember({ id: 2 })]);
    mocked.getTask.mockRejectedValue(new Error("read offline"));
    mocked.getProject.mockRejectedValue(new Error("read offline"));
    renderWithProviders(<><IdentityControls /><Controls /></>, { locale: "en" });
    await userEvent.click(screen.getByRole("button", { name: "Member 1" }));
    await screen.findByText("Member: 1");
    await userEvent.click(screen.getByRole("button", { name: `Retain ${role}` }));
    const open = role === "task" ? "Open task" : "Defer project";
    await userEvent.click(screen.getByRole("button", { name: open }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByRole("alert");
    if (role === "task") expect(within(dialog).getByRole("textbox", { name: "Planned for" })).toBeInTheDocument();
    else expect(within(dialog).getByText(project.title)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Member 2", hidden: true }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await screen.findByText("Member: 2");
    await userEvent.click(screen.getByRole("button", { name: "Member 1" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: open }));
    expect(await screen.findByRole("alert")).toHaveTextContent("read offline");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByText(role === "task" ? task.title : project.title)).not.toBeInTheDocument();
  });

  it.each(["task", "project"] as const)("does not revive a %s opening after the real authentication gate remounts its host", async role => {
    mocked.getMembers.mockResolvedValue([makeMember({ id: 1 }), makeMember({ id: 2 })]);
    mocked.getAuthStatus.mockResolvedValue({ enabled: true, authenticated: true, member: makeMember({ id: 1 }) });
    mocked.getTask.mockRejectedValue(new Error("read offline"));
    mocked.getProject.mockRejectedValue(new Error("read offline"));
    renderWithProviders(<><AuthControls /><IdentityGate><Controls /></IdentityGate></>, { locale: "en" });
    await userEvent.click(await screen.findByRole("button", { name: `Retain ${role}` }));
    await userEvent.click(screen.getByRole("button", { name: role === "task" ? "Open task" : "Defer project" }));
    await screen.findByRole("alert");
    mocked.getAuthStatus.mockResolvedValue({ enabled: true, authenticated: false, member: null });
    fireEvent.click(screen.getByRole("button", { name: "Refresh authentication", hidden: true }));
    await screen.findByRole("button", { name: /Sign in with Pocket/ });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    mocked.getAuthStatus.mockResolvedValue({ enabled: true, authenticated: true, member: makeMember({ id: 2 }) });
    await userEvent.click(screen.getByRole("button", { name: "Refresh authentication" }));
    await screen.findByRole("button", { name: `Retain ${role}` });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText(role === "task" ? task.title : project.title)).not.toBeInTheDocument();
  });

  it("expires nested inspection and detail queues without blocking a new identity's workflow close", async () => {
    mocked.getMembers.mockResolvedValue([makeMember({ id: 1 }), makeMember({ id: 2 })]);
    mocked.getTask.mockRejectedValue(new Error("read offline"));
    renderWithProviders(<><IdentityControls /><InspectionControls /><Controls /></>, { locale: "en" });
    await userEvent.click(screen.getByRole("button", { name: "Member 1" }));
    await screen.findByText("Member: 1");
    await userEvent.click(screen.getByRole("button", { name: "Open detail queue" }));
    await userEvent.click(screen.getByRole("button", { name: "Retain task" }));
    await userEvent.click(screen.getByRole("button", { name: "Open task" }));
    await screen.findByRole("textbox", { name: "Planned for" });
    fireEvent.click(screen.getByRole("button", { name: "Inspect prerequisite", hidden: true }));
    expect(JSON.parse(screen.getByTestId("inspection-state").textContent ?? "")).toMatchObject({ inspections: 1, detail: 9 });
    await userEvent.click(screen.getByRole("button", { name: "Member 2" }));
    const empty = { task: null, project: null, inspections: 0, detail: null, queue: false, suspended: false };
    expect(JSON.parse(screen.getByTestId("inspection-state").textContent ?? "")).toEqual(empty);
    mocked.getTask.mockResolvedValue({ ...task, revision: 3, title: "New identity task" });
    await userEvent.click(screen.getByRole("button", { name: "Open task" }));
    await screen.findByRole("textbox", { name: "Planned for" });
    fireEvent.click(screen.getByRole("button", { name: "Run expired callbacks", hidden: true }));
    expect(JSON.parse(screen.getByTestId("inspection-state").textContent ?? "")).toEqual({ ...empty, task: task.id });
    expect(mocked.getTask).not.toHaveBeenCalledWith(99);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(JSON.parse(screen.getByTestId("inspection-state").textContent ?? "")).toEqual(empty);
    await userEvent.click(screen.getByRole("button", { name: "Member 1" }));
    await userEvent.click(screen.getByRole("button", { name: "Run expired callbacks" }));
    expect(JSON.parse(screen.getByTestId("inspection-state").textContent ?? "")).toEqual(empty);
  });

  it.each([
    ["task", 401], ["task", 403], ["task", 404],
    ["project", 401], ["project", 403], ["project", 404],
  ] as const)("suppresses confirmed %s input on HTTP %s until an authorized read recovers", async (role, status) => {
    if (role === "task") mocked.getTask.mockRejectedValue(new ApiError(status, "No longer accessible"));
    else mocked.getProject.mockRejectedValue(new ApiError(status, "No longer accessible"));
    renderWithProviders(<Controls />, { locale: "en" });
    await userEvent.click(screen.getByRole("button", { name: `Retain ${role}` }));
    await userEvent.click(screen.getByRole("button", { name: role === "task" ? "Open task" : "Defer project" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Something went wrong");
    expect(within(dialog).queryByText(role === "task" ? task.title : project.title)).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("textbox")).not.toBeInTheDocument();
    if (role === "task") mocked.getTask.mockResolvedValue({ ...task, revision: 3 });
    else mocked.getProject.mockResolvedValue({ ...project, revision: 3, tasks: [] });
    await userEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    if (role === "task") await screen.findByRole("textbox", { name: "Planned for" });
    else await screen.findByText(project.title);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each(["task", "project"] as const)("keeps confirmed %s input usable on HTTP 503 without pretending the read succeeded", async role => {
    mocked.getTask.mockRejectedValue(new ApiError(503, "Unavailable"));
    mocked.getProject.mockRejectedValue(new ApiError(503, "Unavailable"));
    renderWithProviders(<Controls />, { locale: "en" });
    await userEvent.click(screen.getByRole("button", { name: `Retain ${role}` }));
    await userEvent.click(screen.getByRole("button", { name: role === "task" ? "Open task" : "Defer project" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong");
    if (role === "task") expect(screen.getByRole("textbox", { name: "Planned for" })).toBeInTheDocument();
    else expect(screen.getByText(project.title)).toBeInTheDocument();
  });

  it("keeps project receipt metadata separate from authoritative task/detail collections", async () => {
    const mutationOnlyChild = makeTask({ id: 90, title: "Mutation-only child" });
    const actualChild = makeTask({ id: 91, title: "Actual read child" });
    const receipt = { ...project, revision: 2, tasks: [mutationOnlyChild], hierarchyRevisions: [{ id: 90, revision: 1 }] };
    mocked.updateProject.mockResolvedValue(receipt);
    renderWithProviders(<><Controls /><ProjectReceiptProbe detail={{ ...project, tasks: [actualChild] }} /></>);
    await userEvent.click(screen.getByRole("button", { name: "Retain project" }));
    const values = JSON.parse(screen.getByTestId("project-receipt").textContent ?? "");
    expect(values.confirmed).not.toHaveProperty("tasks");
    expect(values.confirmed).not.toHaveProperty("hierarchyRevisions");
    expect(values.projected.tasks.map((child: { id: number }) => child.id)).toEqual([actualChild.id]);
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
