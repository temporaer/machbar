import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, type ProjectDetail } from "../lib/api";
import { useTaskActions } from "../lib/useTaskActions";
import { useProjectActions } from "../lib/useProjectActions";
import { useTaskWorkflow } from "../lib/taskWorkflowContext";
import { useProjectWorkflow } from "../lib/projectWorkflowContext";
import { makeMember, makeProject, makeTask } from "../test/fixtures";
import { renderWithProviders } from "../test/testUtils";
import { TaskWorkflowHost } from "./TaskWorkflowHost";
import { ProjectWorkflowHost } from "./ProjectWorkflowHost";
import { ProjectTaskEntrySheet } from "./ProjectTaskEntrySheet";
import { TaskSplitSheet } from "./TaskSplitSheet";
import { MoveTaskSheet } from "./MoveTaskSheet";
import { MoveProjectSheet } from "./MoveProjectSheet";
import { ProjectActivationSheet } from "./ProjectActivationSheet";
import { ProjectDeadlineSheet } from "./ProjectDeadlineSheet";
import { TaskConvertToProjectSheet } from "./TaskConvertToProjectSheet";
import { TaskPlanningSheet } from "./TaskPlanningSheet";
import { ProjectConvertToTaskSheet } from "./ProjectConvertToTaskSheet";
import { useState } from "react";

vi.mock("../lib/api", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/api")>(),
  api: {
    getMembers: vi.fn(), getAuthStatus: vi.fn(), getTask: vi.fn(), getProject: vi.fn(),
    getProjects: vi.fn(), getTags: vi.fn().mockResolvedValue([]),
    getPhysicalContexts: vi.fn().mockResolvedValue([]), searchTasks: vi.fn().mockResolvedValue([]),
    previewTaskUpdate: vi.fn(), updateTask: vi.fn(), updateProject: vi.fn(), activateProject: vi.fn(),
    previewProjectSteps: vi.fn(), previewTaskSteps: vi.fn(),
    createTaskStepBatchForProject: vi.fn(), createTaskStepBatchForTask: vi.fn(),
    moveTask: vi.fn(), moveProject: vi.fn(),
    previewTaskConversion: vi.fn(), convertTaskToStory: vi.fn(), convertStoryToTask: vi.fn(),
  },
}));

// Exercise the gap after the canonical reader qualifies a result, before
// its consumer publishes local state. The intervening reads use real guards.
let revokeAfterQualification = false;
vi.mock("../lib/useProjectActions", async importOriginal => {
  const actual = await importOriginal<typeof import("../lib/useProjectActions")>();
  return {
    ...actual,
    useProjectActions: (...args: Parameters<typeof actual.useProjectActions>) => {
      const actions = actual.useProjectActions(...args);
      const intervene = async (id: number) => {
        if (!revokeAfterQualification || id !== 42) return;
        revokeAfterQualification = false;
        await actions.getProject(id).catch(() => {});
        const fresh = await actions.readProject(id);
        const release = actions.pauseRetention(id);
        actions.observeConfirmedStory(fresh.value, fresh.read);
        release();
      };
      return {
        ...actions,
        getProject: async (...args: Parameters<typeof actions.getProject>) => {
          const [id] = args;
          const value = await actions.getProject(...args);
          await intervene(id);
          return value;
        },
        readProject: async (...args: Parameters<typeof actions.readProject>) => {
          const [id] = args;
          const result = await actions.readProject(...args);
          await intervene(id);
          return result;
        },
      };
    },
  };
});

const mocked = vi.mocked(api, true);
const task = makeTask({ id: 7, title: "Acceptance task", scheduledDate: "2027-01-01" });
const project = makeProject({ id: 42, title: "Acceptance project", status: "backlog", ownerMemberId: 1 });
const snapshot = (revision: number) => ({
  targetRevision: revision,
  expectedProjects: [{ projectId: 42, revision }],
  projects: [{ projectId: 42, title: project.title, revision, ownerMemberId: null, required: ["driver", "progressPath"] as Array<"driver" | "progressPath"> }],
});
function detail(revision = 1): ProjectDetail {
  return { ...project, revision, tasks: [], activationDecisionSnapshot: snapshot(revision), directActivationDecisionSnapshot: snapshot(revision) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function Controls() {
  const tasks = useTaskActions();
  const projects = useProjectActions();
  const taskWorkflow = useTaskWorkflow();
  const projectWorkflow = useProjectWorkflow();
  return <>
    <button onClick={() => taskWorkflow.open("plan", task.id, "scheduled")}>Open planner</button>
    <button onClick={() => projectWorkflow.open("defer", project.id)}>Open defer</button>
    <button onClick={() => projectWorkflow.open("activateWithDriver", project.id)}>Open activation</button>
    <button onClick={() => projectWorkflow.open("deadline", project.id)}>Open deadline</button>
    <button onClick={() => void tasks.getTask(task.id).catch(() => {})}>Other task reader</button>
    <button onClick={() => void projects.getProject(project.id).catch(() => {})}>Other project reader</button>
    <output data-testid="opening">{taskWorkflow.current?.kind ?? projectWorkflow.current?.kind ?? "closed"}</output>
    <TaskWorkflowHost /><ProjectWorkflowHost />
  </>;
}

beforeEach(() => {
  vi.resetAllMocks();
  revokeAfterQualification = false;
  localStorage.clear();
  mocked.getMembers.mockResolvedValue([makeMember({ id: 1, name: "Mira" })]);
  mocked.getAuthStatus.mockResolvedValue({ enabled: false, authenticated: false, member: null });
  mocked.getTask.mockResolvedValue(task);
  mocked.getProject.mockResolvedValue(detail());
  mocked.getProjects.mockResolvedValue([project]);
  mocked.getTags.mockResolvedValue([]);
  mocked.searchTasks.mockResolvedValue([]);
  mocked.previewTaskUpdate.mockResolvedValue({ activatingProjects: [], decision: null });
  mocked.previewProjectSteps.mockResolvedValue({ activatingProjects: [], decision: null });
  mocked.previewTaskSteps.mockResolvedValue({ activatingProjects: [], decision: null });
});

describe("recovery actual-diff acceptance", () => {
  it("a held destination retry cannot clear a newer destination's matching failure", async () => {
    const source = { ...detail(), ancestors: [] };
    const first = { ...makeProject({ id: 43, title: "Destination A" }), tasks: [],
      ancestors: [{ id: 88, role: "story" as const, title: "Ancestor X" }] };
    const second = { ...makeProject({ id: 44, title: "Destination B" }), tasks: [],
      ancestors: [{ id: 89, role: "story" as const, title: "Ancestor Y" }] };
    const oldRetry = deferred<ProjectDetail>();
    let xReads = 0;
    mocked.getProjects.mockResolvedValue([source, first, second]);
    mocked.getProject.mockImplementation(async id => {
      if (id === 88) {
        if (++xReads === 3) return oldRetry.promise;
        throw new ApiError(403, "Ancestor X denied");
      }
      if (id === 89) throw new ApiError(403, "Ancestor Y denied");
      return id === 42 ? source : id === 43 ? first : second;
    });
    function Reader() {
      const actions = useProjectActions();
      const [denied, setDenied] = useState<number | null>(null);
      return <>
        <button onClick={() => void actions.getProject(88).catch(() => setDenied(88))}>Deny X</button>
        <button onClick={() => void actions.getProject(89).catch(() => setDenied(89))}>Deny Y</button>
        <output data-testid="retry-race-denied">{denied}</output>
        <MoveProjectSheet story={source} onClose={vi.fn()} />
      </>;
    }
    renderWithProviders(<Reader />, { locale: "en" });
    await userEvent.click(await screen.findByRole("button", { name: "Destination A" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Move here" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Deny X", hidden: true }));
    await waitFor(() => expect(screen.getByTestId("retry-race-denied")).toHaveTextContent("88"));
    await userEvent.click(screen.getByRole("button", { name: "Move here" }));
    await screen.findByRole("alert");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(xReads).toBe(3));
    await userEvent.click(screen.getByRole("button", { name: "Destination B" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Move here" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Deny Y", hidden: true }));
    await waitFor(() => expect(screen.getByTestId("retry-race-denied")).toHaveTextContent("89"));
    await userEvent.click(screen.getByRole("button", { name: "Move here" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Move here" })).toBeDisabled();
    await act(async () => oldRetry.resolve({ ...makeProject({ id: 88 }), tasks: [] }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Move here" })).toBeDisabled();
    expect(mocked.moveProject).not.toHaveBeenCalled();
  });

  it.each([false, true])("eighth review: move scopes a failed destination ancestor to the current source/destination chain (source still affected: %s)", async sourceAffected => {
    const ancestor = { id: 88, role: "story" as const, title: "Denied ancestor" };
    const source = { ...detail(), ancestors: sourceAffected ? [ancestor] : [] };
    const first = { ...makeProject({ id: 43, title: "Destination A" }), tasks: [], ancestors: [ancestor] };
    const second = { ...makeProject({ id: 44, title: "Destination B" }), tasks: [], ancestors: [] };
    mocked.getProjects.mockResolvedValue([source, first, second]);
    mocked.getProject.mockImplementation(async id => {
      if (id === 88) throw new ApiError(403, "Affected project remains denied");
      return id === 42 ? source : id === 43 ? first : second;
    });
    function Reader() {
      const actions = useProjectActions();
      const [denied, setDenied] = useState(false);
      return <><button onClick={() => void actions.getProject(88).catch(() => setDenied(true))}>Deny ancestor</button>
        <output data-testid="move-denied">{String(denied)}</output>
        <output data-testid="move-canonical-readable">{String(actions.isTargetReadable(88))}</output>
        <MoveProjectSheet story={source} onClose={vi.fn()} /></>;
    }
    renderWithProviders(<Reader />, { locale: "en" });
    await userEvent.click(await screen.findByRole("button", { name: "Destination A" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Move here" })).toBeEnabled());
    const editor = screen.getByRole("searchbox");
    await userEvent.type(editor, "Destination");
    fireEvent.click(screen.getByRole("button", { name: "Deny ancestor", hidden: true }));
    await waitFor(() => expect(screen.getByTestId("move-denied")).toHaveTextContent("true"));
    await userEvent.click(screen.getByRole("button", { name: "Move here" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Move here" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(mocked.getProject.mock.calls.filter(([id]) => id === 88)).toHaveLength(3));
    expect(screen.getByRole("button", { name: "Move here" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Destination B" }));
    await waitFor(() => expect(mocked.getProject).toHaveBeenCalledWith(44));
    await waitFor(() => {
      if (sourceAffected) expect(screen.getByRole("button", { name: "Move here" })).toBeDisabled();
      else expect(screen.getByRole("button", { name: "Move here" })).toBeEnabled();
    });
    expect(editor).toBeInTheDocument();
    expect(editor).toHaveValue("Destination");
    expect(screen.getByTestId("move-canonical-readable")).toHaveTextContent("false");
    expect(mocked.moveProject).not.toHaveBeenCalled();
    if (sourceAffected) {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    } else {
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Move here" }));
      await waitFor(() => expect(mocked.moveProject).toHaveBeenCalledWith(42, expect.objectContaining({ parentId: 44 })));
      expect(mocked.getProject.mock.calls.filter(([id]) => id === 88)).toHaveLength(3);
    }
  });

  it.each([["split", 403], ["entry", 404]] as const)("eighth review: %s installs a fresh containing-project baseline after its own %s revalidation denial", async (kind, status) => {
    const id = kind === "split" ? 88 : 42;
    const actual = { ...makeProject({ id }), tasks: [], ancestors: [] };
    const obsolete = deferred<ProjectDetail>();
    let reads = 0;
    mocked.getProject.mockImplementation(async target => {
      if (target !== id) return { ...makeProject({ id: target }), tasks: [] };
      reads++;
      if (reads === 1 || reads === 3 || reads === 4 || reads === 6) throw new ApiError(status, "Containing project denied");
      if (reads === 5) return obsolete.promise;
      return { ...actual, revision: reads >= 5 ? 2 : 1 };
    });
    mocked.createTaskStepBatchForProject.mockResolvedValue({ project: { ...actual, revision: 3 }, tasks: [] });
    mocked.createTaskStepBatchForTask.mockResolvedValue({ parent: task, tasks: [] });
    function Reader() {
      const actions = useProjectActions();
      const [open, setOpen] = useState(false);
      const [otherDenied, setOtherDenied] = useState(false);
      return <><button onClick={() => void actions.getProject(id).catch(() => setOpen(true))}>Prepare denied target</button>
        <button onClick={() => void actions.getProject(id).catch(() => setOtherDenied(true))}>Other target denial</button>
        <output data-testid="containing-other-denied">{String(otherDenied)}</output>
        {open ? kind === "split"
          ? <TaskSplitSheet parentId={task.id} parentRevision={1} projectId={id} onClose={vi.fn()} />
          : <ProjectTaskEntrySheet project={actual} onClose={vi.fn()} /> : null}</>;
    }
    renderWithProviders(<Reader />, { locale: "en" });
    fireEvent.click(screen.getByRole("button", { name: "Prepare denied target" }));
    const editor = await screen.findByPlaceholderText("Step …");
    await userEvent.type(editor, "Exact retained step");
    const name = kind === "split" ? "Create 1 subtask" : "Add task";
    await waitFor(() => expect(screen.getByRole("button", { name })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name }));
    await waitFor(() => expect(reads).toBe(3));
    expect(screen.getByRole("button", { name })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(reads).toBe(4));
    await waitFor(() => expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled());
    expect(screen.getByRole("button", { name })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(reads).toBe(5));
    fireEvent.click(screen.getByRole("button", { name: "Other target denial", hidden: true }));
    await waitFor(() => expect(screen.getByTestId("containing-other-denied")).toHaveTextContent("true"));
    await act(async () => obsolete.resolve({ ...actual, revision: 99, title: "Obsolete recovery title" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled());
    expect(screen.getByRole("button", { name })).toBeDisabled();
    expect(screen.queryByText("Obsolete recovery title")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(reads).toBe(7));
    await waitFor(() => expect(screen.getByRole("button", { name })).toBeEnabled());
    expect(editor).toBeInTheDocument();
    expect(editor).toHaveValue("Exact retained step");
    expect(mocked.previewProjectSteps).not.toHaveBeenCalled();
    expect(mocked.previewTaskSteps).not.toHaveBeenCalled();
    expect(mocked.createTaskStepBatchForProject).not.toHaveBeenCalled();
    expect(mocked.createTaskStepBatchForTask).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name }));
    const command = kind === "split" ? mocked.createTaskStepBatchForTask : mocked.createTaskStepBatchForProject;
    await waitFor(() => expect(command).toHaveBeenCalledWith(kind === "split" ? task.id : id,
      expect.objectContaining({ expectedProjectRevisions: [{ projectId: id, revision: 2 }] })));
  });

  it.each([
    ["move", 403], ["move", 404], ["convert", 403], ["convert", 404],
  ] as const)("seventh review: %s exposes its matching %s revalidation denial and recovers by GET only", async (kind, status) => {
    let denied = true;
    const actual = { ...detail(), parentId: 88, ancestors: [{ id: 88, role: "story" as const, title: "Unavailable ancestor" }] };
    mocked.getProject.mockImplementation(async id => {
      if (id === 88 && denied) throw new ApiError(status, "Ancestor remains denied");
      return id === 42 ? actual : { ...makeProject({ id }), tasks: [] };
    });
    function Reader() {
      const actions = useProjectActions();
      const [denied, setDenied] = useState(false);
      return <><button onClick={() => void actions.getProject(88).catch(() => setDenied(true))}>Deny ancestor</button>
        <output data-testid="preexisting-denial">{String(denied)}</output>
        {kind === "move" ? <MoveProjectSheet story={{ ...actual, parentId: null }} onClose={vi.fn()} />
          : <ProjectConvertToTaskSheet story={actual} onClose={vi.fn()} />}</>;
    }
    renderWithProviders(<Reader />, { locale: "en" });
    const name = kind === "move" ? "Move here" : "Make task";
    await waitFor(() => expect(screen.getByRole("button", { name })).toBeEnabled());
    const editor = kind === "move" ? screen.getByRole("searchbox") : screen.getByLabelText("Title");
    await userEvent.type(editor, kind === "move" ? "Acceptance" : " authored");
    fireEvent.click(screen.getByRole("button", { name: "Deny ancestor", hidden: true }));
    await waitFor(() => expect(screen.getByTestId("preexisting-denial")).toHaveTextContent("true"));
    await userEvent.click(screen.getByRole("button", { name }));
    await waitFor(() => expect(mocked.getProject.mock.calls.filter(([id]) => id === 88)).toHaveLength(2));
    expect(kind === "move" ? mocked.moveProject : mocked.convertStoryToTask).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getAllByRole("alert").length).toBeGreaterThan(0));
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(mocked.getProject.mock.calls.filter(([id]) => id === 88)).toHaveLength(3));
    expect(editor).toBeInTheDocument();
    expect(editor).toHaveValue(kind === "move" ? "Acceptance" : `${actual.title} authored`);
    expect(kind === "move" ? mocked.moveProject : mocked.convertStoryToTask).not.toHaveBeenCalled();
    denied = false;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(mocked.getProject.mock.calls.filter(([id]) => id === 88)).toHaveLength(4));
    await waitFor(() => expect(screen.getByRole("button", { name })).toBeEnabled());
    expect(kind === "move" ? mocked.moveProject : mocked.convertStoryToTask).not.toHaveBeenCalled();
    expect(editor).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name }));
    await waitFor(() => expect(kind === "move" ? mocked.moveProject : mocked.convertStoryToTask).toHaveBeenCalledOnce());
  });

  it("seventh review: equal-revision host conversion authority refreshes the affected chain despite an older local GET", async () => {
    let denied = true;
    const old = { ...detail(), ancestors: [{ id: 88, role: "story" as const, title: "Old ancestor" }] };
    const host = { ...old, revision: 2 };
    const fresh = { ...host, ancestors: [{ id: 89, role: "story" as const, title: "New ancestor" }],
      hierarchyRevisions: [{ id: 42, revision: 2 }, { id: 89, revision: 2 }] };
    mocked.getProject.mockImplementation(async id => {
      if (id === 89 && denied) throw new ApiError(403, "New ancestor denied");
      return id === 42 ? old : { ...makeProject({ id }), tasks: [] };
    });
    function Reader() {
      const actions = useProjectActions();
      const [current, setCurrent] = useState<ProjectDetail | null>(null);
      const [denied, setDenied] = useState(false);
      return <>
        <button onClick={() => {
          mocked.getProject.mockResolvedValueOnce(host);
          void actions.getProject(42).then(setCurrent);
        }}>Host initial</button>
        <button onClick={() => {
          mocked.getProject.mockResolvedValueOnce(fresh);
          void actions.getProject(42).then(setCurrent);
        }}>Host equal</button>
        <button onClick={() => void actions.getProject(89).catch(() => setDenied(true))}>Deny new ancestor</button>
        <output data-testid="new-ancestor-denied">{String(denied)}</output>
        <ProjectConvertToTaskSheet story={old} authoritativeProject={current} onClose={vi.fn()} />
      </>;
    }
    renderWithProviders(<Reader />, { locale: "en" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Make task" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Host initial", hidden: true }));
    await waitFor(() => expect(mocked.getProject).toHaveBeenCalledTimes(2));
    const editor = screen.getByLabelText("Title");
    await userEvent.type(editor, " authored");
    fireEvent.click(screen.getByRole("button", { name: "Host equal", hidden: true }));
    await waitFor(() => expect(mocked.getProject).toHaveBeenCalledTimes(3));
    fireEvent.click(screen.getByRole("button", { name: "Deny new ancestor", hidden: true }));
    await waitFor(() => expect(screen.getByTestId("new-ancestor-denied")).toHaveTextContent("true"));
    await userEvent.click(screen.getByRole("button", { name: "Make task" }));
    await waitFor(() => expect(mocked.getProject.mock.calls.filter(([id]) => id === 89)).toHaveLength(2));
    expect(mocked.convertStoryToTask).not.toHaveBeenCalled();
    expect(editor).toHaveValue(`${old.title} authored`);
    denied = false;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Make task" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Make task" }));
    await waitFor(() => expect(mocked.convertStoryToTask).toHaveBeenCalledWith(42, {
      title: `${old.title} authored`, expectedRevision: 2, expectedHierarchyRevisions: fresh.hierarchyRevisions,
    }));
  });

  it.each(["move", "convert"] as const)("seventh review: %s does not report an obsolete revalidation's late denial as its current operation", async kind => {
    const late = deferred<ProjectDetail>();
    let ancestorReads = 0;
    const actual = { ...detail(), ancestors: [{ id: 88, role: "story" as const, title: "Containing project" }] };
    mocked.getProject.mockImplementation(async id => {
      if (id !== 88) return actual;
      ancestorReads++;
      if (ancestorReads === 2) return late.promise;
      throw new ApiError(403, "Different reader denial");
    });
    function Reader() {
      const actions = useProjectActions();
      const [reads, setReads] = useState(0);
      return <><button onClick={() => void actions.getProject(88).catch(() => {}).finally(() => setReads(value => value + 1))}>Other denial</button>
        <output data-testid="other-denials">{reads}</output>
        {kind === "move" ? <MoveProjectSheet story={actual} onClose={vi.fn()} />
          : <ProjectConvertToTaskSheet story={actual} onClose={vi.fn()} />}</>;
    }
    renderWithProviders(<Reader />, { locale: "en" });
    const name = kind === "move" ? "Move here" : "Make task";
    await waitFor(() => expect(screen.getByRole("button", { name })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Other denial", hidden: true }));
    await waitFor(() => expect(screen.getByTestId("other-denials")).toHaveTextContent("1"));
    await userEvent.click(screen.getByRole("button", { name }));
    await waitFor(() => expect(ancestorReads).toBe(2));
    fireEvent.click(screen.getByRole("button", { name: "Other denial", hidden: true }));
    await waitFor(() => expect(screen.getByTestId("other-denials")).toHaveTextContent("2"));
    await act(async () => late.reject(new ApiError(403, "Obsolete own denial")));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(kind === "move" ? mocked.moveProject : mocked.convertStoryToTask).not.toHaveBeenCalled();
  });

  it("seventh review: lower host authority does not discard a higher local conversion conflict refresh", async () => {
    const old = detail();
    const host = { ...old, revision: 2 };
    const higher = { ...host, revision: 3, notes: "Higher local authority" };
    mocked.getProject.mockResolvedValue(old);
    mocked.convertStoryToTask.mockRejectedValueOnce(new ApiError(409, "Stale", "stale_write_conflict"));
    function Reader() {
      const actions = useProjectActions();
      const [current, setCurrent] = useState<ProjectDetail | null>(null);
      return <><button onClick={() => {
        mocked.getProject.mockResolvedValueOnce({ ...host });
        void actions.getProject(42).then(setCurrent);
      }}>Host detail</button>
        <ProjectConvertToTaskSheet story={old} authoritativeProject={current} onClose={vi.fn()} /></>;
    }
    renderWithProviders(<Reader />, { locale: "en" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Make task" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Host detail", hidden: true }));
    await waitFor(() => expect(mocked.getProject).toHaveBeenCalledTimes(2));
    mocked.getProject.mockResolvedValueOnce(higher);
    await userEvent.click(screen.getByRole("button", { name: "Make task" }));
    await waitFor(() => expect(screen.getByLabelText("Notes")).toHaveValue(higher.notes));
    fireEvent.click(screen.getByRole("button", { name: "Host detail", hidden: true }));
    await waitFor(() => expect(mocked.getProject).toHaveBeenCalledTimes(4));
    expect(screen.getByLabelText("Notes")).toHaveValue(higher.notes);
    await userEvent.click(screen.getByRole("button", { name: "Make task" }));
    await waitFor(() => expect(mocked.convertStoryToTask.mock.calls[1]?.[1]).toHaveProperty("expectedRevision", 3));
  });

  it.each(["planning", "entry", "split", "task conversion"] as const)("seventh review: %s keeps matching ancestor failure visible and offers GET-only draft recovery", async kind => {
    let denied = true;
    const ancestors = [{ id: 89, role: "story" as const, title: "Higher project" },
      { id: 88, role: "story" as const, title: "Containing project", revision: 1 }];
    const actualTask = { ...task, projectId: 88, ancestors, hierarchyRevisions: [{ id: task.id, revision: 1 }, { id: 88, revision: 1 }] };
    const actual = { ...detail(), ancestors };
    mocked.getTask.mockResolvedValue(actualTask);
    mocked.getProject.mockImplementation(async id => {
      if (id === 89 && denied) throw new ApiError(403, "Ancestor remains denied");
      return id === 42 ? actual : { ...makeProject({ id }), tasks: [], ancestors: ancestors.filter(ancestor => ancestor.id !== id) };
    });
    function Reader() {
      const actions = useProjectActions();
      const [revoked, setRevoked] = useState(false);
      return <><button onClick={() => void actions.getProject(89).catch(() => setRevoked(true))}>Deny ancestor</button>
        <output data-testid="sibling-denied">{String(revoked)}</output>
        {kind === "planning" ? <TaskPlanningSheet task={actualTask} onClose={vi.fn()} />
          : kind === "entry" ? <ProjectTaskEntrySheet project={actual} onClose={vi.fn()} />
          : kind === "split" ? <TaskSplitSheet parentId={task.id} parentRevision={1} projectId={88} onClose={vi.fn()} />
          : <TaskConvertToProjectSheet task={actualTask} onClose={vi.fn()} />}</>;
    }
    renderWithProviders(<Reader />, { locale: "en" });
    const editor = kind === "planning" ? screen.getByLabelText("Planned for")
      : kind === "task conversion" ? screen.getByRole("textbox")
      : screen.getByPlaceholderText("Step …");
    if (kind === "planning") {
      fireEvent.change(editor, { target: { value: "2027-01-05" } });
      fireEvent.blur(editor);
    }
    else await userEvent.type(editor, " preserved");
    const name = kind === "planning" ? "Save" : kind === "entry" ? "Add task"
      : kind === "split" ? "Create 1 subtask" : "Convert and start";
    await waitFor(() => expect(screen.getByRole("button", { name })).toBeEnabled());
    const draftValue = (editor as HTMLInputElement).value;
    fireEvent.click(screen.getByRole("button", { name: "Deny ancestor", hidden: true }));
    await waitFor(() => expect(screen.getByTestId("sibling-denied")).toHaveTextContent("true"));
    await userEvent.click(screen.getByRole("button", { name }));
    await waitFor(() => expect(mocked.getProject.mock.calls.filter(([id]) => id === 89)).toHaveLength(2));
    await waitFor(() => expect(screen.getAllByRole("alert").length).toBeGreaterThan(0));
    denied = false;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(mocked.getProject.mock.calls.filter(([id]) => id === 89)).toHaveLength(3));
    expect(editor).toBeInTheDocument();
    expect(editor).toHaveValue(draftValue);
    expect(mocked.updateTask).not.toHaveBeenCalled();
    expect(mocked.createTaskStepBatchForProject).not.toHaveBeenCalled();
    expect(mocked.createTaskStepBatchForTask).not.toHaveBeenCalled();
    expect(mocked.previewTaskUpdate).not.toHaveBeenCalled();
    expect(mocked.previewProjectSteps).not.toHaveBeenCalled();
    expect(mocked.previewTaskSteps).not.toHaveBeenCalled();
    expect(mocked.previewTaskConversion).not.toHaveBeenCalled();
  });

  it.each(["move", "convert"] as const)("sixth review: %s merges a fresh requirement only after deliberate regeneration and preserves the original affected-chain provenance", async kind => {
    let denied = false;
    const ancestor = makeProject({ id: 88, title: "Affected containing project", status: "backlog" });
    const destination = makeProject({ id: 43, title: "Selected destination", parentId: 88 });
    const source = { ...detail(), parentId: 88, status: "active" as const,
      ancestors: [{ id: 88, role: "story" as const, title: ancestor.title, revision: 1 }] };
    mocked.getProjects.mockResolvedValue([project, destination, ancestor]);
    mocked.getProject.mockImplementation(async id => {
      if (id === 88 && denied) throw new ApiError(403, "Affected project denied");
      return id === 42 ? source : { ...(id === 43 ? destination : ancestor), tasks: [],
        ...(id === 43 ? { ancestors: source.ancestors } : {}) };
    });
    const decisions = (title: string, revision: number) => ({ targetRevision: 1,
      expectedProjects: [{ projectId: 88, revision }], projects: [{ projectId: 88, title, revision,
        ownerMemberId: null, required: ["driver", "progressPath"] as Array<"driver" | "progressPath"> }] });
    const write = kind === "move" ? mocked.moveProject : mocked.convertStoryToTask;
    write.mockRejectedValueOnce(new ApiError(409, "Decisions", "project_commitment_resolution_required", decisions("Original private requirements", 1)))
      .mockRejectedValueOnce(new ApiError(409, "Decisions", "project_commitment_resolution_required", decisions("Fresh private requirements", 2)))
      .mockResolvedValue(undefined as never);
    function Reader() {
      const actions = useProjectActions();
      const [reads, setReads] = useState(0);
      return <><button onClick={() => void actions.getProject(88).catch(() => {}).finally(() => setReads(value => value + 1))}>Read affected ancestor</button>
        <output data-testid="ancestor-reads">{reads}</output>
        {kind === "move" ? <MoveProjectSheet story={source} onClose={vi.fn()} />
          : <ProjectConvertToTaskSheet story={source} onClose={vi.fn()} />}</>;
    }
    renderWithProviders(<Reader />, { locale: "en" });
    if (kind === "move") await userEvent.click(await screen.findByRole("button", { name: destination.title }));
    const submitName = kind === "move" ? "Move here" : "Make task";
    await waitFor(() => expect(screen.getByRole("button", { name: submitName })).toBeEnabled());
    const editor = kind === "move" ? screen.getByRole("searchbox") : screen.getByLabelText("Title");
    if (kind === "move") await userEvent.type(editor, "Selected");
    else { await userEvent.clear(editor); await userEvent.type(editor, "Preserved conversion draft"); }
    await userEvent.click(screen.getByRole("button", { name: submitName }));
    await userEvent.selectOptions(await screen.findByLabelText("Lead for “Original private requirements”"), "1");
    await userEvent.type(screen.getByLabelText(/concrete next/i), "Preserved chain decision");
    denied = true;
    fireEvent.click(screen.getByRole("button", { name: "Read affected ancestor", hidden: true }));
    await waitFor(() => expect(screen.getByTestId("ancestor-reads")).toHaveTextContent("1"));
    expect(screen.queryByLabelText("Lead for “Original private requirements”")).not.toBeInTheDocument();
    denied = false;
    fireEvent.click(screen.getByRole("button", { name: "Read affected ancestor", hidden: true }));
    await waitFor(() => expect(screen.getByTestId("ancestor-reads")).toHaveTextContent("2"));
    expect(screen.queryByLabelText("Lead for “Original private requirements”")).not.toBeInTheDocument();
    expect(editor).toBeInTheDocument();
    expect(editor).toHaveValue(kind === "move" ? "Selected" : "Preserved conversion draft");
    expect(write).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: submitName }));
    expect(await screen.findByLabelText("Lead for “Fresh private requirements”")).toHaveValue("1");
    expect(screen.getByLabelText(/concrete next/i)).toHaveValue("Preserved chain decision");
    expect(write.mock.calls[1]![1]).not.toHaveProperty("activationResolution");
    await userEvent.click(screen.getByRole("button", { name: submitName }));
    await waitFor(() => expect(write).toHaveBeenCalledTimes(3));
    expect(write.mock.calls[2]![1]).toHaveProperty("activationResolution.expectedProjects", [{ projectId: 88, revision: 2 }]);
  });

  it.each(["move", "convert", "planning", "entry", "split", "task move"] as const)("sixth review: %s cannot publish an ancestor's requirements denied while its request was pending, even after restoration", async kind => {
    const pending = deferred<never>();
    const actualTask = { ...task, projectId: 88, ancestors: [{ id: 89, role: "story" as const, title: "Higher project" },
      { id: 88, role: "story" as const, title: "Containing project", revision: 1 }] };
    const actual = { ...detail(), parentId: kind === "move" ? 88 : 17, ancestors: kind === "move" ? actualTask.ancestors : [...actualTask.ancestors,
      { id: 17, role: "task" as const, title: "Task parent", revision: 900 }] };
    let denied = false;
    mocked.getProject.mockImplementation(async id => {
      if (id === 89 && denied) throw new ApiError(403, "Ancestor denied");
      return id === 42 ? actual : { ...makeProject({ id, title: "Other project" }), tasks: [],
        ancestors: id === 88 ? actualTask.ancestors.filter(ancestor => ancestor.id === 89) : [] };
    });
    mocked.getTask.mockResolvedValue(actualTask);
    const request = kind === "move" ? mocked.moveProject : kind === "convert" ? mocked.convertStoryToTask
      : kind === "entry" ? mocked.previewProjectSteps : kind === "split" ? mocked.previewTaskSteps
      : kind === "task move" ? mocked.moveTask : mocked.previewTaskUpdate;
    request.mockReturnValueOnce(pending.promise);
    const close = vi.fn();
    function Reader() {
      const actions = useProjectActions();
      const [reads, setReads] = useState(0);
      return <><button onClick={() => void actions.getProject(89).catch(() => {}).finally(() => setReads(value => value + 1))}>Read higher ancestor</button>
        <output data-testid="higher-reads">{reads}</output>
        {kind === "move" ? <MoveProjectSheet story={actual} onClose={close} />
          : kind === "convert" ? <ProjectConvertToTaskSheet story={actual} onClose={close} />
          : kind === "entry" ? <ProjectTaskEntrySheet project={actual} onClose={close} />
          : kind === "split" ? <TaskSplitSheet parentId={task.id} parentRevision={1} projectId={88} onClose={close} />
          : kind === "task move" ? <MoveTaskSheet task={actualTask} onClose={close} />
          : <TaskPlanningSheet task={actualTask} onClose={close} />}</>;
    }
    renderWithProviders(<Reader />, { locale: "en" });
    if (kind === "planning") {
      fireEvent.change(screen.getByLabelText("Planned for"), { target: { value: "2027-01-05" } });
      fireEvent.blur(screen.getByLabelText("Planned for"));
    }
    if (kind === "entry" || kind === "split") {
      await userEvent.type(screen.getByPlaceholderText("Step …"), "Preserved ancestor step");
      await userEvent.click(screen.getByText("Planning (optional)"));
      fireEvent.change(screen.getByLabelText("Due"), { target: { value: "2027-03-01" } });
    }
    const submit = kind === "move" || kind === "task move" ? "Move here" : kind === "convert" ? "Make task"
      : kind === "entry" ? "Add task" : kind === "split" ? "Create 1 subtask" : "Save";
    await waitFor(() => expect(screen.getByRole("button", { name: submit })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: submit }));
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    denied = true;
    fireEvent.click(screen.getByRole("button", { name: "Read higher ancestor", hidden: true }));
    await waitFor(() => expect(screen.getByTestId("higher-reads")).toHaveTextContent("1"));
    denied = false;
    fireEvent.click(screen.getByRole("button", { name: "Read higher ancestor", hidden: true }));
    await waitFor(() => expect(screen.getByTestId("higher-reads")).toHaveTextContent("2"));
    const decision = { targetRevision: 1, expectedProjects: [{ projectId: 89, revision: 1 }],
      projects: [{ projectId: 89, title: "Late sensitive requirements", revision: 1,
        ownerMemberId: null, required: ["driver"] }] };
    await act(async () => {
      if (kind === "task move") pending.resolve({ ...actualTask, revision: 2 } as never);
      else if (kind === "planning" || kind === "entry" || kind === "split") pending.resolve({ activatingProjects: [{ id: 89 }], decision } as never);
      else pending.reject(new ApiError(409, "Decisions", "project_commitment_resolution_required", decision));
    });
    expect(screen.queryByLabelText("Lead for “Late sensitive requirements”")).not.toBeInTheDocument();
    expect(close).not.toHaveBeenCalled();
  });

  it("sixth review: conversion merges every selected authority and conflict choices use the newest detail", async () => {
    const old = { ...detail(), notes: "Initial notes" };
    let received = { ...old, revision: 2, title: "Server title2", notes: "Server notes2" };
    mocked.getProject.mockResolvedValue(old);
    mocked.convertStoryToTask.mockResolvedValue(task);
    function Authority() {
      const actions = useProjectActions();
      const [actual, setActual] = useState<ProjectDetail | null>(null);
      return <><button onClick={() => void actions.getProject(42).then(setActual)}>Receive current detail</button>
        <ProjectConvertToTaskSheet story={old} authoritativeProject={actual} onClose={vi.fn()} /></>;
    }
    renderWithProviders(<Authority />, { locale: "en" });
    const title = await screen.findByLabelText("Title");
    const notes = screen.getByLabelText("Notes");
    await userEvent.clear(title); await userEvent.type(title, "Local title");
    await userEvent.clear(notes); await userEvent.type(notes, "Local notes");
    mocked.getProject.mockImplementation(async () => received);
    fireEvent.click(screen.getByRole("button", { name: "Receive current detail", hidden: true }));
    await screen.findAllByRole("button", { name: "Use server version" });
    expect(title).toHaveValue("Local title"); expect(notes).toHaveValue("Local notes");
    expect(screen.getByRole("button", { name: "Make task" })).toBeDisabled();
    received = { ...received };
    fireEvent.click(screen.getByRole("button", { name: "Receive current detail", hidden: true }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Use server version" })).toHaveLength(2));
    received = { ...received, revision: 3, title: "Server title3", notes: "Server notes3" };
    fireEvent.click(screen.getByRole("button", { name: "Receive current detail", hidden: true }));
    await waitFor(() => expect(mocked.getProject).toHaveBeenCalledTimes(4));
    await userEvent.click(within(title.closest("label")!).getByRole("button", { name: "Use server version" }));
    await userEvent.click(within(notes.closest("label")!).getByRole("button", { name: /Keep.*edit/i }));
    expect(screen.getByLabelText("Title")).toBe(title);
    expect(title).toHaveValue("Server title3");
    expect(notes).toHaveValue("Local notes");
    await userEvent.click(screen.getByRole("button", { name: "Make task" }));
    await waitFor(() => expect(mocked.convertStoryToTask).toHaveBeenCalledWith(42,
      expect.objectContaining({ expectedRevision: 3, notes: "Local notes" })));
    expect(mocked.convertStoryToTask.mock.calls[0]![1]).not.toHaveProperty("title");
  });

  it.each(["planning", "conversion"] as const)("final sibling: %s keeps a published preview obsolete after project denial and restoration", async kind => {
    const actualTask = { ...task, projectId: 42, hierarchyRevisions: [{ id: task.id, revision: 1 }, { id: 42, revision: 1 }] };
    mocked.getTask.mockResolvedValue(actualTask);
    const preview = kind === "planning" ? mocked.previewTaskUpdate : mocked.previewTaskConversion;
    preview.mockResolvedValueOnce({ activatingProjects: [{ id: 42, title: "Revoked sibling title" }],
      decision: { ...snapshot(1), projects: [{ ...snapshot(1).projects[0]!, title: "Revoked sibling title" }] } })
      .mockResolvedValue({ activatingProjects: [{ id: 42, title: "New sibling requirements" }],
        decision: { ...snapshot(2), projects: [{ ...snapshot(2).projects[0]!, title: "New sibling requirements" }] } });
    function Reader() {
      const actions = useProjectActions();
      const [reads, setReads] = useState(0);
      return <><button onClick={() => void actions.getProject(42).catch(() => {}).finally(() => setReads(value => value + 1))}>Read sibling project</button>
        <output data-testid="sibling-reads">{reads}</output>
        {kind === "planning" ? <TaskPlanningSheet task={actualTask} onClose={vi.fn()} />
          : <TaskConvertToProjectSheet task={actualTask} onClose={vi.fn()} />}</>;
    }
    renderWithProviders(<Reader />, { locale: "en" });
    if (kind === "planning") {
      fireEvent.change(screen.getByLabelText("Planned for"), { target: { value: "2027-01-05" } });
      fireEvent.blur(screen.getByLabelText("Planned for"));
    }
    const submit = kind === "planning" ? "Save" : "Convert to project";
    await userEvent.click(screen.getByRole("button", { name: submit }));
    await userEvent.selectOptions(await screen.findByLabelText("Lead for “Revoked sibling title”"), "1");
    await userEvent.type(screen.getByLabelText(/concrete next/i), "Keep sibling decision");
    mocked.getProject.mockRejectedValueOnce(new ApiError(403, "Sibling project denied"));
    fireEvent.click(screen.getByRole("button", { name: "Read sibling project", hidden: true }));
    await waitFor(() => expect(screen.getByTestId("sibling-reads")).toHaveTextContent("1"));
    expect(screen.queryByLabelText("Lead for “Revoked sibling title”")).not.toBeInTheDocument();
    mocked.getProject.mockResolvedValue(detail(2));
    fireEvent.click(screen.getByRole("button", { name: "Read sibling project", hidden: true }));
    await waitFor(() => expect(screen.getByTestId("sibling-reads")).toHaveTextContent("2"));
    expect(screen.queryByLabelText("Lead for “Revoked sibling title”")).not.toBeInTheDocument();
    expect(preview).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: submit }));
    expect(await screen.findByLabelText("Lead for “New sibling requirements”")).toHaveValue("1");
    expect(screen.getByLabelText(/concrete next/i)).toHaveValue("Keep sibling decision");
    expect(mocked.updateTask).not.toHaveBeenCalled();
    expect(mocked.convertTaskToStory).not.toHaveBeenCalled();
  });
  it.each(["entry", "split"] as const)("final acceptance: %s hides revoked preview requirements and deliberately rebuilds them without losing decisions", async kind => {
    const decision = (revision: number, title: string) => ({
      ...snapshot(revision), projects: [{ ...snapshot(revision).projects[0]!, title }],
    });
    const preview = kind === "entry" ? mocked.previewProjectSteps : mocked.previewTaskSteps;
    preview.mockResolvedValueOnce({ activatingProjects: [{ id: 42, title: "Private preview title" }],
      decision: decision(1, "Private preview title") })
      .mockResolvedValue({ activatingProjects: [{ id: 42, title: "Fresh requirements" }],
        decision: decision(2, "Fresh requirements") });
    mocked.createTaskStepBatchForProject.mockResolvedValue({ project: detail(2), tasks: [] });
    mocked.createTaskStepBatchForTask.mockResolvedValue({ parent: task, tasks: [] });
    function Denial() {
      const actions = useProjectActions();
      return <button onClick={() => void actions.getProject(42).catch(() => {})}>Deny preview project</button>;
    }
    renderWithProviders(<><Denial />{kind === "entry"
      ? <ProjectTaskEntrySheet project={project} onClose={vi.fn()} />
      : <TaskSplitSheet parentId={task.id} parentRevision={1} projectId={42} onClose={vi.fn()} />}</>, { locale: "en" });
    await waitFor(() => expect(mocked.getProject).toHaveBeenCalledOnce());
    const editor = screen.getByPlaceholderText("Step …");
    await userEvent.type(editor, "Preserved private step draft");
    await userEvent.click(screen.getByText("Planning (optional)"));
    fireEvent.change(screen.getByLabelText("Due"), { target: { value: "2027-03-01" } });
    const submitName = kind === "entry" ? "Add task" : "Create 1 subtask";
    await userEvent.click(screen.getByRole("button", { name: submitName }));
    await userEvent.selectOptions(await screen.findByLabelText("Lead for “Private preview title”"), "1");
    await userEvent.type(screen.getByLabelText(/concrete next/i), "Preserved next-action draft");
    mocked.getProject.mockRejectedValueOnce(new ApiError(403, "Project read revoked"));
    fireEvent.click(screen.getByRole("button", { name: "Deny preview project", hidden: true }));
    await screen.findByRole("button", { name: "Try again" });
    expect(screen.queryByLabelText("Lead for “Private preview title”")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: submitName })).toBeDisabled();
    mocked.getProject.mockRejectedValueOnce(new ApiError(503, "Own retry failed"));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled());
    expect(screen.queryByLabelText("Lead for “Private preview title”")).not.toBeInTheDocument();
    mocked.getProject.mockResolvedValue(detail(2));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument());
    expect(screen.queryByLabelText("Lead for “Private preview title”")).not.toBeInTheDocument();
    expect(screen.getAllByPlaceholderText("Step …")[0]).toBe(editor);
    expect(editor).toHaveValue("Preserved private step draft");
    expect(preview).toHaveBeenCalledOnce();
    expect(mocked.createTaskStepBatchForProject).not.toHaveBeenCalled();
    expect(mocked.createTaskStepBatchForTask).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: submitName }));
    expect(await screen.findByLabelText("Lead for “Fresh requirements”")).toHaveValue("1");
    expect(screen.getByLabelText(/concrete next/i)).toHaveValue("Preserved next-action draft");
    expect(mocked.createTaskStepBatchForProject).not.toHaveBeenCalled();
    expect(mocked.createTaskStepBatchForTask).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: submitName }));
    if (kind === "entry") await waitFor(() => expect(mocked.createTaskStepBatchForProject).toHaveBeenCalledWith(42,
      expect.objectContaining({ expectedRevision: 2, activationResolution: expect.objectContaining({
        expectedProjects: [{ projectId: 42, revision: 2 }], nextActionTitle: "Preserved next-action draft",
      }) })));
    else await waitFor(() => expect(mocked.createTaskStepBatchForTask).toHaveBeenCalledWith(task.id,
      expect.objectContaining({ expectedProjectRevisions: [{ projectId: 42, revision: 2 }], activationResolution: expect.objectContaining({
        expectedProjects: [{ projectId: 42, revision: 2 }], nextActionTitle: "Preserved next-action draft",
      }) })));
  });

  it("final acceptance: active Deadline target omitted from expectedProjects rejects a lower target but accepts equal/higher requirements", async () => {
    const ancestorDecision = (revision: number, title: string) => ({
      targetRevision: revision, expectedProjects: [{ projectId: 88, revision: 12 }],
      projects: [{ projectId: 88, title, revision: 12, ownerMemberId: null,
        required: ["driver", "progressPath"] as Array<"driver" | "progressPath"> }],
    });
    const save = vi.fn().mockRejectedValueOnce(new ApiError(409, "Decisions",
      "project_commitment_resolution_required", ancestorDecision(3, "Current ancestor requirements"))).mockResolvedValue(undefined);
    function Authority() {
      const actions = useProjectActions();
      const [actual, setActual] = useState<ProjectDetail | null>(null);
      return <><button onClick={() => void actions.getProject(42).then(setActual)}>Read deadline target</button>
        <output data-testid="target-revision">{actual?.revision}</output>
        <ProjectDeadlineSheet story={{ ...project, status: "active", revision: 3 }}
          authoritativeProject={actual} onSave={save} onClose={vi.fn()} /></>;
    }
    renderWithProviders(<Authority />, { locale: "en" });
    await userEvent.type(screen.getByLabelText("Due"), "2027-02-01{Enter}");
    await userEvent.selectOptions(await screen.findByLabelText("Lead for “Current ancestor requirements”"), "1");
    await userEvent.type(screen.getByLabelText(/concrete next/i), "Kept active-target draft");
    const read = async (revision: number, title: string) => {
      mocked.getProject.mockResolvedValue({ ...detail(revision), status: "active",
        activationDecisionSnapshot: ancestorDecision(revision, title) });
      fireEvent.click(screen.getByRole("button", { name: "Read deadline target", hidden: true }));
      await waitFor(() => expect(screen.getByTestId("target-revision")).toHaveTextContent(String(revision)));
    };
    await read(3, "Current ancestor requirements");
    await read(1, "Obsolete ancestor requirements");
    expect(screen.queryByLabelText("Lead for “Obsolete ancestor requirements”")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Lead for “Current ancestor requirements”")).toHaveValue("1");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ expectedRevision: 3 })));
    await read(4, "Higher target requirements");
    expect(await screen.findByLabelText("Lead for “Higher target requirements”")).toHaveValue("1");
    mocked.getProject.mockResolvedValue({ ...detail(4), status: "active",
      activationDecisionSnapshot: ancestorDecision(4, "Equal-derived requirements") });
    fireEvent.click(screen.getByRole("button", { name: "Read deadline target", hidden: true }));
    expect(await screen.findByLabelText("Lead for “Equal-derived requirements”")).toHaveValue("1");
    expect(screen.getByLabelText(/concrete next/i)).toHaveValue("Kept active-target draft");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ expectedRevision: 4 })));
  });

  it.each(["task", "project"] as const)("fifth review: %s move keeps exact search nodes and sticky read feedback through failed then successful retry", async role => {
    const destination = makeProject({ id: 43, title: "Chosen destination" });
    mocked.getProjects.mockResolvedValue([project, destination]);
    mocked.getProject.mockImplementation(async id => ({ ...(id === 43 ? destination : project), tasks: [] }));
    function Denial() {
      const actions = useProjectActions();
      return <button onClick={() => void actions.getProject(43).catch(() => {})}>Invalidate destination</button>;
    }
    renderWithProviders(<><Denial />{role === "task"
      ? <MoveTaskSheet task={{ ...task, projectId: null }} onClose={vi.fn()} />
      : <MoveProjectSheet story={project} onClose={vi.fn()} />}</>, { locale: "en" });
    await userEvent.click(await screen.findByRole("button", { name: destination.title }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Move here" })).toBeEnabled());
    const search = screen.getAllByRole("searchbox")[0]!;
    await userEvent.type(search, "Chosen");
    mocked.getProject.mockRejectedValueOnce(new ApiError(403, "Destination denied"));
    fireEvent.click(screen.getByRole("button", { name: "Invalidate destination", hidden: true }));
    const retry = await screen.findByRole("button", { name: "Try again" });
    const warning = retry.closest("[role=alert]")!;
    const pending = deferred<ProjectDetail>();
    mocked.getProject.mockImplementation(async id => id === 43 ? pending.promise : detail());
    fireEvent.click(retry);
    expect(screen.getAllByRole("searchbox")[0]).toBe(search);
    expect(search).toHaveValue("Chosen");
    expect(warning).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Move here" })).toBeDisabled();
    await act(async () => pending.reject(new ApiError(503, "Retry unavailable")));
    await waitFor(() => expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled());
    expect(screen.getAllByRole("searchbox")[0]).toBe(search);
    expect(search).toHaveValue("Chosen");
    expect(screen.getByRole("button", { name: destination.title })).toHaveAttribute("aria-pressed", "true");
    const success = deferred<ProjectDetail>();
    mocked.getProject.mockImplementation(async id => id === 43 ? success.promise : detail());
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(warning).toBeInTheDocument();
    await act(async () => success.resolve({ ...destination, revision: 2, tasks: [] }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Move here" })).toBeEnabled());
    expect(screen.getAllByRole("searchbox")[0]).toBe(search);
    expect(search).toHaveValue("Chosen");
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    expect(mocked.moveTask).not.toHaveBeenCalled();
    expect(mocked.moveProject).not.toHaveBeenCalled();
  });

  it.each(["activation", "deadline"] as const)("fifth review: %s merges all qualified snapshots without downgrading or losing decision drafts", async kind => {
    const activate = vi.fn().mockResolvedValue(false);
    const save = vi.fn().mockRejectedValueOnce(new ApiError(409, "Decisions", "project_commitment_resolution_required", snapshot(1)))
      .mockResolvedValue(undefined);
    function Authority() {
      const actions = useProjectActions();
      const [actual, setActual] = useState<ProjectDetail | null>(null);
      return <>
        <button onClick={() => void actions.getProject(42).then(setActual).catch(() => {})}>Receive qualified detail</button>
        {kind === "activation"
          ? <ProjectActivationSheet story={{ ...project, directActivationDecisionSnapshot: snapshot(1) }}
            authoritativeProject={actual} action="activate" onActivate={activate} onClose={vi.fn()} />
          : <ProjectDeadlineSheet story={project} authoritativeProject={actual} onSave={save} onClose={vi.fn()} />}
      </>;
    }
    renderWithProviders(<Authority />, { locale: "en" });
    if (kind === "deadline") {
      await userEvent.type(screen.getByLabelText("Due"), "2027-02-01{Enter}");
      await screen.findByLabelText(/Lead for/);
    }
    await screen.findByRole("option", { name: "Mira" });
    await userEvent.selectOptions(screen.getByLabelText(/Lead for/), "1");
    await userEvent.type(screen.getByLabelText(/concrete next/i), "Keep these decisions");
    const receive = () => fireEvent.click(screen.getByRole("button", { name: "Receive qualified detail", hidden: true }));
    const nextSnapshot = (revision: number, derived = false) => ({
      ...snapshot(revision),
      expectedProjects: [{ projectId: 42, revision }, { projectId: 88, revision: 5 }],
      projects: [...snapshot(revision).projects,
        { projectId: 88, title: derived ? "New equal-revision requirement" : "New detail requirement", revision: 5, ownerMemberId: null, required: ["driver"] as Array<"driver"> }],
    });
    mocked.getProject.mockResolvedValue({ ...detail(2), activationDecisionSnapshot: nextSnapshot(2), directActivationDecisionSnapshot: nextSnapshot(2) });
    receive();
    const extra = await screen.findByLabelText("Lead for “New detail requirement”");
    expect(screen.getByLabelText(/concrete next/i)).toHaveValue("Keep these decisions");
    expect(screen.getByLabelText(`Lead for “${project.title}”`)).toHaveValue("1");
    await userEvent.selectOptions(extra, "1");
    mocked.getProject.mockResolvedValue({ ...detail(3), activationDecisionSnapshot: nextSnapshot(3), directActivationDecisionSnapshot: nextSnapshot(3) });
    receive();
    await waitFor(() => expect(mocked.getProject).toHaveBeenCalledTimes(2));
    mocked.getProject.mockResolvedValue(detail(1));
    receive();
    await waitFor(() => expect(mocked.getProject).toHaveBeenCalledTimes(3));
    expect(screen.getByLabelText("Lead for “New detail requirement”")).toHaveValue("1");
    mocked.getProject.mockResolvedValue({ ...detail(3), activationDecisionSnapshot: nextSnapshot(3, true), directActivationDecisionSnapshot: nextSnapshot(3, true) });
    receive();
    await screen.findByLabelText("Lead for “New equal-revision requirement”");
    mocked.getProject.mockRejectedValue(new ApiError(503, "Background unavailable"));
    receive();
    await waitFor(() => expect(mocked.getProject).toHaveBeenCalledTimes(5));
    expect(screen.getByLabelText(/concrete next/i)).toHaveValue("Keep these decisions");
    fireEvent.click(screen.getByRole("button", { name: kind === "activation" ? "Start project" : "Save" }));
    if (kind === "activation") {
      await waitFor(() => expect(activate).toHaveBeenCalledWith(1, expect.objectContaining({
        expectedProjects: [{ projectId: 42, revision: 3 }, { projectId: 88, revision: 5 }],
        nextActionTitle: "Keep these decisions",
      }), 3));
    } else await waitFor(() => expect(save).toHaveBeenLastCalledWith(expect.objectContaining({
      expectedRevision: 3, activationResolution: expect.objectContaining({
        expectedProjects: [{ projectId: 42, revision: 3 }, { projectId: 88, revision: 5 }],
      }),
    })));
  });

  it.each(["entry", "split"] as const)("fifth review: %s owns a stamped GET-only retry without losing steps or activation choices", async kind => {
    mocked.previewProjectSteps.mockResolvedValue({ activatingProjects: [{ id: 42, title: project.title }],
      decision: { ...snapshot(1), projects: [{ ...snapshot(1).projects[0]!, required: ["driver"] }] } });
    mocked.previewTaskSteps.mockResolvedValue({ activatingProjects: [{ id: 42, title: project.title }],
      decision: { ...snapshot(1), projects: [{ ...snapshot(1).projects[0]!, required: ["driver"] }] } });
    function Denial() {
      const actions = useProjectActions();
      return <button onClick={() => void actions.getProject(42).catch(() => {})}>Invalidate batch project</button>;
    }
    renderWithProviders(<><Denial />{kind === "entry"
      ? <ProjectTaskEntrySheet project={project} onClose={vi.fn()} />
      : <TaskSplitSheet parentId={7} parentRevision={1} projectId={42} onClose={vi.fn()} />}</>, { locale: "en" });
    await waitFor(() => expect(mocked.getProject).toHaveBeenCalledOnce());
    const editor = screen.getByPlaceholderText("Step …");
    await userEvent.type(editor, "Keep batch draft");
    await userEvent.click(screen.getByText("Planning (optional)"));
    fireEvent.change(screen.getByLabelText("Due"), { target: { value: "2027-03-01" } });
    const submitName = kind === "entry" ? "Add task" : "Create 1 subtask";
    await userEvent.click(screen.getByRole("button", { name: submitName }));
    await userEvent.selectOptions(await screen.findByLabelText(/Lead for/), "1");
    mocked.getProject.mockRejectedValueOnce(new ApiError(403, "Batch project denied"));
    fireEvent.click(screen.getByRole("button", { name: "Invalidate batch project", hidden: true }));
    const retry = await screen.findByRole("button", { name: "Try again" });
    const pending = deferred<ProjectDetail>();
    mocked.getProject.mockReturnValueOnce(pending.promise);
    fireEvent.click(retry);
    expect(editor).toBeInTheDocument();
    expect(editor).toHaveValue("Keep batch draft");
    expect(screen.getByRole("button", { name: submitName })).toBeDisabled();
    await act(async () => pending.reject(new ApiError(503, "Batch retry unavailable")));
    await waitFor(() => expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled());
    expect(editor).toHaveValue("Keep batch draft");
    mocked.getProject.mockResolvedValue(detail(2));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByRole("button", { name: submitName })).toBeEnabled());
    expect(screen.getAllByPlaceholderText("Step …")[0]).toBe(editor);
    expect(screen.queryByLabelText(/Lead for/)).not.toBeInTheDocument();
    const freshPreview = { activatingProjects: [{ id: 42, title: project.title }],
      decision: { ...snapshot(2), projects: [{ ...snapshot(2).projects[0]!, required: ["driver"] as Array<"driver"> }] } };
    if (kind === "entry") mocked.previewProjectSteps.mockResolvedValue(freshPreview);
    else mocked.previewTaskSteps.mockResolvedValue(freshPreview);
    await userEvent.click(screen.getByRole("button", { name: submitName }));
    await screen.findByLabelText(/Lead for/);
    expect(screen.getByLabelText(/Lead for/)).toHaveValue("1");
    expect(mocked.createTaskStepBatchForProject).not.toHaveBeenCalled();
    expect(mocked.createTaskStepBatchForTask).not.toHaveBeenCalled();
  });

  it("fifth review: conversion prefers higher confirmed host authority over older local data and a failed local refresh", async () => {
    const old = { ...task, projectId: null, children: [], dependencies: [] };
    const latest = { ...old, revision: 2, dependencies: [{ id: 90, taskId: task.id, dependsOnTaskId: 88, title: "Fresh host dependency", resolved: false }] };
    mocked.getTask.mockResolvedValue(old);
    mocked.previewTaskConversion.mockResolvedValue({ activatingProjects: [], decision: null });
    mocked.convertTaskToStory.mockResolvedValue(project);
    function Conversion() {
      const actions = useTaskActions();
      const [authority, setAuthority] = useState<typeof task>(old);
      return <>
        <button onClick={() => void actions.update(old, { notes: "confirmed" }, undefined, true).then(result => {
          if (result) setAuthority(result);
        })}>Receive confirmed task</button>
        <TaskConvertToProjectSheet task={authority} onClose={vi.fn()} />
      </>;
    }
    mocked.updateTask.mockResolvedValue(latest);
    renderWithProviders(<Conversion />, { locale: "en" });
    await waitFor(() => expect(mocked.getTask).toHaveBeenCalledOnce());
    const authored = screen.getByLabelText("Keep the original task as a work step");
    await userEvent.clear(authored);
    await userEvent.type(authored, "Keep conversion choice");
    mocked.getTask.mockRejectedValue(new ApiError(503, "Local refresh unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Receive confirmed task", hidden: true }));
    await screen.findByLabelText("This task depends on: Fresh host dependency");
    expect(authored).toHaveValue("Keep conversion choice");
    fireEvent.click(screen.getByRole("button", { name: "Convert to project" }));
    await waitFor(() => expect(mocked.convertTaskToStory).toHaveBeenCalledWith(task.id,
      expect.objectContaining({ expectedRevision: 2, preservedStepTitle: "Keep conversion choice" })));
  });

  it("fifth review: conversion composition does not certify pending-only revision2 over a first actual revision1", async () => {
    const read = deferred<typeof task>();
    mocked.getTask.mockReturnValue(read.promise);
    mocked.previewTaskConversion.mockResolvedValue({ activatingProjects: [], decision: null });
    mocked.convertTaskToStory.mockResolvedValue(project);
    renderWithProviders(<TaskConvertToProjectSheet task={{ ...task, revision: 2, title: "Pending presentation" }}
      authoritativeTask={null} onClose={vi.fn()} />, { locale: "en" });
    const authored = screen.getByLabelText("Keep the original task as a work step");
    await userEvent.clear(authored);
    await userEvent.type(authored, "Compose without certifying");
    expect(screen.getByRole("button", { name: "Convert to project" })).toBeDisabled();
    expect(mocked.convertTaskToStory).not.toHaveBeenCalled();
    await act(async () => read.resolve(task));
    expect(authored).toHaveValue("Compose without certifying");
    await userEvent.click(screen.getByRole("button", { name: "Convert to project" }));
    await waitFor(() => expect(mocked.convertTaskToStory).toHaveBeenCalledWith(task.id,
      expect.objectContaining({ expectedRevision: 1, preservedStepTitle: "Compose without certifying" })));
  });
  it.each([
    ["planner", false], ["planner", true], ["defer", false], ["defer", true], ["activation", false], ["activation", true],
  ] as const)(
    "%s does not close a recovered same opening when its obsolete dispatched save settles (failure: %s)", async (kind, rejected) => {
        const pending = deferred<never>();
        const write = kind === "planner" ? mocked.updateTask : kind === "defer" ? mocked.updateProject : mocked.activateProject;
        write.mockReturnValueOnce(pending.promise);
        const view = renderWithProviders(<Controls />, { locale: "en" });
        await userEvent.click(screen.getByRole("button", { name: `Open ${kind}` }));
        if (kind === "planner") {
          const editor = await screen.findByLabelText("Planned for");
          fireEvent.change(editor, { target: { value: "2027-01-05" } });
          fireEvent.blur(editor);
          fireEvent.click(screen.getByRole("button", { name: "Save" }));
        } else if (kind === "defer") {
          fireEvent.click(await screen.findByRole("button", { name: "Tomorrow" }));
        } else {
          await userEvent.selectOptions(await screen.findByLabelText(/Lead for/), "1");
          await userEvent.type(screen.getByLabelText(/concrete next/i), "Keep this next action");
          fireEvent.click(screen.getByRole("button", { name: "Start project" }));
        }
        await waitFor(() => expect(write).toHaveBeenCalled());
        const reader = kind === "planner" ? mocked.getTask : mocked.getProject;
        reader.mockRejectedValueOnce(new ApiError(403, "Other reader denied"));
        fireEvent.click(screen.getByRole("button", { name: kind === "planner" ? "Other task reader" : "Other project reader", hidden: true }));
        await screen.findByRole("button", { name: "Try again" });
        if (kind === "planner") mocked.getTask.mockResolvedValue({ ...task, revision: 2 });
        else mocked.getProject.mockResolvedValue(detail(2));
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
        await waitFor(() => expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument());
        await act(async () => {
          if (rejected) pending.reject(new Error("Old failure"));
          else pending.resolve((kind === "planner" ? { ...task, revision: 2 } : detail(2)) as never);
        });
        expect(screen.getByTestId("opening")).not.toHaveTextContent("closed");
        expect(screen.getByRole("dialog")).toBeInTheDocument();
        view.unmount();
    },
  );

  it.each(["entry", "split"] as const)(
    "%s preserves the original qualified GET provenance across an intervening denial and restoration", async kind => {
      const old = { ...detail(), title: "Obsolete qualified project", tasks: [makeTask({ id: 90, title: "Obsolete qualified step" })] };
      mocked.getProject.mockResolvedValueOnce(old)
        .mockRejectedValueOnce(new ApiError(403, "Intervening denial"))
        .mockResolvedValue({ ...detail(2), title: "Fresh qualified project" });
      revokeAfterQualification = true;
      renderWithProviders(kind === "entry"
        ? <ProjectTaskEntrySheet project={project} onClose={vi.fn()} />
        : <TaskSplitSheet parentId={task.id} parentRevision={1} projectId={project.id} onClose={vi.fn()} />,
      { locale: "en" });
      await waitFor(() => expect(mocked.getProject).toHaveBeenCalledTimes(3));
      expect(screen.queryByText("Obsolete qualified step")).not.toBeInTheDocument();
      expect(screen.queryByText("Obsolete qualified project")).not.toBeInTheDocument();
      await userEvent.type(screen.getByPlaceholderText("Step …"), "Keep authored step");
      const submit = screen.getByRole("button", { name: kind === "entry" ? "Add task" : "Create 1 subtask" });
      expect(submit).toBeDisabled();
      expect(mocked.createTaskStepBatchForProject).not.toHaveBeenCalled();
      expect(mocked.createTaskStepBatchForTask).not.toHaveBeenCalled();
    },
  );

  it.each(["activation", "deadline"] as const)(
    "%s recovers failed stale-refresh requirements with GET only and retains decisions", async kind => {
      const write = kind === "activation" ? mocked.activateProject : mocked.updateProject;
      const resolutionError = new ApiError(409, "Decisions", "project_commitment_resolution_required", snapshot(1));
      write.mockRejectedValueOnce(resolutionError)
        .mockRejectedValueOnce(new ApiError(409, "Stale", "stale_write_conflict"))
        .mockResolvedValue(detail(3));
      renderWithProviders(<Controls />, { locale: "en" });
      await userEvent.click(screen.getByRole("button", { name: `Open ${kind}` }));
      if (kind === "deadline") {
        await userEvent.type(await screen.findByLabelText("Due"), "2027-02-01{Enter}");
        await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
      }
      await userEvent.selectOptions(await screen.findByLabelText(/Lead for/), "1");
      const next = screen.getByLabelText(/concrete next/i);
      await userEvent.type(next, "Preserved recovery decision");
      const submitName = kind === "activation" ? "Start project" : "Save";
      if (kind === "activation") {
        fireEvent.click(screen.getByRole("button", { name: submitName }));
        await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
      }
      mocked.getProject.mockRejectedValue(new ApiError(503, "Refresh unavailable"));
      fireEvent.click(screen.getByRole("button", { name: submitName }));
      await waitFor(() => expect(write).toHaveBeenCalledTimes(2));
      const retry = await screen.findByRole("button", { name: "Try again" });
      mocked.getProject.mockResolvedValue(detail(2));
      fireEvent.click(retry);
      await waitFor(() => expect(screen.getByLabelText(/concrete next/i)).toHaveValue("Preserved recovery decision"));
      expect(screen.getByLabelText(/Lead for/)).toHaveValue("1");
      expect(write).toHaveBeenCalledTimes(2);
      fireEvent.click(screen.getByRole("button", { name: submitName }));
      await waitFor(() => expect(write).toHaveBeenCalledTimes(3));
      const input = write.mock.calls[2]![1];
      expect(input).toMatchObject({ expectedRevision: 2, activationResolution: {
        expectedProjects: [{ projectId: 42, revision: 2 }], nextActionTitle: "Preserved recovery decision",
        drivers: [{ projectId: 42, ownerMemberId: 1 }],
      } });
    },
  );

  it.each(["task", "project"] as const)(
    "moving a %s reports an invalidated destination and retries the same selection without submitting", async role => {
      const destination = makeProject({ id: 43, title: "Chosen destination" });
      mocked.getProjects.mockResolvedValue([project, destination]);
      mocked.getProject.mockImplementation(async id => ({ ...(id === 43 ? destination : project), tasks: [] }));
      function OtherReader() {
        const actions = useProjectActions();
        return <button onClick={() => void actions.getProject(43).catch(() => {})}>Deny destination</button>;
      }
      renderWithProviders(<><OtherReader />{role === "task"
        ? <MoveTaskSheet task={{ ...task, projectId: null }} onClose={vi.fn()} />
        : <MoveProjectSheet story={project} onClose={vi.fn()} />}</>, { locale: "en" });
      await userEvent.click(await screen.findByRole("button", { name: destination.title }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Move here" })).toBeEnabled());
      mocked.getProject.mockRejectedValueOnce(new ApiError(403, "Destination denied"));
      fireEvent.click(screen.getByRole("button", { name: "Deny destination", hidden: true }));
      const alert = await screen.findByRole("alert");
      expect(within(alert).getByRole("button", { name: "Try again" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Move here" })).toBeDisabled();
      mocked.getProject.mockImplementation(async id => ({ ...(id === 43 ? destination : project), revision: 2, tasks: [] }));
      fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Move here" })).toBeEnabled());
      expect(screen.getByRole("button", { name: destination.title })).toHaveAttribute("aria-pressed", "true");
      expect(mocked.moveTask).not.toHaveBeenCalled();
      expect(mocked.moveProject).not.toHaveBeenCalled();
    },
  );
});
