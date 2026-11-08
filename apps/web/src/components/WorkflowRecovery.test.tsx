import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, type ProjectDetail } from "../lib/api";
import { useTaskWorkflow } from "../lib/taskWorkflowContext";
import { useProjectWorkflow } from "../lib/projectWorkflowContext";
import { useTaskActions } from "../lib/useTaskActions";
import { useProjectActions, useProjectDetailQuery } from "../lib/useProjectActions";
import { useRefresh } from "../lib/refresh";
import { useIdentity } from "../lib/identity";
import { useTaskDetail, type TaskDetailHandoff } from "../lib/taskDetailContext";
import { makeCriterion, makeMember, makeProject, makeTask } from "../test/fixtures";
import { renderWithProviders } from "../test/testUtils";
import { TaskWorkflowHost } from "./TaskWorkflowHost";
import { ProjectWorkflowHost } from "./ProjectWorkflowHost";
import { IdentityGate } from "./IdentityGate";
import { TaskDetailSheet } from "./TaskDetailSheet";
import { ProjectDetailPage } from "../pages/ProjectDetailPage";
import { request } from "../lib/api";

vi.mock("../lib/api", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/api")>(), api: {
  getMembers: vi.fn(), getTask: vi.fn(), getProject: vi.fn(), getAuthStatus: vi.fn(),
  getTags: vi.fn().mockResolvedValue([]),
  getPhysicalContexts: vi.fn().mockResolvedValue([]),
  searchTasks: vi.fn().mockResolvedValue([]),
  getProjects: vi.fn().mockResolvedValue([]),
  previewTaskUpdate: vi.fn().mockResolvedValue({ decision: null, activatingProjects: [] }),
  updateTask: vi.fn(), updateProject: vi.fn(), activateProject: vi.fn(), completeProject: vi.fn(),
  returnProjectToBacklog: vi.fn(),
  createTaskStepBatchForTask: vi.fn(),
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
      <button onClick={() => taskWorkflow.open("split", task.id)}>Split task</button>
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

function CrossReaderControls({ role }: { role: "task" | "project" }) {
  const detail = useTaskDetail();
  const workflow = useTaskWorkflow();
  const [page, setPage] = useState(false);
  return <>
    <button onClick={() => role === "task" ? detail.open(task.id) : setPage(true)}>Read detail</button>
    <button onClick={() => { detail.close(); setPage(false); }}>Leave detail</button>
    <button onClick={() => { workflow.suspendForDetail(null); detail.open(99); workflow.open("plan", task.id, "scheduled"); }}>Suspend and reopen</button>
    <Controls />
    <TaskDetailSheet />
    {page ? <Routes><Route path="/projects/:id" element={<ProjectDetailPage />} /></Routes> : null}
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
  const query = useProjectDetailQuery(detail.id);
  return <output data-testid="project-receipt">{JSON.stringify({
    cached: query.data,
    projected: actions.projectStory(query.data ?? detail),
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
afterEach(() => vi.unstubAllGlobals());

describe("focused workflow read recovery", () => {
  it.each(["defer", "deadline", "activation"] as const)(
    "%s isolates each project opening from a cached next-target receipt and a late prior save",
    async kind => {
      const a = makeProject({ id: 42, title: "Opening A", status: kind === "defer" ? "active" : "backlog",
        dueDate: "2027-01-01", ownerMemberId: 1 });
      const b = makeProject({ id: 43, title: "Opening B", status: kind === "defer" ? "active" : "backlog",
        dueDate: "2027-02-01", ownerMemberId: 2 });
      const requirement = (id: number, title: string) => ({
        targetRevision: 1, expectedProjects: [{ projectId: id, revision: 1 }],
        projects: [{ projectId: id, title, revision: 1, ownerMemberId: null,
          required: ["driver", "progressPath"] as Array<"driver" | "progressPath"> }],
      });
      const aDetail: ProjectDetail = { ...a, tasks: [],
        activationDecisionSnapshot: requirement(42, "A activation requirements"),
        directActivationDecisionSnapshot: requirement(42, "A activation requirements") };
      const bSnapshot = { ...requirement(43, "B activation requirements"), targetRevision: 2,
        expectedProjects: [{ projectId: 43, revision: 2 }],
        projects: [{ ...requirement(43, "B activation requirements").projects[0]!, revision: 2 }] };
      const bDetail: ProjectDetail = { ...b, revision: 2, tasks: [],
        activationDecisionSnapshot: bSnapshot, directActivationDecisionSnapshot: bSnapshot };
      const projectsById = new Map([[42, aDetail], [43, bDetail]]);
      mocked.getProject.mockImplementation(async id => projectsById.get(id)!);
      mocked.updateProject.mockImplementation(async id => ({ ...projectsById.get(id)!, revision: 2, notes: "confirmed B" }));
      const priorSave = deferred<never>();
      const actionKind = kind === "activation" ? "activateWithDriver" : kind;

      function Openings() {
        const actions = useProjectActions();
        const workflow = useProjectWorkflow();
        return <>
          <button onClick={() => void actions.update(b, { notes: "receipt" }, { notes: "receipt" }, true)}>Cache B receipt</button>
          <output data-testid="opening-b-receipt">{actions.getCachedProject(43)?.notes ?? "none"}</output>
          <button onClick={() => workflow.open(actionKind, 42)}>Open A</button>
          <button onClick={() => workflow.open(actionKind, 43)}>Open B</button>
          <ProjectWorkflowHost />
        </>;
      }

      if (kind === "defer") mocked.returnProjectToBacklog.mockReturnValueOnce(priorSave.promise);
      if (kind === "deadline") mocked.updateProject.mockImplementation(async id =>
        id === 42 ? priorSave.promise : ({ ...projectsById.get(id)!, revision: 2, notes: "confirmed B" }));
      if (kind === "activation") mocked.activateProject.mockReturnValueOnce(priorSave.promise);
      renderWithProviders(<Openings />, { locale: "en" });
      await userEvent.click(screen.getByRole("button", { name: "Cache B receipt" }));
      await waitFor(() => expect(screen.getByTestId("opening-b-receipt")).toHaveTextContent("none"));
      await userEvent.click(screen.getByRole("button", { name: "Open A" }));
      await screen.findByText("Opening A");

      if (kind === "defer") {
        const withdraw = await screen.findByLabelText(/withdraw plans/i);
        await userEvent.click(withdraw);
        expect(withdraw).toBeChecked();
        await userEvent.click(screen.getByRole("button", { name: "Tomorrow" }));
      } else if (kind === "deadline") {
        const due = await screen.findByLabelText("Due");
        const aInitialDate = (due as HTMLInputElement).value;
        await userEvent.clear(due);
        await userEvent.type(due, "2027-03-01{Enter}");
        await waitFor(() => expect(mocked.updateProject).toHaveBeenCalled());
        expect((due as HTMLInputElement).value).toBe("03/01/2027");
        expect(aInitialDate).not.toBe("");
      } else {
        await userEvent.selectOptions(await screen.findByLabelText("Lead for “A activation requirements”"), "1");
        await userEvent.type(screen.getByLabelText(/concrete next/i), "A-only next action");
        await userEvent.click(screen.getByRole("button", { name: "Start project" }));
        await waitFor(() => expect(mocked.activateProject).toHaveBeenCalled());
      }

      await userEvent.click(screen.getByRole("button", { name: "Open B" }));
      if (kind === "defer") {
        const withdraw = await screen.findByLabelText(/withdraw plans/i);
        expect(withdraw).not.toBeChecked();
        expect(within(screen.getByRole("dialog")).getByText("Opening B")).toBeInTheDocument();
      } else if (kind === "deadline") {
        const due = await screen.findByLabelText("Due");
        expect(due).toHaveValue("02/01/2027");
        expect(due).toBeEnabled();
      } else {
        await waitFor(() => expect(mocked.getProject).toHaveBeenCalledWith(43, expect.any(AbortSignal)));
        expect(await screen.findByLabelText("Lead for “B activation requirements”")).toHaveValue("");
        expect(screen.getByLabelText(/concrete next/i)).toHaveValue("");
      }

      await act(async () => {
        if (kind === "defer") priorSave.resolve({} as never);
        else if (kind === "deadline") priorSave.resolve({ ...aDetail, revision: 2 } as never);
        else priorSave.resolve({ ...aDetail, revision: 2 } as never);
      });
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      if (kind === "defer") expect(screen.getByLabelText(/withdraw plans/i)).not.toBeChecked();
      if (kind === "deadline") expect(screen.getByLabelText("Due")).toHaveValue("02/01/2027");
      if (kind === "activation") expect(screen.getByLabelText(/concrete next/i)).toHaveValue("");
    },
  );

  it("fifth review: a newer parent receipt preserves fetched child membership and newer child revisions in the actual host", async () => {
    const oldChild = makeTask({ id: 81, parentTaskId: task.id, title: "Receipt-only child" });
    const staleChild = makeTask({ id: 82, parentTaskId: task.id, title: "Old receipt child", revision: 1 });
    const freshChild = { ...staleChild, title: "New fetched child", revision: 3 };
    const addedChild = makeTask({ id: 83, parentTaskId: task.id, title: "New fetched membership" });
    mocked.updateTask.mockResolvedValue({ ...task, revision: 2, children: [oldChild, staleChild] });
    mocked.getTask.mockResolvedValue({ ...task, revision: 1, children: [freshChild, addedChild] });
    mocked.createTaskStepBatchForTask.mockResolvedValue({ tasks: [] });
    renderWithProviders(<Controls />, { locale: "en" });
    await userEvent.click(screen.getByRole("button", { name: "Retain task" }));
    await userEvent.click(screen.getByRole("button", { name: "Split task" }));
    await screen.findByText(freshChild.title);
    expect(screen.getByText(addedChild.title)).toBeInTheDocument();
    expect(screen.queryByText(oldChild.title)).not.toBeInTheDocument();
    expect(screen.queryByText(staleChild.title)).not.toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText("Step …"), "New authored child");
    await userEvent.click(screen.getByRole("button", { name: "Create 1 subtask" }));
    await waitFor(() => expect(mocked.createTaskStepBatchForTask).toHaveBeenCalledWith(task.id,
      expect.objectContaining({ expectedRevision: 2 })));
  });
  it("rejects an old suspended same-ID workflow success after the new foreground reader denies", async () => {
    const old = deferred<typeof task>();
    let targetReads = 0;
    mocked.getTask.mockImplementation(async id => {
      if (id === 99) return makeTask({ id: 99, title: "Inspected task" });
      if (++targetReads === 1) return old.promise;
      throw new ApiError(403, "Denied");
    });
    renderWithProviders(<CrossReaderControls role="task" />, { locale: "en" });
    fireEvent.click(screen.getByRole("button", { name: "Open task" }));
    await waitFor(() => expect(targetReads).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "Suspend and reopen", hidden: true }));
    await waitFor(() => expect(targetReads).toBe(2));
    await screen.findAllByRole("alert", { hidden: true });
    await act(async () => old.resolve(task));
    expect(screen.queryByLabelText("Planned for")).not.toBeInTheDocument();
  });

  it.each(["selected", "cookie"] as const)("ignores a real old transport 401 after %s identity ABA, but honors a current 401", async (mode) => {
    mocked.getMembers.mockResolvedValue([makeMember({ id: 1 }), makeMember({ id: 2 })]);
    if (mode === "cookie") mocked.getAuthStatus.mockResolvedValue({ enabled: true, authenticated: true, member: makeMember({ id: 1 }) });
    renderWithProviders(<><IdentityControls /><AuthControls /><Controls /></>, { locale: "en" });
    await screen.findByText(mode === "cookie" ? "Member: 1" : "Member:");
    if (mode === "selected") await userEvent.click(screen.getByRole("button", { name: "Member 1" }));
    const old = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(old.promise));
    const pending = request("/tasks/1").catch(cause => cause);
    if (mode === "selected") {
      await userEvent.click(screen.getByRole("button", { name: "Member 2" }));
      await userEvent.click(screen.getByRole("button", { name: "Member 1" }));
    } else {
      mocked.getAuthStatus.mockResolvedValue({ enabled: true, authenticated: true, member: makeMember({ id: 2 }) });
      await userEvent.click(screen.getByRole("button", { name: "Refresh authentication" }));
      await screen.findByText("Member: 2");
      mocked.getAuthStatus.mockResolvedValue({ enabled: true, authenticated: true, member: makeMember({ id: 1 }) });
      await userEvent.click(screen.getByRole("button", { name: "Refresh authentication" }));
      await screen.findByText("Member: 1");
    }
    await userEvent.click(screen.getByRole("button", { name: "Open task" }));
    const editor = await screen.findByRole("textbox", { name: "Planned for" });
    await act(async () => { old.resolve(new Response("{}", { status: 401 })); await pending; });
    expect(screen.getByRole("textbox", { name: "Planned for" })).toBe(editor);
    expect(screen.getByText("Member: 1")).toBeInTheDocument();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 401 })));
    await act(async () => { await request("/tasks/1").catch(() => {}); });
    expect(screen.queryByRole("textbox", { name: "Planned for" })).not.toBeInTheDocument();
  });

  it.each([false, true])("rejects a Planning preview continuation after denial (restored: %s)", async restored => {
    const projectTask = { ...task, projectId: project.id };
    mocked.getTask.mockResolvedValue(projectTask);
    const preview = deferred<Awaited<ReturnType<typeof api.previewTaskUpdate>>>();
    mocked.previewTaskUpdate.mockReturnValue(preview.promise);
    renderWithProviders(<CrossReaderControls role="task" />, { locale: "en" });
    await userEvent.click(screen.getByRole("button", { name: "Open task" }));
    const editor = await screen.findByRole("textbox", { name: "Planned for" });
    fireEvent.change(editor, { target: { value: "2026-12-05" } });
    fireEvent.blur(editor);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocked.previewTaskUpdate).toHaveBeenCalledOnce());
    mocked.getTask.mockRejectedValue(new ApiError(403, "Read denied"));
    fireEvent.click(screen.getByRole("button", { name: "Read detail", hidden: true }));
    await screen.findByRole("alert");
    if (restored) {
      mocked.getTask.mockResolvedValue({ ...projectTask, revision: 2 });
      fireEvent.click(screen.getAllByRole("button", { name: "Try again", hidden: true }).at(-1)!);
      await waitFor(() => expect(mocked.getTask).toHaveBeenCalledTimes(3));
    }
    await act(async () => preview.resolve({ activatingProjects: [], decision: null } as never));
    expect(mocked.updateTask).not.toHaveBeenCalled();
  });

  it.each([["task", 403], ["task", 404], ["project", 403], ["project", 404]] as const)(
    "%s detail HTTP %s revokes the shared command receipt for subsequent offline workflows", async (role, status) => {
      renderWithProviders(<CrossReaderControls role={role} />, { locale: "en", initialEntries: ["/projects/2"] });
      await userEvent.click(screen.getByRole("button", { name: `Retain ${role}` }));
      mocked[role === "task" ? "getTask" : "getProject"].mockRejectedValue(new ApiError(status, "Read denied"));
      fireEvent.click(screen.getByRole("button", { name: "Read detail" }));
      await screen.findByRole("alert");
      fireEvent.click(screen.getByRole("button", { name: "Leave detail", hidden: true }));
      mocked[role === "task" ? "getTask" : "getProject"].mockRejectedValue(new Error("read offline"));
      fireEvent.click(screen.getByRole("button", { name: `Open ${role}` }));
      await screen.findByText(/read offline/);
      expect(screen.queryByRole("textbox", { name: "Planned for" })).not.toBeInTheDocument();
      expect(screen.queryByText(project.title)).not.toBeInTheDocument();
    });

  it("hides an already rendered detail when another reader denies, and never reuses its old envelope after restoration", async () => {
    renderWithProviders(<CrossReaderControls role="task" />, { locale: "en" });
    fireEvent.click(screen.getByRole("button", { name: "Read detail" }));
    await screen.findByText(task.title);
    mocked.getTask.mockRejectedValue(new ApiError(403, "Read denied"));
    fireEvent.click(screen.getByRole("button", { name: "Open task", hidden: true }));
    await screen.findByRole("alert");
    expect(screen.queryByText(task.title)).not.toBeInTheDocument();
    mocked.getTask.mockResolvedValue({ ...task, title: "Restored task", revision: 2 });
    await userEvent.click(screen.getAllByRole("button", { name: "Try again" }).at(-1)!);
    await screen.findByRole("textbox", { name: "Planned for" });
    expect(screen.queryByText(task.title)).not.toBeInTheDocument();
  });

  it("does not render a detail GET that resolves after a same-ID workflow denial", async () => {
    const old = deferred<typeof task>();
    mocked.getTask.mockReturnValueOnce(old.promise).mockRejectedValue(new ApiError(403, "Read denied"));
    renderWithProviders(<CrossReaderControls role="task" />, { locale: "en" });
    fireEvent.click(screen.getByRole("button", { name: "Read detail" }));
    await waitFor(() => expect(mocked.getTask).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Open task", hidden: true }));
    await screen.findByRole("alert");
    await act(async () => old.resolve(task));
    expect(screen.queryByText(task.title)).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Planned for" })).not.toBeInTheDocument();
  });

  it("reconciles a revision-advancing read retry without replacing the failed Planning draft", async () => {
    renderWithProviders(<Controls />, { locale: "en" });
    await userEvent.click(screen.getByRole("button", { name: "Open task" }));
    const editor = await screen.findByRole("textbox", { name: "Planned for" });
    fireEvent.change(editor, { target: { value: "2026-12-05" } });
    fireEvent.blur(editor);
    const draft = (editor as HTMLInputElement).value;
    mocked.updateTask.mockRejectedValue(new Error("save offline"));
    mocked.getTask.mockRejectedValue(new Error("read offline"));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("save offline");
    fireEvent.click(screen.getByRole("button", { name: "Refresh read" }));
    await screen.findByText(/read offline/);
    mocked.getTask.mockResolvedValue({ ...task, revision: 2, externalWait: { waitingFor: "Recovered wait", revisitDate: null } });
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByText(/read offline/)).not.toBeInTheDocument());
    expect(screen.getByRole("textbox", { name: "Planned for" })).toBe(editor);
    expect(editor).toHaveValue(draft);
    expect(screen.getByText("save offline")).toBeInTheDocument();
    expect(screen.getByText("Recovered wait")).toBeInTheDocument();
    mocked.updateTask.mockResolvedValue({ ...task, revision: 3, scheduledDate: "2026-12-05" });
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocked.updateTask).toHaveBeenLastCalledWith(task.id, expect.objectContaining({ expectedRevision: 2, scheduledDate: "2026-12-05" })));
  });

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
    expect(screen.getByRole("status")).toBeInTheDocument();
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
    mocked.getProject.mockResolvedValue({ ...project, tasks: [actualChild] });
    renderWithProviders(<><Controls /><ProjectReceiptProbe detail={{ ...project, tasks: [actualChild] }} /></>);
    await userEvent.click(screen.getByRole("button", { name: "Retain project" }));
    await waitFor(() => expect(
      JSON.parse(screen.getByTestId("project-receipt").textContent ?? "").cached?.tasks.map((child: { id: number }) => child.id),
    ).toEqual([actualChild.id]));
    const updated = JSON.parse(screen.getByTestId("project-receipt").textContent ?? "");
    expect(updated.cached.tasks.map((child: { id: number }) => child.id)).toEqual([actualChild.id]);
    expect(updated.cached.hierarchyRevisions ?? []).not.toContainEqual({ id: 90, revision: 1 });
    expect(updated.projected.tasks.map((child: { id: number }) => child.id)).toEqual([actualChild.id]);
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
