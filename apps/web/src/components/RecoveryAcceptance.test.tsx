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
        getProject: async (id: number) => {
          const value = await actions.getProject(id);
          await intervene(id);
          return value;
        },
        readProject: async (id: number) => {
          const result = await actions.readProject(id);
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
