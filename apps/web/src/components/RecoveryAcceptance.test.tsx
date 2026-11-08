import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useQueryClient } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, type ProjectDetail, type TaskDetail } from "../lib/api";
import { useTaskActions } from "../lib/useTaskActions";
import { useProjectActions, useProjectDetailQuery } from "../lib/useProjectActions";
import { useIdentity } from "../lib/identity";
import { useRefresh } from "../lib/refresh";
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
import { useEffect, useRef, useState } from "react";

vi.mock("../lib/api", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/api")>(),
  api: {
    getMembers: vi.fn(), getAuthStatus: vi.fn(), getTask: vi.fn(), getProject: vi.fn(),
    getProjects: vi.fn(), getTags: vi.fn().mockResolvedValue([]),
    getPhysicalContexts: vi.fn().mockResolvedValue([]), searchTasks: vi.fn().mockResolvedValue([]),
    previewTaskUpdate: vi.fn(), updateTask: vi.fn(), updateProject: vi.fn(), activateProject: vi.fn(),
    reopenProject: vi.fn(),
    previewProjectSteps: vi.fn(), previewTaskSteps: vi.fn(),
    createTaskStepBatchForProject: vi.fn(), createTaskStepBatchForTask: vi.fn(),
    moveTask: vi.fn(), moveProject: vi.fn(),
    previewTaskConversion: vi.fn(), convertTaskToStory: vi.fn(), convertStoryToTask: vi.fn(),
  },
}));

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
  it("keeps denied project detail hidden through a failed retry until a fresh GET succeeds", async () => {
    function Reader() {
      const actions = useProjectActions();
      const workflow = useProjectWorkflow();
      return <>
        <button onClick={() => workflow.open("activateWithDriver", project.id)}>Open project activation</button>
        <button onClick={() => void actions.getProject(project.id).catch(() => {})}>Deny project read</button>
        <ProjectWorkflowHost />
      </>;
    }

    let outcome: "success" | "denied" | "network" = "success";
    let revision = 1;
    const responses: number[] = [];
    mocked.getProject.mockImplementation(async () => {
      if (outcome === "denied") { responses.push(403); throw new ApiError(403, "Project unavailable"); }
      if (outcome === "network") { responses.push(503); throw new ApiError(503, "Retry unavailable"); }
      responses.push(200);
      return detail(revision);
    });
    renderWithProviders(<Reader />, { locale: "en" });
    await userEvent.click(screen.getByRole("button", { name: "Open project activation" }));
    await userEvent.selectOptions(await screen.findByLabelText(/Lead for/), "1");
    await userEvent.type(screen.getByLabelText(/concrete next/i), "Draft before access loss");
    expect(await screen.findByText("Acceptance project")).toBeInTheDocument();

    outcome = "denied";
    await userEvent.click(screen.getByRole("button", { name: "Deny project read" }));
    await waitFor(() => expect(screen.queryByText("Acceptance project")).not.toBeInTheDocument());
    outcome = "network";
    await userEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByText("Acceptance project")).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Start project" })).not.toBeInTheDocument();
    expect(mocked.activateProject).not.toHaveBeenCalled();

    outcome = "success";
    revision = 2;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Acceptance project")).toBeInTheDocument();
    expect(responses.slice(-3)).toEqual([403, 503, 200]);
    expect(mocked.activateProject).not.toHaveBeenCalled();
  });

  it.each(["metadata", "full"] as const)(
    "rejects a lower GET at Query publication when confirmed %s wins after response qualification",
    async baseline => {
    const request = deferred<ProjectDetail>();
    const before = { ...project, revision: 3 };
    const later = { ...project, revision: 5 };
    let actionsRef: ReturnType<typeof useProjectActions> | null = null;
    mocked.getProject.mockImplementation(async () => {
      const response = await request.promise;
      queueMicrotask(() => queueMicrotask(() => actionsRef?.reconcileProjectSnapshot(later)));
      return response;
    });
    function Reader() {
      const actions = useProjectActions();
      const queryClient = useQueryClient();
      const [result, setResult] = useState("idle");
      actionsRef = actions;
      return <>
        <button onClick={() => {
          actions.captureTargetRead(project.id);
          if (baseline === "full") queryClient.setQueryData(actions.queryKey(project.id), detail(3));
          else actions.reconcileProjectSnapshot(before);
        }}>Seed revision three</button>
        <button onClick={() => void actions.getProject(project.id).then(
          () => setResult("resolved"),
          () => setResult("rejected"),
        )}>Read revision four</button>
        <output data-testid="publication-result">{result}</output>
        <output data-testid="publication-revision">{actions.getCachedStory(project.id)?.revision ?? "missing"}</output>
        <output data-testid="publication-full">{String(actions.getCachedProject(project.id) !== undefined)}</output>
        <output data-testid="publication-cache">{String(queryClient.getQueryData(actions.queryKey(project.id)) !== undefined)}</output>
      </>;
    }

    renderWithProviders(<Reader />, { locale: "en" });
    await userEvent.click(screen.getByRole("button", { name: "Seed revision three" }));
    await userEvent.click(screen.getByRole("button", { name: "Read revision four" }));
    await waitFor(() => expect(mocked.getProject).toHaveBeenCalledTimes(1));
    await act(async () => request.resolve(detail(4)));
    await waitFor(() => expect(screen.getByTestId("publication-result")).not.toHaveTextContent("idle"));
    expect(screen.getByTestId("publication-result")).toHaveTextContent("rejected");
    expect(screen.getByTestId("publication-revision")).toHaveTextContent("5");
    expect(screen.getByTestId("publication-full")).toHaveTextContent(String(baseline === "full"));
    expect(screen.getByTestId("publication-cache")).toHaveTextContent("true");
    },
  );

  it("publishes the exact equal-revision detail and its fresh derived hierarchy", async () => {
    const fresh = { ...detail(1), ancestors: [{ id: 88, role: "story" as const, title: "Fresh equal ancestry", revision: 1 }] };
    mocked.getProject.mockResolvedValue(detail(1));
    function Reader() {
      const actions = useProjectActions();
      const query = useProjectDetailQuery(project.id);
      const queryClient = useQueryClient();
      const [same, setSame] = useState(false);
      return <>
        <button onClick={() => {
          mocked.getProject.mockResolvedValueOnce(fresh);
          void actions.getProject(project.id).then(result => setSame(
            result === fresh && queryClient.getQueryData(actions.queryKey(project.id)) === fresh,
          ));
        }}>Refresh equal project</button>
        <output data-testid="equal-publication">{String(same)}</output>
        <output data-testid="equal-ancestor">{query.data?.ancestors?.[0]?.title ?? "missing"}</output>
      </>;
    }

    renderWithProviders(<Reader />, { locale: "en" });
    await waitFor(() => expect(screen.getByTestId("equal-ancestor")).toHaveTextContent("missing"));
    await userEvent.click(screen.getByRole("button", { name: "Refresh equal project" }));
    await waitFor(() => expect(screen.getByTestId("equal-publication")).toHaveTextContent("true"));
    expect(screen.getByTestId("equal-ancestor")).toHaveTextContent("Fresh equal ancestry");
  });

  it("removes the previous identity's confirmed project Query when the actor changes", async () => {
    mocked.getMembers.mockResolvedValue([makeMember({ id: 1 }), makeMember({ id: 2 })]);
    window.localStorage.setItem("machbar:identity-member-id", "1");
    function Reader() {
      const actions = useProjectActions();
      const identity = useIdentity();
      const queryClient = useQueryClient();
      const previousKey = useRef<ReturnType<typeof actions.queryKey> | null>(null);
      const [, rerenderOnCacheChange] = useState(0);
      useEffect(() => queryClient.getQueryCache().subscribe(() => {
        rerenderOnCacheChange(version => version + 1);
      }), [queryClient]);
      return <>
        <button onClick={() => {
          previousKey.current = actions.queryKey(project.id);
          actions.captureTargetRead(project.id);
          actions.reconcileProjectSnapshot({ ...project, revision: 3 });
        }}>Confirm project metadata</button>
        <button onClick={() => identity.setCurrentMemberId(2)}>Switch actor</button>
        <output data-testid="actor-id">{identity.currentMemberId}</output>
        <output data-testid="current-project-key">{JSON.stringify(actions.queryKey(project.id))}</output>
        <output data-testid="old-project-query">{previousKey.current
          ? queryClient.getQueryData<{ revision: number }>(previousKey.current)?.revision ?? "missing" : "not seeded"}</output>
        <output data-testid="old-project-key">{JSON.stringify(previousKey.current)}</output>
      </>;
    }

    renderWithProviders(<Reader />, { locale: "en" });
    await userEvent.click(screen.getByRole("button", { name: "Confirm project metadata" }));
    await waitFor(() => expect(screen.getByTestId("old-project-query")).toHaveTextContent("3"));
    await userEvent.click(screen.getByRole("button", { name: "Switch actor" }));
    await waitFor(() => expect(screen.getByTestId("actor-id")).toHaveTextContent("2"));
    expect(screen.getByTestId("current-project-key").textContent).not.toBe(screen.getByTestId("old-project-key").textContent);
    await waitFor(() => expect(screen.getByTestId("old-project-query")).toHaveTextContent("missing"));
  });

  it.each(["success", "failure"] as const)(
    "does not publish an obsolete project mutation %s after access recovery",
    async outcome => {
      const mutation = deferred<ProjectDetail>();
      let denied = false;
      mocked.getProject.mockImplementation(async () => {
        if (denied) throw new ApiError(403, "Project unavailable");
        return detail(2);
      });
      mocked.updateProject.mockReturnValue(mutation.promise);
      function Reader() {
        const actions = useProjectActions();
        return <>
          <button onClick={() => void actions.getProject(42).catch(() => {})}>Read project</button>
          <button onClick={() => void actions.update(detail(), { title: "Obsolete title" },
            { title: "Obsolete title" }, true).catch(() => {})}>Save project</button>
          <output data-testid="project-revision">{actions.getCachedStory(42)?.revision ?? "missing"}</output>
          <output data-testid="project-retained">{String(actions.retained.has(42))}</output>
          <output data-testid="project-holding">{String(actions.holdingIds.has(42))}</output>
          <output data-testid="project-error">{actions.errors[42] ?? "none"}</output>
        </>;
      }

      renderWithProviders(<Reader />, { locale: "en" });
      await userEvent.click(screen.getByRole("button", { name: "Read project" }));
      await waitFor(() => expect(screen.getByTestId("project-revision")).toHaveTextContent("2"));
      await userEvent.click(screen.getByRole("button", { name: "Save project" }));
      await waitFor(() => expect(mocked.updateProject).toHaveBeenCalledOnce());
      expect(screen.getByTestId("project-retained")).toHaveTextContent("true");
      expect(screen.getByTestId("project-holding")).toHaveTextContent("true");

      denied = true;
      await userEvent.click(screen.getByRole("button", { name: "Read project" }));
      await waitFor(() => expect(screen.getByTestId("project-revision")).toHaveTextContent("missing"));
      expect(screen.getByTestId("project-retained")).toHaveTextContent("false");
      expect(screen.getByTestId("project-holding")).toHaveTextContent("false");
      denied = false;
      await userEvent.click(screen.getByRole("button", { name: "Read project" }));
      await waitFor(() => expect(screen.getByTestId("project-revision")).toHaveTextContent("2"));

      await act(async () => {
        if (outcome === "success") mutation.resolve({ ...detail(3), title: "Obsolete title" });
        else mutation.reject(new ApiError(503, "Obsolete save failure"));
      });
      await waitFor(() => expect(screen.getByTestId("project-error")).toHaveTextContent("none"));
      expect(screen.getByTestId("project-retained")).toHaveTextContent("false");
      expect(screen.getByTestId("project-holding")).toHaveTextContent("false");
      expect(screen.getByTestId("project-revision")).toHaveTextContent("2");
    },
  );

  it("does not close after a successful conversion whose qualified ancestor read expired", async () => {
    const ancestor = { id: 88, role: "story" as const, title: "Containing project" };
    const actual = { ...detail(), ancestors: [ancestor] };
    const pending = deferred<ReturnType<typeof makeTask>>();
    const close = vi.fn();
    let denied = false;
    mocked.getProject.mockImplementation(async id => {
      if (id === 88) {
        if (denied) throw new ApiError(403, "Containing project unavailable");
        return { ...makeProject({ id }), tasks: [] };
      }
      return actual;
    });
    mocked.convertStoryToTask.mockReturnValue(pending.promise);
    function Reader() {
      const actions = useProjectActions();
      return <>
        <button onClick={() => { denied = true; void actions.getProject(88).catch(() => {}); }}>Deny ancestor</button>
        <button onClick={() => { denied = false; void actions.getProject(88).catch(() => {}); }}>Restore ancestor</button>
        <output data-testid="ancestor-readable">{String(actions.isTargetReadable(88))}</output>
        <ProjectConvertToTaskSheet story={actual} onClose={close} />
      </>;
    }

    renderWithProviders(<Reader />, { locale: "en" });
    const convert = await screen.findByRole("button", { name: "Make task" });
    await userEvent.click(convert);
    await waitFor(() => expect(mocked.convertStoryToTask).toHaveBeenCalledOnce());
    await userEvent.click(screen.getByRole("button", { name: "Deny ancestor" }));
    await waitFor(() => expect(screen.getByTestId("ancestor-readable")).toHaveTextContent("false"));
    await userEvent.click(screen.getByRole("button", { name: "Restore ancestor" }));
    await waitFor(() => expect(screen.getByTestId("ancestor-readable")).toHaveTextContent("true"));

    await act(async () => pending.resolve(makeTask({ id: project.id })));
    expect(close).not.toHaveBeenCalled();
  });

  it.each(["success", "denial"] as const)(
    "a canceled empty-cache read cannot override the newer %s result",
    async outcome => {
      const oldRead = deferred<ProjectDetail>();
      let reads = 0;
      mocked.getProject.mockImplementation(async () => {
        reads++;
        if (reads === 1) return oldRead.promise;
        if (outcome === "denial") throw new ApiError(403, "Newer read denied");
        return detail(2);
      });

      function Reader() {
        const actions = useProjectActions();
        const [result, setResult] = useState("pending");
        const read = () => void actions.getProject(project.id).then(
          value => setResult(`success:${value.revision}`),
          () => setResult("denied"),
        );
        return <>
          <button onClick={read}>Start project read</button>
          <button onClick={read}>Start newer project read</button>
          <output data-testid="read-result">{result}</output>
          <output data-testid="readable">{String(actions.isTargetReadable(project.id))}</output>
          <output data-testid="cached-project">{actions.getCachedProject(project.id)?.title ?? "unavailable"}</output>
        </>;
      }

      renderWithProviders(<Reader />, { locale: "en" });
      await userEvent.click(screen.getByRole("button", { name: "Start project read" }));
      await waitFor(() => expect(reads).toBe(1));
      await userEvent.click(screen.getByRole("button", { name: "Start newer project read" }));
      await waitFor(() => expect(reads).toBe(2));
      if (outcome === "success") {
        await waitFor(() => expect(screen.getByTestId("read-result")).toHaveTextContent("success:2"));
        await act(async () => oldRead.reject(new ApiError(403, "Obsolete denial")));
        expect(screen.getByTestId("readable")).toHaveTextContent("true");
        expect(screen.getByTestId("cached-project")).toHaveTextContent("Acceptance project");
      } else {
        await waitFor(() => expect(screen.getByTestId("read-result")).toHaveTextContent("denied"));
        await act(async () => oldRead.resolve(detail(3)));
        expect(screen.getByTestId("readable")).toHaveTextContent("false");
        expect(screen.getByTestId("cached-project")).toHaveTextContent("unavailable");
      }
    },
  );

  it.each(["readable", "denied"] as const)(
    "an abandoned cached Query read is not fresh authority when the cache is %s",
    async cacheState => {
      let outcome: "success" | "denial" | "network" | "held" = "success";
      let successfulReads = 0;
      let abortedReads = 0;
      const heldStarted = deferred<void>();
      mocked.getProject.mockImplementation(async (_id, signal) => {
        if (outcome === "denial") throw new ApiError(403, "Newer read denied");
        if (outcome === "network") throw new ApiError(503, "Retry unavailable");
        if (outcome === "held") {
          heldStarted.resolve();
          return await new Promise<ProjectDetail>((_resolve, reject) => {
            const abort = () => {
              abortedReads += 1;
              reject(new DOMException("Query observer left", "AbortError"));
            };
            if (signal?.aborted) abort();
            else signal?.addEventListener("abort", abort, { once: true });
          });
        }
        successfulReads += 1;
        return detail(successfulReads);
      });

      function DetailObserver() {
        useProjectDetailQuery(project.id);
        return null;
      }

      function Reader() {
        const actions = useProjectActions();
        const [observe, setObserve] = useState(true);
        const [result, setResult] = useState("idle");
        const startRead = () => {
          setResult("pending");
          void actions.readProject(project.id).then(
            received => setResult(`resolved:${received.value.revision}`),
            () => setResult("rejected"),
          );
        };
        return <>
          {observe ? <DetailObserver /> : null}
          <button onClick={() => { outcome = "denial"; startRead(); }}>Read denial</button>
          <button onClick={() => { outcome = "network"; startRead(); }}>Read network error</button>
          <button onClick={() => { outcome = "held"; startRead(); }}>Start held read</button>
          <button onClick={() => setObserve(false)}>Remove last observer</button>
          <button onClick={() => actions.reconcileProjectSnapshot({
            id: project.id, revision: 3, title: "Manual metadata acknowledgement", status: project.status,
          })}>Acknowledge metadata</button>
          <output data-testid="read-result">{result}</output>
          <output data-testid="readable">{String(actions.isTargetReadable(project.id))}</output>
          <output data-testid="cached-project">{actions.getCachedProject(project.id)?.title ?? "unavailable"}</output>
          <output data-testid="successful-reads">{successfulReads}</output>
          <output data-testid="aborted-reads">{abortedReads}</output>
        </>;
      }

      renderWithProviders(<Reader />, { locale: "en" });
      await waitFor(() => expect(screen.getByTestId("cached-project")).toHaveTextContent(project.title));
      expect(successfulReads).toBe(1);

      if (cacheState === "denied") {
        await userEvent.click(screen.getByRole("button", { name: "Read denial" }));
        await waitFor(() => expect(screen.getByTestId("read-result")).toHaveTextContent("rejected"));
        expect(screen.getByTestId("readable")).toHaveTextContent("false");
        expect(screen.getByTestId("cached-project")).toHaveTextContent("unavailable");
        await userEvent.click(screen.getByRole("button", { name: "Read network error" }));
        await waitFor(() => expect(screen.getByTestId("read-result")).toHaveTextContent("rejected"));
        expect(screen.getByTestId("readable")).toHaveTextContent("false");
        expect(screen.getByTestId("cached-project")).toHaveTextContent("unavailable");
      }

      await userEvent.click(screen.getByRole("button", { name: "Start held read" }));
      await heldStarted.promise;
      if (cacheState === "denied") {
        await userEvent.click(screen.getByRole("button", { name: "Acknowledge metadata" }));
      }
      await userEvent.click(screen.getByRole("button", { name: "Remove last observer" }));
      await waitFor(() => expect(screen.getByTestId("read-result")).not.toHaveTextContent("pending"));

      expect({
        aborted: screen.getByTestId("aborted-reads").textContent,
        successes: screen.getByTestId("successful-reads").textContent,
        result: screen.getByTestId("read-result").textContent,
        readable: screen.getByTestId("readable").textContent,
        cached: screen.getByTestId("cached-project").textContent,
      }).toEqual({
        aborted: "1",
        successes: "1",
        result: "rejected",
        readable: cacheState === "denied" ? "false" : "true",
        cached: cacheState === "denied" ? "unavailable" : project.title,
      });
      expect(mocked.updateProject).not.toHaveBeenCalled();
      expect(mocked.moveProject).not.toHaveBeenCalled();
      expect(mocked.convertStoryToTask).not.toHaveBeenCalled();
    },
  );

  it("preserves metadata-confirmed revision when the last observer cancels an older full GET", async () => {
    let reads = 0;
    let abortedReads = 0;
    const heldStarted = deferred<void>();
    let readCachedProject: (() => ProjectDetail | undefined) | undefined;
    mocked.getProject.mockImplementation(async (_id, signal) => {
      reads++;
      if (reads === 1) return detail(4);
      heldStarted.resolve();
      return await new Promise<ProjectDetail>((_resolve, reject) => {
        const abort = () => {
          abortedReads++;
          reject(new DOMException("Query observer left", "AbortError"));
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    });

    function DetailObserver() {
      const query = useProjectDetailQuery(project.id);
      return <button onClick={() => { void query.refetch(); }}>Start older full GET</button>;
    }

    function Reader() {
      const actions = useProjectActions();
      const [observe, setObserve] = useState(true);
      readCachedProject = () => actions.getCachedProject(project.id);
      return <>
        {observe ? <DetailObserver /> : null}
        <button onClick={() => actions.reconcileProjectSnapshot({
          id: project.id, revision: 5, title: "Command-confirmed revision 5", status: project.status,
        })}>Publish confirmed revision 5</button>
        <button onClick={() => setObserve(false)}>Remove last observer</button>
        <output data-testid="reads">{reads}</output>
        <output data-testid="aborted-reads">{abortedReads}</output>
      </>;
    }

    renderWithProviders(<Reader />, { locale: "en" });
    await waitFor(() => expect(readCachedProject?.()?.revision).toBe(4));
    await userEvent.click(screen.getByRole("button", { name: "Start older full GET" }));
    await heldStarted.promise;
    await userEvent.click(screen.getByRole("button", { name: "Publish confirmed revision 5" }));
    await userEvent.click(screen.getByRole("button", { name: "Remove last observer" }));
    await waitFor(() => expect(screen.getByTestId("aborted-reads")).toHaveTextContent("1"));

    expect(screen.getByTestId("reads")).toHaveTextContent("2");
    expect(screen.getByTestId("aborted-reads")).toHaveTextContent("1");
    expect(readCachedProject?.()).toMatchObject({ revision: 5, title: "Command-confirmed revision 5" });
    expect(mocked.updateProject).not.toHaveBeenCalled();
  });

  it("uses the direct target snapshot for activation and the shared snapshot for deadlines in the host", async () => {
    const ancestor = { id: 88, role: "story" as const, title: "Containing project", revision: 1 };
    const child = { ...project, title: "Nested child project", status: "backlog" as const, ownerMemberId: null,
      ancestors: [ancestor] };
    const direct = {
      targetRevision: 1,
      expectedProjects: [{ projectId: child.id, revision: 1 }],
      projects: [{ projectId: child.id, title: "Direct child requirements", revision: 1, ownerMemberId: null,
        required: ["driver", "progressPath"] as Array<"driver" | "progressPath"> }],
    };
    const shared = {
      targetRevision: 1,
      expectedProjects: [...direct.expectedProjects, { projectId: ancestor.id, revision: 1 }],
      projects: [...direct.projects, { projectId: ancestor.id, title: "Ancestor commitment", revision: 1,
        ownerMemberId: null, required: ["driver"] as Array<"driver"> }],
    };
    const childDetail: ProjectDetail = { ...child, tasks: [],
      directActivationDecisionSnapshot: direct, activationDecisionSnapshot: shared };
    const revisedDirect = { ...direct, targetRevision: 2,
      expectedProjects: [{ projectId: child.id, revision: 2 }],
      projects: [{ ...direct.projects[0]!, revision: 2 }] };
    const revisedShared = { ...shared, targetRevision: 2,
      expectedProjects: [{ projectId: child.id, revision: 2 }, { projectId: ancestor.id, revision: 1 }],
      projects: [revisedDirect.projects[0]!, ...shared.projects.slice(1)] };
    let childRevision = 1;
    mocked.getProject.mockImplementation(async id => id === child.id
      ? childRevision === 1 ? childDetail : {
          ...childDetail, status: "active", revision: 2,
          directActivationDecisionSnapshot: revisedDirect, activationDecisionSnapshot: revisedShared,
        }
      : { ...makeProject({ id: ancestor.id, title: ancestor.title }), tasks: [] });
    mocked.activateProject.mockImplementation(async () => {
      childRevision = 2;
      return { ...child, status: "active", revision: 2 };
    });

    function Reader() {
      const workflow = useProjectWorkflow();
      return <>
        <button onClick={() => workflow.open("activateWithDriver", child.id, [ancestor.id])}>Open nested activation</button>
        <button onClick={() => workflow.open("deadline", child.id, [ancestor.id])}>Open nested deadline</button>
        <ProjectWorkflowHost />
      </>;
    }

    renderWithProviders(<Reader />, { locale: "en" });
    await userEvent.click(screen.getByRole("button", { name: "Open nested activation" }));
    await userEvent.selectOptions(await screen.findByLabelText("Lead for “Direct child requirements”"), "1");
    expect(screen.queryByLabelText("Lead for “Ancestor commitment”")).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/concrete next/i), "Start the child only");
    await userEvent.click(screen.getByRole("button", { name: "Start project" }));
    await waitFor(() => expect(mocked.activateProject).toHaveBeenCalledWith(child.id,
      expect.objectContaining({
        expectedRevision: 1,
        activationResolution: {
          expectedProjects: [{ projectId: child.id, revision: 1 }],
          nextActionTitle: "Start the child only",
          drivers: [{ projectId: child.id, ownerMemberId: 1 }],
        },
      })));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    mocked.updateProject.mockRejectedValueOnce(new ApiError(409, "Stale", "stale_write_conflict"));
    await userEvent.click(screen.getByRole("button", { name: "Open nested deadline" }));
    await userEvent.type(screen.getByLabelText("Due"), "2027-02-01{Enter}");
    expect(await screen.findByLabelText("Lead for “Ancestor commitment”")).toBeInTheDocument();
    expect(screen.getByLabelText("Lead for “Direct child requirements”")).toBeInTheDocument();
  });

  it.each([
    ["activateWithDriver", "activate"],
    ["reopenWithDriver", "reopen"],
  ] as const)(
    "%s can use the readable target snapshot while an unrelated ancestor GET remains denied",
    async (kind, action) => {
      const ancestor = { id: 88, role: "story" as const, title: "Hidden ancestor commitment", revision: 1 };
      const childStatus = action === "activate" ? "backlog" : "completed";
      const child = { ...project, title: "Readable direct target", status: childStatus as "backlog" | "completed",
        ownerMemberId: null, ancestors: [ancestor] };
      const direct = {
        targetRevision: 1,
        expectedProjects: [{ projectId: child.id, revision: 1 }],
        projects: [{ projectId: child.id, title: "Direct child requirements", revision: 1,
          ownerMemberId: null, required: ["driver", "progressPath"] as Array<"driver" | "progressPath"> }],
      };
      const childDetail: ProjectDetail = { ...child, tasks: [], directActivationDecisionSnapshot: direct };
      mocked.getProject.mockImplementation(async id => {
        if (id === ancestor.id) throw new ApiError(403, "Ancestor unavailable");
        return childDetail;
      });
      if (action === "activate") mocked.activateProject.mockResolvedValue({ ...child, status: "active", revision: 2 });
      else mocked.reopenProject.mockResolvedValue({ ...child, status: "active", revision: 2 });

      function Reader() {
        const actions = useProjectActions();
        const workflow = useProjectWorkflow();
        return <>
          <button onClick={() => workflow.open(kind, child.id, [ancestor.id])}>Open direct target</button>
          <button onClick={() => void actions.getProject(ancestor.id).catch(() => {})}>Deny hidden ancestor</button>
          <output data-testid="ancestor-readable">{String(actions.isTargetReadable(ancestor.id))}</output>
          <ProjectWorkflowHost />
        </>;
      }

      renderWithProviders(<Reader />, { locale: "en" });
      await userEvent.click(screen.getByRole("button", { name: "Open direct target" }));
      await userEvent.selectOptions(await screen.findByLabelText("Lead for “Direct child requirements”"), "1");
      await userEvent.type(screen.getByLabelText(/concrete next/i), "Start only the child");
      expect(screen.queryByText(ancestor.title)).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Deny hidden ancestor" }));
      await waitFor(() => expect(screen.getByTestId("ancestor-readable")).toHaveTextContent("false"));

      const command = action === "activate" ? mocked.activateProject : mocked.reopenProject;
      await userEvent.click(screen.getByRole("button", { name: action === "activate" ? "Start project" : "Reopen" }));
      await waitFor(() => expect(command).toHaveBeenCalledWith(child.id, expect.objectContaining({
        expectedRevision: 1,
        activationResolution: {
          expectedProjects: [{ projectId: child.id, revision: 1 }],
          nextActionTitle: "Start only the child",
          drivers: [{ projectId: child.id, ownerMemberId: 1 }],
        },
      })));
    },
  );

  it("does not substitute a readable child's direct snapshot for an omitted deadline commitment snapshot", async () => {
    const ancestor = { id: 88, role: "story" as const, title: "Containing project", revision: 1 };
    const shared = {
      targetRevision: 1,
      expectedProjects: [{ projectId: 42, revision: 1 }, { projectId: 88, revision: 1 }],
      projects: [{ projectId: 88, title: "Hidden ancestor commitment", revision: 1,
        ownerMemberId: null, required: ["driver"] as Array<"driver"> }],
    };
    const direct = {
      targetRevision: 2,
      expectedProjects: [{ projectId: 42, revision: 2 }],
      projects: [{ projectId: 42, title: "Direct child requirement", revision: 2,
        ownerMemberId: null, required: ["driver"] as Array<"driver"> }],
    };
    const omitted: ProjectDetail = { ...detail(2), ancestors: [ancestor], directActivationDecisionSnapshot: direct };
    delete omitted.activationDecisionSnapshot;
    mocked.getProject.mockResolvedValue(omitted);
    const onSave = vi.fn().mockRejectedValueOnce(new ApiError(409, "Decisions", "project_commitment_resolution_required", shared));

    function Reader() {
      const actions = useProjectActions();
      const [actual, setActual] = useState<ProjectDetail | null>(null);
      return <>
        <button onClick={() => void actions.readProject(42).then(result => setActual(result.value))}>Read child</button>
        <ProjectDeadlineSheet story={{ ...project, ancestors: [ancestor] }} authoritativeProject={actual}
          onSave={onSave} onClose={vi.fn()} />
      </>;
    }

    renderWithProviders(<Reader />, { locale: "en" });
    await userEvent.type(screen.getByLabelText("Due"), "2027-02-01{Enter}");
    await screen.findByLabelText("Lead for “Hidden ancestor commitment”");
    await userEvent.click(screen.getByRole("button", { name: "Read child" }));
    await waitFor(() => expect(screen.queryByLabelText("Lead for “Hidden ancestor commitment”")).not.toBeInTheDocument());
    expect(screen.queryByLabelText("Lead for “Direct child requirement”")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(onSave).toHaveBeenCalledOnce();
  });

  it("deadline recovery keeps each queued response bound to its own pre-GET ancestor reads", async () => {
      const ancestor = { id: 88, role: "story" as const, title: "Containing project", revision: 1 };
      const sharedSnapshot = (revision: number, directTitle: string, ancestorTitle: string) => ({
        targetRevision: revision,
        expectedProjects: [{ projectId: 42, revision }, { projectId: 88, revision: 1 }],
        projects: [
          { projectId: 42, title: directTitle, revision, ownerMemberId: null, required: ["driver"] as Array<"driver"> },
          { projectId: 88, title: ancestorTitle, revision: 1, ownerMemberId: null, required: ["driver"] as Array<"driver"> },
        ],
      });
      const initialDirect = {
        targetRevision: 3,
        expectedProjects: [{ projectId: 42, revision: 3 }],
        projects: [{ projectId: 42, title: "Direct child requirement", revision: 3,
          ownerMemberId: null, required: ["driver"] as Array<"driver"> }],
      };
      const initialShared = sharedSnapshot(3, "Shared child old", "Ancestor requirement old");
      const story = { ...project, revision: 3, ancestors: [ancestor],
        directActivationDecisionSnapshot: initialDirect, activationDecisionSnapshot: initialShared };
      const makeDetail = (revision: number, suffix: string): ProjectDetail => ({
        ...story, revision, tasks: [],
        directActivationDecisionSnapshot: { ...initialDirect, targetRevision: revision,
          expectedProjects: [{ projectId: 42, revision }],
          projects: [{ ...initialDirect.projects[0]!, title: `Direct child ${suffix}`, revision }] },
        activationDecisionSnapshot: sharedSnapshot(revision, `Shared child ${suffix}`, `Ancestor requirement ${suffix}`),
      });
      const ancestorDetail: ProjectDetail = { ...makeProject({ id: 88, title: ancestor.title }), tasks: [] };
      const obsoleteChild = deferred<ProjectDetail>();
      const freshChild = deferred<ProjectDetail>();
      let childReads = 0;
      let ancestorDenied = false;
      mocked.getProject.mockImplementation(async id => {
        if (id === 88) {
          if (ancestorDenied) throw new ApiError(403, "Ancestor unavailable");
          return ancestorDetail;
        }
        childReads++;
        if (childReads === 1) return makeDetail(3, "old");
        if (childReads === 2) return obsoleteChild.promise;
        return freshChild.promise;
      });
      const onSave = vi.fn().mockRejectedValueOnce(new ApiError(409, "Decisions", "project_commitment_resolution_required", initialShared))
        .mockResolvedValue(undefined);

      function Reader() {
        const actions = useProjectActions();
        const refresh = useRefresh();
        const sourceReads = useRef(new Map([[88, actions.captureTargetRead(88)]]));
        const projectQuery = useProjectDetailQuery(42);
        return <>
          <output data-testid="queued-ancestor-readable">{String(actions.isTargetReadable(88))}</output>
          <button onClick={() => { ancestorDenied = true; void actions.getProject(88).catch(() => {}); }}>Deny ancestor</button>
          <button onClick={() => {
            ancestorDenied = false;
            const release = actions.pauseRetention(88);
            void actions.readProject(88).then(result => {
              release();
            }, release);
          }}>Restore ancestor</button>
          <button onClick={refresh.bump}>Queue fresh recovery</button>
          <ProjectDeadlineSheet story={story} onSave={onSave} onClose={vi.fn()}
            authoritativeProject={projectQuery.data ?? null} qualifiedReads={sourceReads.current} />
        </>;
      }

      const oldLabel = "Lead for “Ancestor requirement old”";
      const freshLabel = "Lead for “Ancestor requirement fresh”";
      renderWithProviders(<Reader />, { locale: "en" });
      await userEvent.type(screen.getByLabelText("Due"), "2027-02-01{Enter}");
      await userEvent.selectOptions(await screen.findByLabelText(oldLabel), "1");
      await userEvent.click(screen.getByRole("button", { name: "Deny ancestor" }));
      await waitFor(() => expect(screen.getByTestId("queued-ancestor-readable")).toHaveTextContent("false"));
      await waitFor(() => expect(screen.queryByLabelText(oldLabel)).not.toBeInTheDocument());
      await userEvent.click(screen.getByRole("button", { name: "Restore ancestor" }));
      await waitFor(() => expect(screen.getByTestId("queued-ancestor-readable")).toHaveTextContent("true"));
      await userEvent.click(await screen.findByRole("button", { name: "Try again" }));
      await waitFor(() => expect(childReads).toBe(2));

      await userEvent.click(screen.getByRole("button", { name: "Deny ancestor" }));
      await waitFor(() => expect(screen.getByTestId("queued-ancestor-readable")).toHaveTextContent("false"));
      await userEvent.click(screen.getByRole("button", { name: "Restore ancestor" }));
      await waitFor(() => expect(screen.getByTestId("queued-ancestor-readable")).toHaveTextContent("true"));
      await userEvent.click(screen.getByRole("button", { name: "Queue fresh recovery" }));
      await waitFor(() => expect(childReads).toBe(3));
      await act(async () => obsoleteChild.resolve(makeDetail(1, "obsolete")));
      expect(screen.queryByLabelText(oldLabel)).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Lead for “Direct requirement obsolete”")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Lead for “Ancestor requirement obsolete”")).not.toBeInTheDocument();

      await act(async () => freshChild.resolve(makeDetail(3, "fresh")));
      await userEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(await screen.findByLabelText(freshLabel)).toHaveValue("1");
      expect(onSave).toHaveBeenCalledOnce();
  });

  it.each([false, true])("a held destination retry cannot clear a newer failure (source still affected: %s)", async sourceAffected => {
    const ancestorX = { id: 88, role: "story" as const, title: "Ancestor X" };
    const source = { ...detail(), ancestors: sourceAffected ? [ancestorX] : [] };
    const first = { ...makeProject({ id: 43, title: "Destination A" }), tasks: [],
      ancestors: [{ id: 88, role: "story" as const, title: "Ancestor X" }] };
    const second = { ...makeProject({ id: 44, title: "Destination B" }), tasks: [],
      ancestors: [{ id: 89, role: "story" as const, title: "Ancestor Y" }] };
    const oldRetry = deferred<ProjectDetail>();
    let xReads = 0;
    let yDenied = false;
    mocked.getProjects.mockResolvedValue([source, first, second]);
    mocked.getProject.mockImplementation(async id => {
      if (id === 88) {
        if (++xReads === 3) return oldRetry.promise;
        throw new ApiError(403, "Ancestor X denied");
      }
      if (id === 89 && yDenied) throw new ApiError(403, "Ancestor Y denied");
      if (id === 89) return { ...makeProject({ id }), tasks: [] };
      return id === 42 ? source : id === 43 ? first : second;
    });
    function Reader() {
      const actions = useProjectActions();
      const [denied, setDenied] = useState<number | null>(null);
      return <>
        <button onClick={() => void actions.getProject(88).catch(() => setDenied(88))}>Deny X</button>
        <button onClick={() => { yDenied = true; void actions.getProject(89).catch(() => setDenied(89)); }}>Deny Y</button>
        <output data-testid="ancestor-y-readable">{String(actions.isTargetReadable(89))}</output>
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
    if (sourceAffected) {
      expect(screen.getByRole("button", { name: "Move here" })).toBeDisabled();
      expect(mocked.moveProject).not.toHaveBeenCalled();
      await act(async () => oldRetry.reject(new ApiError(403, "Ancestor X remains denied")));
      expect(screen.getByRole("button", { name: "Move here" })).toBeDisabled();
      return;
    } else {
      await waitFor(() => expect(screen.getByRole("button", { name: "Move here" })).toBeEnabled());
    }
    fireEvent.click(screen.getByRole("button", { name: "Deny Y", hidden: true }));
    await waitFor(() => expect(screen.getByTestId("ancestor-y-readable")).toHaveTextContent("false"));
    await userEvent.click(screen.getByRole("button", { name: "Move here" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not load Project"));
    expect(screen.getByRole("button", { name: "Move here" })).toBeDisabled();
    if (!sourceAffected) await act(async () => oldRetry.resolve({ ...makeProject({ id: 88 }), tasks: [] }));
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
    await waitFor(() => expect(mocked.getProject).toHaveBeenCalledWith(44, expect.any(AbortSignal)));
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

  it.each([["split", 403], ["entry", 404]] as const)("eighth review: %s keeps its draft while Query recovery rejects a superseded result and accepts a fresh baseline", async (kind, status) => {
    const id = kind === "split" ? 88 : 42;
    const actual = { ...makeProject({ id }), tasks: [], ancestors: [] };
    const obsolete = deferred<ProjectDetail>();
    let response: "fresh" | "denied" | "held" | "initial" = "initial";
    let heldReads = 0;
    mocked.getProject.mockImplementation(async target => {
      if (target !== id) return { ...makeProject({ id: target }), tasks: [] };
      if (response === "denied") throw new ApiError(status, "Containing project denied");
      if (response === "held") { heldReads++; return obsolete.promise; }
      return { ...actual, revision: response === "fresh" ? 2 : 1 };
    });
    mocked.createTaskStepBatchForProject.mockResolvedValue({ project: { ...actual, revision: 3 }, tasks: [] });
    mocked.createTaskStepBatchForTask.mockResolvedValue({ parent: task, tasks: [] });
    function Reader() {
      const actions = useProjectActions();
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>Open editor</button>
        <button onClick={() => {
          response = "denied";
          void actions.getProject(id).catch(() => {});
        }}>Deny project read</button>
        {open ? kind === "split"
          ? <TaskSplitSheet parentId={task.id} parentRevision={1} projectId={id} onClose={vi.fn()} />
          : <ProjectTaskEntrySheet projectId={id} onClose={vi.fn()} /> : null}</>;
    }
    renderWithProviders(<Reader />, { locale: "en" });
    fireEvent.click(screen.getByRole("button", { name: "Open editor" }));
    const editor = await screen.findByPlaceholderText("Step …");
    await userEvent.type(editor, "Exact retained step");
    const name = kind === "split" ? "Create 1 subtask" : "Add task";
    await waitFor(() => expect(screen.getByRole("button", { name })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Deny project read" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name })).toBeDisabled();
    response = "held";
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(heldReads).toBe(1));
    response = "denied";
    fireEvent.click(screen.getByRole("button", { name: "Deny project read" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name })).toBeDisabled();
    await act(async () => obsolete.resolve({ ...actual, revision: 99, title: "Obsolete recovery title" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled());
    expect(screen.getByRole("button", { name })).toBeDisabled();
    expect(screen.queryByText("Obsolete recovery title")).not.toBeInTheDocument();
    response = "fresh";
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByRole("button", { name })).toBeEnabled());
    expect(editor).toBeInTheDocument();
    expect(editor).toHaveValue("Exact retained step");
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
      const [denied, setDenied] = useState(false);
      return <>
        <button onClick={() => {
          mocked.getProject.mockResolvedValueOnce(host);
          void actions.getProject(42).catch(() => {});
        }}>Host initial</button>
        <button onClick={() => {
          mocked.getProject.mockResolvedValueOnce(fresh);
          void actions.getProject(42).catch(() => {});
        }}>Host equal</button>
        <button onClick={() => void actions.getProject(89).catch(() => setDenied(true))}>Deny new ancestor</button>
        <output data-testid="new-ancestor-denied">{String(denied)}</output>
        <ProjectConvertToTaskSheet story={old} onClose={vi.fn()} />
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
      return <><button onClick={() => {
        mocked.getProject.mockResolvedValueOnce({ ...host });
        void actions.getProject(42).catch(() => {});
      }}>Host detail</button>
        <ProjectConvertToTaskSheet story={old} onClose={vi.fn()} /></>;
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
          : kind === "entry" ? <ProjectTaskEntrySheet projectId={42} onClose={vi.fn()} />
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
          : kind === "entry" ? <ProjectTaskEntrySheet projectId={42} onClose={close} />
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
      return <><button onClick={() => void actions.getProject(42).catch(() => {})}>Receive current detail</button>
        <ProjectConvertToTaskSheet story={old} onClose={vi.fn()} /></>;
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
      ? <ProjectTaskEntrySheet projectId={project.id} onClose={vi.fn()} />
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

  it("shows a failed network refresh beside otherwise-readable cached move input", async () => {
    const destination = makeProject({ id: 43, title: "Chosen destination" });
    mocked.getProjects.mockResolvedValue([project, destination]);
    mocked.getProject.mockImplementation(async id => ({ ...(id === 43 ? destination : project), tasks: [] }));
    function Reader() {
      const actions = useProjectActions();
      return <button onClick={() => void actions.getProject(43).catch(() => {})}>Refresh destination</button>;
    }

    renderWithProviders(<><Reader /><MoveProjectSheet story={project} onClose={vi.fn()} /></>, { locale: "en" });
    await userEvent.click(await screen.findByRole("button", { name: destination.title }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Move here" })).toBeEnabled());
    const search = screen.getAllByRole("searchbox")[0]!;
    await userEvent.type(search, "Chosen");
    mocked.getProject.mockRejectedValueOnce(new ApiError(503, "Destination refresh offline"));
    await userEvent.click(screen.getByRole("button", { name: "Refresh destination", hidden: true }));
    const warning = await screen.findByRole("alert");
    expect(warning).toHaveTextContent("Could not refresh Project");
    expect(warning).toHaveTextContent("Something went wrong");
    expect(screen.getAllByRole("searchbox")[0]).toBe(search);
    expect(search).toHaveValue("Chosen");
    expect(screen.getByRole("button", { name: destination.title })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Move here" })).toBeEnabled();
    expect(mocked.moveProject).not.toHaveBeenCalled();
  });

  it("keeps a failed cached task-destination refresh visible without losing the picker", async () => {
    const destination = { ...makeProject({ id: 43, title: "Task destination" }), tasks: [] };
    const sourceTask = makeTask({ id: 9, projectId: 43, title: "Task to move" });
    const recovery = deferred<ProjectDetail>();
    mocked.getProjects.mockResolvedValue([destination]);
    mocked.getProject.mockImplementation(async () => destination);
    function Reader() {
      const actions = useProjectActions();
      return <button onClick={() => void actions.getProject(43).catch(() => {})}>Refresh task destination</button>;
    }

    renderWithProviders(<><Reader /><MoveTaskSheet task={sourceTask} onClose={vi.fn()} /></>, { locale: "en" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Move here" })).toBeEnabled());
    const search = screen.getAllByRole("searchbox")[0]!;
    await userEvent.type(search, "Task");
    mocked.getProject.mockRejectedValueOnce(new ApiError(503, "Task destination refresh offline"));
    await userEvent.click(screen.getByRole("button", { name: "Refresh task destination", hidden: true }));
    const warning = await screen.findByRole("alert");
    expect(warning).toHaveTextContent("Could not refresh Project");
    expect(warning).toHaveTextContent("Something went wrong");
    expect(screen.getAllByRole("searchbox")[0]).toBe(search);
    expect(search).toHaveValue("Task");
    expect(screen.getByRole("button", { name: destination.title })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Move here" })).toBeEnabled();
    expect(mocked.moveTask).not.toHaveBeenCalled();

    mocked.getProject.mockImplementationOnce(async () => recovery.promise);
    await userEvent.click(within(warning).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(mocked.getProject).toHaveBeenCalledTimes(3));
    expect(screen.getByRole("alert")).toHaveTextContent("Could not refresh Project");
    expect(screen.getAllByRole("searchbox")[0]).toBe(search);
    expect(search).toHaveValue("Task");
    await act(async () => recovery.resolve({ ...destination, revision: 2 }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getAllByRole("searchbox")[0]).toBe(search);
    expect(search).toHaveValue("Task");
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
      return <><button onClick={() => void actions.getProject(42).then(setActual).catch(() => {})}>Read deadline target</button>
        <output data-testid="target-revision">{actual?.revision}</output>
        <ProjectDeadlineSheet         story={{ ...project, status: "active", revision: 3,
          ancestors: [{ id: 88, role: "story", title: "Known ancestor", revision: 12 }] }}
          authoritativeProject={actual} onSave={save} onClose={vi.fn()} /></>;
    }
    renderWithProviders(<Authority />, { locale: "en" });
    await userEvent.type(screen.getByLabelText("Due"), "2027-02-01{Enter}");
    await userEvent.selectOptions(await screen.findByLabelText("Lead for “Current ancestor requirements”"), "1");
    await userEvent.type(screen.getByLabelText(/concrete next/i), "Kept active-target draft");
    let highestRevision = 0;
    const read = async (revision: number, title: string) => {
      mocked.getProject.mockResolvedValue({ ...detail(revision), status: "active",
        activationDecisionSnapshot: ancestorDecision(revision, title) });
      fireEvent.click(screen.getByRole("button", { name: "Read deadline target", hidden: true }));
      highestRevision = Math.max(highestRevision, revision);
      await waitFor(() => expect(screen.getByTestId("target-revision")).toHaveTextContent(String(highestRevision)));
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

  it("does not promote a metadata-only revision into full input after a lower detail GET", async () => {
    mocked.getProject.mockResolvedValue(detail(1));
    const metadata = { ...project, revision: 3 };
    function Reader() {
      const actions = useProjectActions();
      const [open, setOpen] = useState(false);
      return <>
        <button onClick={() => {
          actions.captureTargetRead(project.id);
          actions.reconcileProjectSnapshot(metadata);
          setOpen(true);
        }}>Seed confirmed metadata</button>
        <output data-testid="cached-revision">{actions.getCachedStory(project.id)?.revision ?? "missing"}</output>
        <output data-testid="cached-full">{String(actions.getCachedProject(project.id) !== undefined)}</output>
        {open ? <ProjectTaskEntrySheet projectId={project.id} onClose={vi.fn()} /> : null}
      </>;
    }

    renderWithProviders(<Reader />, { locale: "en" });
    await userEvent.click(screen.getByRole("button", { name: "Seed confirmed metadata" }));
    await waitFor(() => expect(screen.getByTestId("cached-revision")).toHaveTextContent("3"));
    await screen.findByRole("alert");
    expect(screen.getByTestId("cached-revision")).toHaveTextContent("3");
    expect(screen.getByTestId("cached-full")).toHaveTextContent("false");
    expect(screen.getByRole("button", { name: "Add task" })).toBeDisabled();
    expect(mocked.createTaskStepBatchForProject).not.toHaveBeenCalled();
  });

  it.each(["activation", "deadline"] as const)(
    "%s lower recovery cannot requalify higher-revision decision requirements",
    async kind => {
      const direct = (title: string) => ({
        targetRevision: 3,
        expectedProjects: [{ projectId: 42, revision: 3 }],
        projects: [{ projectId: 42, title, revision: 3, ownerMemberId: null,
          required: ["driver", "progressPath"] as Array<"driver" | "progressPath"> }],
      });
      const shared = (title: string) => ({
        targetRevision: 3,
        expectedProjects: [{ projectId: 42, revision: 3 }, { projectId: 88, revision: 3 }],
        projects: [{ projectId: 88, title, revision: 3, ownerMemberId: null,
          required: ["driver", "progressPath"] as Array<"driver" | "progressPath"> }],
      });
      const ancestors = [{ id: 88, role: "story" as const, title: "Containing project", revision: 3 }];
      const high = { ...detail(3), ancestors,
        directActivationDecisionSnapshot: direct("Higher direct requirements"),
        activationDecisionSnapshot: shared("Higher shared requirements") };
      let targetResponse: "initial" | "lower" | "equal" = "initial";
      let ancestorDenied = false;
      let targetDenied = false;
      mocked.getProject.mockImplementation(async id => {
        if (id === 88) {
          if (ancestorDenied) throw new ApiError(403, "Ancestor unavailable");
          return { ...makeProject({ id: 88 }), tasks: [] };
        }
        if (targetDenied) throw new ApiError(403, "Target unavailable");
        if (targetResponse === "lower") return { ...detail(1), ancestors,
          directActivationDecisionSnapshot: { ...direct("Lower direct requirements"), targetRevision: 1,
            expectedProjects: [{ projectId: 42, revision: 1 }],
            projects: [{ ...direct("Lower direct requirements").projects[0]!, revision: 1 }] },
          activationDecisionSnapshot: { ...shared("Lower shared requirements"), targetRevision: 1,
            expectedProjects: [{ projectId: 42, revision: 1 }, { projectId: 88, revision: 3 }] } };
        if (targetResponse === "equal") return { ...high,
          directActivationDecisionSnapshot: direct("Fresh direct requirements"),
          activationDecisionSnapshot: shared("Fresh shared requirements") };
        return high;
      });
      const onActivate = vi.fn().mockResolvedValue(false);
      const onSave = vi.fn().mockRejectedValueOnce(new ApiError(409, "Decisions required",
        "project_commitment_resolution_required", shared("Higher shared requirements")));
      function Reader() {
        const actions = useProjectActions();
        const query = useProjectDetailQuery(42);
        const actual = query.data && actions.isCurrentProjectRead(query.data) ? query.data : null;
        useEffect(() => {
          if (kind === "deadline") void actions.readProject(88);
        }, []);
        return <>
          <button onClick={() => { ancestorDenied = true; void actions.getProject(88).catch(() => {}); }}>Deny shared ancestor</button>
          <button onClick={() => { targetDenied = true; void actions.getProject(42).catch(() => {}); }}>Deny target</button>
          {kind === "activation"
            ? <ProjectActivationSheet story={high} authoritativeProject={actual}
                action="activate" onActivate={onActivate} onClose={vi.fn()} />
            : <ProjectDeadlineSheet story={{ ...high, status: "active" }} authoritativeProject={actual}
                onSave={onSave} onClose={vi.fn()} />}
        </>;
      }

      renderWithProviders(<Reader />, { locale: "en" });
      if (kind === "activation") {
        const oldLabel = "Lead for “Higher direct requirements”";
        await userEvent.selectOptions(await screen.findByLabelText(oldLabel), "1");
        await userEvent.type(screen.getByLabelText(/concrete next/i), "Retain direct next action");
        await userEvent.click(screen.getByRole("button", { name: "Deny target" }));
        await waitFor(() => expect(screen.queryByLabelText(oldLabel)).not.toBeInTheDocument());
      } else {
        await userEvent.type(screen.getByLabelText("Due"), "2027-02-01{Enter}");
        const oldLabel = "Lead for “Higher shared requirements”";
        await userEvent.selectOptions(await screen.findByLabelText(oldLabel), "1");
        await userEvent.type(screen.getByLabelText(/concrete next/i), "Retain shared next action");
        ancestorDenied = true;
        fireEvent.click(screen.getByRole("button", { name: "Deny shared ancestor" }));
        await waitFor(() => expect(screen.queryByLabelText(oldLabel)).not.toBeInTheDocument());
      }

      targetResponse = "lower";
      ancestorDenied = false;
      targetDenied = false;
      await userEvent.click(screen.getByRole("button", { name: "Try again" }));
      const expiredLabel = kind === "activation"
        ? "Lead for “Higher direct requirements”"
        : "Lead for “Higher shared requirements”";
      await waitFor(() => expect(
        screen.queryByRole("button", { name: "Try again" }) ?? screen.queryByLabelText(expiredLabel),
      ).toBeTruthy());
      expect(screen.queryByLabelText(expiredLabel)).not.toBeInTheDocument();
      if (kind === "activation") expect(onActivate).not.toHaveBeenCalled();
      else expect(onSave).toHaveBeenCalledOnce();

      targetResponse = "equal";
      await userEvent.click(screen.getByRole("button", { name: "Try again" }));
      if (kind === "activation") {
        expect(await screen.findByLabelText("Lead for “Fresh direct requirements”")).toHaveValue("1");
        expect(screen.getByLabelText(/concrete next/i)).toHaveValue("Retain direct next action");
        expect(onActivate).not.toHaveBeenCalled();
      } else {
        expect(await screen.findByLabelText("Lead for “Fresh shared requirements”")).toHaveValue("1");
        expect(screen.getByLabelText(/concrete next/i)).toHaveValue("Retain shared next action");
        expect(onSave).toHaveBeenCalledOnce();
      }
    },
  );

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
          ? <ProjectActivationSheet story={{ ...project, ancestors: [
              { id: 88, role: "story", title: "Known ancestor", revision: 5 },
            ], activationDecisionSnapshot: snapshot(1), directActivationDecisionSnapshot: snapshot(1) }}
            authoritativeProject={actual} action="activate" onActivate={activate} onClose={vi.fn()} />
          : <ProjectDeadlineSheet story={{ ...project, ancestors: [
              { id: 88, role: "story", title: "Known ancestor", revision: 5 },
            ] }} authoritativeProject={actual} onSave={save} onClose={vi.fn()} />}
      </>;
    }
    renderWithProviders(<Authority />, { locale: "en" });
    if (kind === "deadline") {
      await userEvent.type(screen.getByLabelText("Due"), "2027-02-01{Enter}");
      await screen.findByLabelText(/Lead for/);
      await screen.findByRole("option", { name: "Mira" });
    } else {
      fireEvent.click(screen.getByRole("button", { name: "Receive qualified detail", hidden: true }));
      await screen.findByRole("option", { name: "Mira" });
    }
    await userEvent.selectOptions(screen.getByLabelText(/Lead for/), "1");
    await userEvent.type(screen.getByLabelText(/concrete next/i), "Keep these decisions");
    const receive = () => fireEvent.click(screen.getByRole("button", { name: "Receive qualified detail", hidden: true }));
    const nextSnapshot = (revision: number, derived = false) => ({
      ...snapshot(revision),
      expectedProjects: [{ projectId: 42, revision }, { projectId: 88, revision: 5 }],
      projects: [...snapshot(revision).projects,
        { projectId: 88, title: derived ? "New equal-revision requirement" : "New detail requirement", revision: 5, ownerMemberId: null, required: ["driver"] as Array<"driver"> }],
    });
    const targetSnapshot = (revision: number, derived = false) => ({
      ...snapshot(revision),
      expectedProjects: [{ projectId: 42, revision }],
      projects: [{ ...snapshot(revision).projects[0]!,
        title: derived ? "New equal-revision direct requirement" : "New direct requirement" }],
    });
    const detailWithDecisions = (revision: number, derived = false): ProjectDetail => ({
      ...detail(revision),
      activationDecisionSnapshot: nextSnapshot(revision, derived),
      directActivationDecisionSnapshot: targetSnapshot(revision, derived),
    });
    mocked.getProject.mockResolvedValue(detailWithDecisions(2));
    receive();
    const extra = kind === "activation"
      ? await screen.findByLabelText("Lead for “New direct requirement”")
      : await screen.findByLabelText("Lead for “New detail requirement”");
    expect(screen.getByLabelText(/concrete next/i)).toHaveValue("Keep these decisions");
    const retainedDriverLabel = kind === "activation"
      ? "Lead for “New direct requirement”"
      : `Lead for “${project.title}”`;
    expect(screen.getByLabelText(retainedDriverLabel)).toHaveValue("1");
    if (kind === "deadline") await userEvent.selectOptions(extra, "1");
    mocked.getProject.mockResolvedValue(detailWithDecisions(3));
    receive();
    await waitFor(() => expect(mocked.getProject).toHaveBeenCalledTimes(2));
    mocked.getProject.mockResolvedValue(detail(1));
    receive();
    await waitFor(() => expect(mocked.getProject).toHaveBeenCalledTimes(3));
    const revision3Label = kind === "activation" ? "Lead for “New direct requirement”" : "Lead for “New detail requirement”";
    expect(screen.getByLabelText(revision3Label)).toHaveValue("1");
    mocked.getProject.mockResolvedValue(detailWithDecisions(3, true));
    receive();
    await screen.findByLabelText(kind === "activation"
      ? "Lead for “New equal-revision direct requirement”"
      : "Lead for “New equal-revision requirement”");
    mocked.getProject.mockRejectedValue(new ApiError(503, "Background unavailable"));
    receive();
    await waitFor(() => expect(mocked.getProject).toHaveBeenCalledTimes(5));
    expect(screen.getByLabelText(/concrete next/i)).toHaveValue("Keep these decisions");
    fireEvent.click(screen.getByRole("button", { name: kind === "activation" ? "Start project" : "Save" }));
    if (kind === "activation") {
      await waitFor(() => expect(activate).toHaveBeenCalledWith(1, expect.objectContaining({
        expectedProjects: [{ projectId: 42, revision: 3 }],
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
      ? <ProjectTaskEntrySheet projectId={project.id} onClose={vi.fn()} />
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

  it("TaskConvert prefers an equal-revision host task's newly qualified project ancestry", async () => {
    const old = { ...task, revision: 2, projectId: 42, children: [], dependencies: [],
      ancestors: [
        { id: 42, role: "story" as const, title: "Old project" },
        { id: 88, role: "story" as const, title: "Old outer project" },
      ],
      hierarchyRevisions: [{ id: task.id, revision: 2 }, { id: 42, revision: 4 }, { id: 88, revision: 1 }] };
    const latest = { ...old, projectId: 43,
      ancestors: [{ id: 43, role: "story" as const, title: "New project" }],
      hierarchyRevisions: [{ id: task.id, revision: 2 }, { id: 43, revision: 5 }] };
    mocked.getTask.mockResolvedValue(old);
    let oldAncestorDenied = true;
    mocked.getProject.mockImplementation(async id => {
      if (id === 88 && oldAncestorDenied) throw new ApiError(403, "Old ancestor denied");
      return { ...makeProject({ id }), tasks: [] };
    });
    mocked.previewTaskConversion.mockResolvedValue({ activatingProjects: [], decision: null });
    mocked.convertTaskToStory.mockResolvedValue(project);
    function Conversion() {
      const actions = useProjectActions();
      const [authority, setAuthority] = useState<TaskDetail>(old);
      return <>
        <button onClick={() => void actions.getProject(88).catch(() => {})}>Deny old ancestor</button>
        <button onClick={() => setAuthority(latest)}>Receive equal-revision host chain</button>
        <output data-testid="old-ancestor-readable">{String(actions.isTargetReadable(88))}</output>
        <TaskConvertToProjectSheet task={old} authoritativeTask={authority} onClose={vi.fn()} />
      </>;
    }

    renderWithProviders(<Conversion />, { locale: "en" });
    await userEvent.click(screen.getByRole("button", { name: "Deny old ancestor" }));
    await userEvent.click(screen.getByRole("button", { name: "Convert and start" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByTestId("old-ancestor-readable")).toHaveTextContent("false");
    expect(mocked.previewTaskConversion).not.toHaveBeenCalled();
    expect(mocked.convertTaskToStory).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Receive equal-revision host chain" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Convert and start" })).toBeEnabled());
    expect(screen.getByTestId("old-ancestor-readable")).toHaveTextContent("false");
    expect(mocked.previewTaskConversion).not.toHaveBeenCalled();
    expect(mocked.convertTaskToStory).not.toHaveBeenCalled();
    const oldAncestorReads = mocked.getProject.mock.calls.filter(([id]) => id === 88).length;
    oldAncestorDenied = false;

    await userEvent.click(screen.getByRole("button", { name: "Convert and start" }));
    await waitFor(() => expect(mocked.convertTaskToStory).toHaveBeenCalledWith(task.id,
      expect.objectContaining({
        expectedRevision: 2,
        expectedHierarchyRevisions: [{ id: task.id, revision: 2 }, { id: 43, revision: 5 }],
      })));
    expect(mocked.getProject.mock.calls.filter(([id]) => id === 88)).toHaveLength(oldAncestorReads);
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
    "%s preserves authored input and requires fresh detail after a denied Query read", async kind => {
      const old = { ...detail(), title: "Obsolete qualified project", tasks: [makeTask({ id: 90, title: "Obsolete qualified step" })] };
      const fresh = { ...detail(2), title: "Fresh qualified project", tasks: [makeTask({ id: 91, title: "Fresh qualified step" })] };
      let loaded = false;
      let denied = false;
      let restored = false;
      mocked.getProject.mockImplementation(async id => {
        if (id !== project.id) return { ...makeProject({ id }), tasks: [] };
        if (!loaded) { loaded = true; return old; }
        if (denied) throw new ApiError(kind === "split" ? 403 : 404, "Project unavailable");
        return restored ? fresh : old;
      });
      function Reader() {
        const actions = useProjectActions();
        return <>
          <button onClick={() => { denied = true; void actions.getProject(project.id).catch(() => {}); }}>Deny project</button>
          <button onClick={() => { denied = false; restored = true; void actions.readProject(project.id).catch(() => {}); }}>Restore project</button>
          <output data-testid="cached-project-title">{actions.getCachedProject(project.id)?.title ?? "unavailable"}</output>
          {kind === "entry"
            ? <ProjectTaskEntrySheet projectId={project.id} onClose={vi.fn()} />
            : <TaskSplitSheet parentId={task.id} parentRevision={1} projectId={project.id} onClose={vi.fn()} />}
        </>;
      }

      renderWithProviders(<Reader />, { locale: "en" });
      await waitFor(() => expect(screen.getByTestId("cached-project-title")).toHaveTextContent(old.title));
      await userEvent.type(screen.getAllByPlaceholderText("Step …")[0]!, "Keep authored step");
      await userEvent.click(screen.getByRole("button", { name: "Deny project" }));
      await waitFor(() => expect(screen.getByTestId("cached-project-title")).toHaveTextContent("unavailable"));
      expect(screen.queryByText("Obsolete qualified step")).not.toBeInTheDocument();
      const submit = screen.getByRole("button", { name: kind === "entry" ? "Add task" : "Create 1 subtask" });
      expect(submit).toBeDisabled();
      await userEvent.click(screen.getByRole("button", { name: "Restore project" }));
      await waitFor(() => expect(screen.getByTestId("cached-project-title")).toHaveTextContent(fresh.title));
      expect(screen.queryByText("Obsolete qualified step")).not.toBeInTheDocument();
      expect(screen.getAllByPlaceholderText("Step …")[0]).toHaveValue("Keep authored step");
      expect(submit).toBeEnabled();
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

  it("activation keeps target requirements unavailable until a higher-revision target read replaces them", async () => {
    const direct = (revision: number, title: string) => ({
      targetRevision: revision,
      expectedProjects: [{ projectId: 42, revision }],
      projects: [{ projectId: 42, title, revision, ownerMemberId: null,
        required: ["driver", "progressPath"] as Array<"driver" | "progressPath"> }],
    });
    const target = (revision: number, title: string): ProjectDetail => ({
      ...detail(revision), directActivationDecisionSnapshot: direct(revision, title),
    });
    const story = target(3, "Opening target requirements");
    const obsolete = deferred<ProjectDetail>();
    const current = deferred<ProjectDetail>();
    let reads = 0;
    mocked.getProject.mockImplementation(async () => {
      reads++;
      if (reads === 1) return target(3, "Opening target requirements");
      if (reads === 2) throw new ApiError(403, "Target unavailable");
      if (reads === 3) return obsolete.promise;
      return current.promise;
    });

    function Reader() {
      const actions = useProjectActions();
      const query = useProjectDetailQuery(project.id);
      const authoritative = query.data && actions.isCurrentProjectRead(query.data) ? query.data : null;
      return <>
        <button onClick={() => void actions.getProject(project.id).catch(() => {})}>Deny target</button>
        <button onClick={() => void actions.getProject(project.id).catch(() => {})}>Read newer target</button>
        <ProjectActivationSheet story={story} authoritativeProject={authoritative}
          action="activate" onActivate={vi.fn()} onClose={vi.fn()} />
      </>;
    }

    renderWithProviders(<Reader />, { locale: "en" });
    await userEvent.selectOptions(await screen.findByLabelText("Lead for “Opening target requirements”"), "1");
    await userEvent.type(screen.getByLabelText(/concrete next/i), "Keep target decision");
    await userEvent.click(screen.getByRole("button", { name: "Deny target" }));
    await waitFor(() => expect(screen.queryByLabelText("Lead for “Opening target requirements”")).not.toBeInTheDocument());

    await userEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(reads).toBe(3));
    await userEvent.click(screen.getByRole("button", { name: "Read newer target" }));
    await waitFor(() => expect(reads).toBe(4));
    await act(async () => current.resolve(target(4, "Fresh target requirements")));
    expect(await screen.findByLabelText("Lead for “Fresh target requirements”")).toHaveValue("1");
    expect(screen.getByLabelText(/concrete next/i)).toHaveValue("Keep target decision");
    await act(async () => obsolete.resolve(target(2, "Obsolete target requirements")));
    expect(screen.queryByLabelText("Lead for “Obsolete target requirements”")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Lead for “Fresh target requirements”")).toHaveValue("1");
  });

  it("activation does not close after its target access expires while a write is pending", async () => {
    const decision = {
      targetRevision: 1,
      expectedProjects: [{ projectId: 42, revision: 1 }],
      projects: [{ projectId: 42, title: "Target requirements", revision: 1, ownerMemberId: null,
        required: ["driver", "progressPath"] as Array<"driver" | "progressPath"> }],
    };
    const latest: ProjectDetail = { ...detail(1), directActivationDecisionSnapshot: decision };
    const restored: ProjectDetail = { ...detail(2), directActivationDecisionSnapshot: {
      ...decision, targetRevision: 2, expectedProjects: [{ projectId: 42, revision: 2 }],
      projects: [{ ...decision.projects[0]!, revision: 2, title: "Fresh target requirements" }],
    } };
    const activation = deferred<boolean>();
    const onClose = vi.fn();
    let denyTarget = false;
    let targetReads = 0;
    mocked.getProject.mockImplementation(async () => {
      if (denyTarget) throw new ApiError(403, "Target unavailable");
      targetReads++;
      return targetReads === 1 ? latest : restored;
    });
    const onActivate = vi.fn(() => activation.promise);

    function Reader() {
      const actions = useProjectActions();
      const query = useProjectDetailQuery(42);
      const authoritative = query.data && actions.isCurrentProjectRead(query.data) ? query.data : null;
      return <>
        <button onClick={() => { denyTarget = true; void actions.getProject(42).catch(() => {}); }}>Deny target</button>
        <button onClick={() => { denyTarget = false; void actions.readProject(42); }}>Restore target</button>
        <ProjectActivationSheet story={latest} authoritativeProject={authoritative}
          action="activate" onActivate={onActivate} onClose={onClose} />
      </>;
    }

    renderWithProviders(<Reader />, { locale: "en" });
    await userEvent.selectOptions(await screen.findByLabelText("Lead for “Target requirements”"), "1");
    await userEvent.type(screen.getByLabelText(/concrete next/i), "Keep target draft");
    await userEvent.click(screen.getByRole("button", { name: "Start project" }));
    await waitFor(() => expect(onActivate).toHaveBeenCalledOnce());
    await userEvent.click(screen.getByRole("button", { name: "Deny target" }));
    await waitFor(() => expect(screen.queryByLabelText("Lead for “Target requirements”")).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Restore target" }));
    await act(async () => activation.resolve(true));
    expect(await screen.findByLabelText("Lead for “Fresh target requirements”")).toHaveValue("1");
    expect(screen.getByLabelText(/concrete next/i)).toHaveValue("Keep target draft");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("activation discards stale-write refresh after an explicitly named requirement read expires", async () => {
    const direct = (revision: number, title: string) => ({
      targetRevision: revision,
      expectedProjects: [{ projectId: 42, revision }],
      projects: [{ projectId: 42, title, revision, ownerMemberId: null, required: ["driver", "progressPath"] as Array<"driver" | "progressPath"> }],
    });
    const target = (revision: number, title: string): ProjectDetail => ({
      ...detail(revision), directActivationDecisionSnapshot: direct(revision, title),
    });
    const story = target(3, "Opening target requirement");
    const staleRefresh = deferred<ProjectDetail>();
    let targetDenied = false;
    let targetReads = 0;
    mocked.getProject.mockImplementation(async () => {
      if (targetDenied) throw new ApiError(403, "Target unavailable");
      targetReads++;
      return targetReads === 1 ? story : targetReads === 2 ? staleRefresh.promise : target(5, "Fresh target requirement");
    });
    const activation = deferred<boolean>();
    const onActivate = vi.fn(() => activation.promise);

    function Reader() {
      const actions = useProjectActions();
      const query = useProjectDetailQuery(project.id);
      const authoritative = query.data && actions.isCurrentProjectRead(query.data) ? query.data : null;
      const [closed, setClosed] = useState(false);
      return <>
        <button onClick={() => { targetDenied = true; void actions.getProject(42).catch(() => {}); }}>Deny target during refresh</button>
        <button onClick={() => { targetDenied = false; }}>Restore target access</button>
        <ProjectActivationSheet story={story} authoritativeProject={authoritative}
          action="activate" onActivate={onActivate} onClose={() => setClosed(true)} />
        <output data-testid="activation-closed">{String(closed)}</output>
      </>;
    }

    renderWithProviders(<Reader />, { locale: "en" });
    await userEvent.selectOptions(await screen.findByLabelText("Lead for “Opening target requirement”"), "1");
    await userEvent.type(screen.getByLabelText(/concrete next/i), "Keep target draft");
    await userEvent.click(screen.getByRole("button", { name: "Start project" }));
    await waitFor(() => expect(onActivate).toHaveBeenCalledOnce());
    await act(async () => activation.reject(new ApiError(409, "Stale", "stale_write_conflict")));
    await waitFor(() => expect(targetReads).toBe(2));

    await userEvent.click(screen.getByRole("button", { name: "Deny target during refresh" }));
    await waitFor(() => expect(screen.queryByLabelText("Lead for “Opening target requirement”")).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Restore target access" }));
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByLabelText("Lead for “Fresh target requirement”")).toHaveValue("1");
    expect(screen.getByLabelText(/concrete next/i)).toHaveValue("Keep target draft");
    await act(async () => staleRefresh.resolve(target(4, "Stale refresh requirement")));
    expect(screen.queryByLabelText("Lead for “Stale refresh requirement”")).not.toBeInTheDocument();
    expect(screen.getByTestId("activation-closed")).toHaveTextContent("false");
  });

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

  it.each(["activation", "deadline"] as const)(
    "%s keeps direct activation separate from shared deadline requirements across an omitted shared snapshot",
    async kind => {
      const directRequirement = (revision: number, title: string) => ({
        targetRevision: revision,
        expectedProjects: [{ projectId: 42, revision }],
        projects: [{ projectId: 42, title, revision, ownerMemberId: null,
          required: ["driver", "progressPath"] as Array<"driver" | "progressPath"> }],
      });
      const ancestorRequirement = (revision: number, title: string) => ({
        targetRevision: revision,
        expectedProjects: [{ projectId: 42, revision }, { projectId: 88, revision: 1 }],
        projects: [
          { projectId: 42, title: "Shared child requirements", revision, ownerMemberId: null, required: ["driver", "progressPath"] as Array<"driver" | "progressPath"> },
          { projectId: 88, title, revision: 1, ownerMemberId: null, required: ["driver"] as Array<"driver"> },
        ],
      });
      const ancestors = [{ id: 88, role: "story" as const, title: "Containing project", revision: 1 }];
      const oldSnapshot = ancestorRequirement(1, "Old ancestor requirements");
      const story = { ...project, status: "backlog" as const, ancestors,
        activationDecisionSnapshot: oldSnapshot, directActivationDecisionSnapshot: directRequirement(1, "Old direct requirements") };
      const omitted = detail(2);
      delete omitted.activationDecisionSnapshot;
      omitted.directActivationDecisionSnapshot = directRequirement(2, "Omitted direct requirements");
      omitted.ancestors = ancestors;
      const latest = { ...detail(2), ancestors,
        activationDecisionSnapshot: ancestorRequirement(2, "Fresh ancestor requirements"),
        directActivationDecisionSnapshot: directRequirement(2, "Fresh direct requirements") };
      const initial = { ...detail(1), ancestors,
        activationDecisionSnapshot: oldSnapshot,
        directActivationDecisionSnapshot: directRequirement(1, "Old direct requirements") };
      let childReads = 0;
      let ancestorDenied = true;
      mocked.getProject.mockImplementation(async id => {
        if (id === 88) {
          if (ancestorDenied) throw new ApiError(403, "Ancestor read denied");
          return { ...makeProject({ id: 88 }), tasks: [] };
        }
        childReads++;
        return childReads === 1 ? initial : childReads === 2 ? omitted : latest;
      });
      const onActivate = vi.fn().mockResolvedValue(undefined);
      const onSave = vi.fn().mockRejectedValue(new ApiError(409, "Decisions required",
        "project_commitment_resolution_required", {
          ...oldSnapshot, targetRevision: 1,
        }));
      const oldLabel = kind === "activation" ? "Lead for “Old direct requirements”" : "Lead for “Old ancestor requirements”";
      const freshLabel = kind === "activation" ? "Lead for “Fresh direct requirements”" : "Lead for “Fresh ancestor requirements”";

      function Reader() {
        const actions = useProjectActions();
        const [actual, setActual] = useState<ProjectDetail | null>(null);
        useEffect(() => {
          void actions.readProject(42).then(result => setActual(result.value));
        }, []);
        return <>
          <button onClick={() => void actions.getProject(88).catch(() => {})}>Deny ancestor</button>
          <button onClick={() => { ancestorDenied = false; }}>Restore ancestor access</button>
          <button onClick={() => void actions.readProject(42).then(result => setActual(result.value))}>Read child</button>
          {kind === "activation"
            ? <ProjectActivationSheet story={story} action="activate" onActivate={onActivate} onClose={vi.fn()} authoritativeProject={actual} />
            : <ProjectDeadlineSheet story={{ ...story, status: "active" }} onSave={onSave} onClose={vi.fn()} authoritativeProject={actual} />}
        </>;
      }

      renderWithProviders(<Reader />, { locale: "en" });
      if (kind === "deadline") {
        await userEvent.type(screen.getByLabelText("Due"), "2027-02-01{Enter}");
        await screen.findByLabelText(oldLabel);
      } else {
        await screen.findByLabelText(oldLabel);
      }
      await userEvent.selectOptions(screen.getByLabelText(oldLabel), "1");
      expect(screen.getByLabelText(oldLabel)).toHaveValue("1");
      await userEvent.type(screen.getByLabelText(/concrete next/i), "Keep this decision private");
      fireEvent.click(screen.getByRole("button", { name: "Deny ancestor", hidden: true }));
      await waitFor(() => expect(mocked.getProject).toHaveBeenCalledWith(88, expect.any(AbortSignal)));
      fireEvent.click(screen.getByRole("button", { name: "Read child", hidden: true }));
      await waitFor(() => expect(childReads).toBe(2));

      expect(screen.queryByLabelText(oldLabel)).not.toBeInTheDocument();
      if (kind === "activation") {
        expect(await screen.findByLabelText("Lead for “Omitted direct requirements”")).toHaveValue("1");
        expect(screen.getByLabelText(/concrete next/i)).toHaveValue("Keep this decision private");
        expect(screen.queryByLabelText("Lead for “Old ancestor requirements”")).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Start project" })).toBeEnabled();
        expect(onActivate).not.toHaveBeenCalled();
      } else {
        expect(screen.queryByLabelText(/concrete next/i)).not.toBeInTheDocument();
        expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
        expect(onSave).toHaveBeenCalledTimes(1);

        await userEvent.click(screen.getByRole("button", { name: "Try again" }));
        await waitFor(() => expect(mocked.getProject).toHaveBeenCalledWith(88, expect.any(AbortSignal)));
        expect(screen.queryByLabelText(oldLabel)).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
        expect(onSave).toHaveBeenCalledTimes(1);

        await userEvent.click(screen.getByRole("button", { name: "Restore ancestor access" }));
        await userEvent.click(screen.getByRole("button", { name: "Try again" }));
        await waitFor(() => expect(childReads).toBe(3));
        expect(await screen.findByLabelText(freshLabel)).toHaveValue("1");
        expect(screen.getByLabelText(/concrete next/i)).toHaveValue("Keep this decision private");
        expect(onSave).toHaveBeenCalledTimes(1);
      }
    },
  );

  it.each([403, 404])(
    "MoveTask reports a current containing-project HTTP %s before the source denial invalidates its outer continuation",
    async status => {
      const source = { ...makeProject({ id: 42, title: "Source project" }), tasks: [], ancestors: [] };
      const destination = { ...makeProject({ id: 43, title: "Other project" }), tasks: [], ancestors: [] };
      let denyNextSourceRead = false;
      mocked.getProjects.mockResolvedValue([source, destination]);
      mocked.getProject.mockImplementation(async id => {
        if (id === 42 && denyNextSourceRead) {
          denyNextSourceRead = false;
          throw new ApiError(status, "Containing project read denied");
        }
        return { ...(id === 42 ? source : destination), tasks: [] };
      });
      renderWithProviders(<MoveTaskSheet task={{ ...task, projectId: 42 }} onClose={vi.fn()} />, { locale: "en" });
      await userEvent.click(await screen.findByRole("button", { name: destination.title }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Move here" })).toBeEnabled());

      denyNextSourceRead = true;
      await userEvent.click(screen.getByRole("button", { name: "Move here" }));
      expect(await screen.findByRole("alert")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Move here" })).toBeDisabled();
      expect(mocked.moveTask).not.toHaveBeenCalled();

      mocked.getProject.mockImplementation(async id => ({ ...(id === 42 ? source : destination), revision: 2, tasks: [] }));
      await userEvent.click(screen.getByRole("button", { name: "Try again" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Move here" })).toBeEnabled());
      expect(screen.getByRole("button", { name: destination.title })).toHaveAttribute("aria-pressed", "true");
      expect(mocked.moveTask).not.toHaveBeenCalled();
    },
  );

  it("MoveTask ignores a late containing-project denial after a newer source read supersedes it", async () => {
    const source = { ...makeProject({ id: 42, title: "Source project" }), tasks: [], ancestors: [] };
    const destination = { ...makeProject({ id: 43, title: "Other project" }), tasks: [], ancestors: [] };
    const oldRead = deferred<ProjectDetail>();
    let deferNextSourceRead = false;
    let oldReadStarted = false;
    let newerReadDenied = false;
    mocked.getProjects.mockResolvedValue([source, destination]);
    mocked.getProject.mockImplementation(async id => {
      if (id === 42 && deferNextSourceRead) {
        deferNextSourceRead = false;
        oldReadStarted = true;
        return oldRead.promise;
      }
      if (id === 42 && oldReadStarted) {
        newerReadDenied = true;
        throw new ApiError(403, "Newer source read denied");
      }
      if (id === 42) return { ...source, tasks: [] };
      return { ...destination, tasks: [] };
    });
    function Reader() {
      const actions = useProjectActions();
      return <button onClick={() => void actions.getProject(42).catch(() => {})}>Supersede source read</button>;
    }

    renderWithProviders(<><Reader /><MoveTaskSheet task={{ ...task, projectId: 42 }} onClose={vi.fn()} /></>, { locale: "en" });
    await userEvent.click(await screen.findByRole("button", { name: destination.title }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Move here" })).toBeEnabled());
    deferNextSourceRead = true;
    await userEvent.click(screen.getByRole("button", { name: "Move here" }));
    await waitFor(() => expect(oldReadStarted).toBe(true));
    await userEvent.click(screen.getByRole("button", { name: "Supersede source read", hidden: true }));
    await waitFor(() => expect(newerReadDenied).toBe(true));
    await act(async () => oldRead.reject(new ApiError(403, "Obsolete containing-project denial")));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(mocked.moveTask).not.toHaveBeenCalled();
  });

  it.each([42, 43])(
    "MoveProject restores its own denied base target %s before retrying an earlier ancestor failure",
    async deniedBaseId => {
      const ancestor = { id: 88, role: "story" as const, title: "Denied ancestor" };
      const source = { ...detail(), ancestors: [ancestor] };
      const destination = { ...makeProject({ id: 43, title: "Selected destination" }), tasks: [], ancestors: [] };
      let denyAncestor = true;
      let denyBase = false;
      let ancestorReads = 0;
      mocked.getProjects.mockResolvedValue([source, destination]);
      mocked.getProject.mockImplementation(async id => {
        if (id === 88) {
          ancestorReads++;
          if (denyAncestor) throw new ApiError(403, "Ancestor unavailable");
          return { ...makeProject({ id: 88 }), tasks: [] };
        }
        if (id === deniedBaseId && denyBase) {
          denyBase = false;
          throw new ApiError(403, "Base target unavailable");
        }
        return id === 42 ? source : destination;
      });
      function Reader() {
        const actions = useProjectActions();
        return <>
          <button onClick={() => void actions.getProject(88).catch(() => {})}>Deny ancestor</button>
          <button onClick={() => {
            denyBase = true;
            void actions.getProject(deniedBaseId).catch(() => {});
          }}>Deny base reader</button>
        </>;
      }
      renderWithProviders(<><Reader /><MoveProjectSheet story={source} onClose={vi.fn()} /></>, { locale: "en" });
      await userEvent.click(await screen.findByRole("button", { name: destination.title }));
      fireEvent.click(screen.getByRole("button", { name: "Deny ancestor", hidden: true }));
      await waitFor(() => expect(ancestorReads).toBe(1));
      await userEvent.click(screen.getByRole("button", { name: "Move here" }));
      await screen.findByRole("button", { name: "Try again" });
      expect(ancestorReads).toBe(2);

      fireEvent.click(screen.getByRole("button", { name: "Deny base reader", hidden: true }));
      await waitFor(() => expect(mocked.getProject).toHaveBeenCalledWith(deniedBaseId, expect.any(AbortSignal)));
      const baseReadsBefore = mocked.getProject.mock.calls.filter(([id]) => id === deniedBaseId).length;
      const retry = screen.getByRole("button", { name: "Try again" });
      const ancestorReadsBefore = ancestorReads;
      await userEvent.click(retry);
      await waitFor(() => expect(mocked.getProject.mock.calls.filter(([id]) => id === deniedBaseId).length).toBeGreaterThan(baseReadsBefore));
      expect(ancestorReads).toBe(ancestorReadsBefore);
      expect(screen.getByRole("button", { name: "Move here" })).toBeDisabled();
      expect(mocked.moveProject).not.toHaveBeenCalled();

      await waitFor(() => expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument());
      const afterBase = ancestorReads;
      await userEvent.click(screen.getByRole("button", { name: "Try again" }));
      await waitFor(() => expect(ancestorReads).toBeGreaterThan(afterBase));
      expect(screen.getByRole("button", { name: "Move here" })).toBeDisabled();
      expect(mocked.moveProject).not.toHaveBeenCalled();

      denyAncestor = false;
      await userEvent.click(screen.getByRole("button", { name: "Try again" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Move here" })).toBeEnabled());
      expect(mocked.moveProject).not.toHaveBeenCalled();
    },
  );

  it.each(["known changed", "unknown"] as const)(
    "TaskConvert scopes an ancestor failure across a %s host-chain refresh without clearing canonical denial",
    async chainState => {
    const oldTask: TaskDetail = { ...task, projectId: 42, ancestors: [],
      hierarchyRevisions: [{ id: task.id, revision: 1 }, { id: 42, revision: 1 }, { id: 88, revision: 1 }] };
    const containing = { ...detail(), ancestors: [{ id: 88, role: "story" as const, title: "Denied ancestor" }] };
    const knownNewTask = { ...oldTask, revision: 2, projectId: 43,
      ancestors: [{ id: 43, role: "story" as const, title: "New containing project" }],
      hierarchyRevisions: [{ id: task.id, revision: 2 }, { id: 43, revision: 1 }] };
    const newTask = chainState === "known changed" ? knownNewTask : (() => {
      const { hierarchyRevisions: _hierarchyRevisions, ...withoutHierarchy } = knownNewTask;
      return withoutHierarchy;
    })();
    mocked.getTask.mockResolvedValue(oldTask);
    mocked.getProject.mockImplementation(async id => {
      if (id === 88) throw new ApiError(403, "Ancestor unavailable");
      return id === 42 ? containing : { ...makeProject({ id: 43 }), tasks: [] };
    });
    mocked.previewTaskConversion.mockResolvedValue({ activatingProjects: [], decision: null });
    let ancestorReads = 0;
    function Conversion() {
      const actions = useProjectActions();
      const [authority, setAuthority] = useState(oldTask);
      return <>
        <button onClick={() => void actions.getProject(88).catch(() => { ancestorReads++; })}>Deny ancestor</button>
        <button onClick={() => setAuthority(newTask)}>Refresh host chain</button>
        <TaskConvertToProjectSheet task={authority} authoritativeTask={authority} onClose={vi.fn()} />
      </>;
    }
    renderWithProviders(<Conversion />, { locale: "en" });
    await userEvent.click(screen.getByRole("button", { name: "Deny ancestor" }));
    await userEvent.click(screen.getByRole("button", { name: "Convert to project" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    await waitFor(() => expect(ancestorReads).toBe(1));
    expect(screen.getByRole("button", { name: "Convert to project" })).toBeDisabled();
    expect(mocked.convertTaskToStory).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Refresh host chain" }));
    if (chainState === "known changed") {
      await waitFor(() => expect(screen.getByRole("button", { name: "Convert to project" })).toBeEnabled());
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    } else {
      expect(screen.getByRole("button", { name: "Convert to project" })).toBeDisabled();
      expect(screen.getByRole("alert")).toBeInTheDocument();
    }
    expect(mocked.getProject.mock.calls.filter(([id]) => id === 88)).toHaveLength(2);
    expect(mocked.previewTaskConversion).not.toHaveBeenCalled();
    expect(mocked.convertTaskToStory).not.toHaveBeenCalled();
    },
  );
});
