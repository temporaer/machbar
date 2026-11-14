import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../lib/api";
import { useRefresh } from "../lib/refresh";
import { useTaskActions } from "../lib/useTaskActions";
import { useProjectActions } from "../lib/useProjectActions";
import { useTaskWorkflow } from "../lib/taskWorkflowContext";
import { useProjectWorkflow } from "../lib/projectWorkflowContext";
import { de as strings } from "../i18n/de";
import { makeMember, makePhysicalContext, makeProject, makeTag, makeTask } from "../test/fixtures";
import { renderWithProviders } from "../test/testUtils";
import { TaskWorkflowHost } from "./TaskWorkflowHost";
import { ProjectWorkflowHost } from "./ProjectWorkflowHost";
import { TaskTagsSheet } from "./TaskTagsSheet";
import { ProjectTagsSheet } from "./ProjectTagsSheet";
import { TaskContextsSheet } from "./TaskContextsSheet";
import { ProjectContextsSheet } from "./ProjectContextsSheet";
import { ProjectConvertToTaskSheet } from "./ProjectConvertToTaskSheet";

type Target = "task" | "project";
const task = makeTask({ id: 731, title: "Protected task", revision: 1 });
const project = { ...makeProject({ id: 731, title: "Protected project", revision: 1 }), tasks: [] };
const integration: Awaited<ReturnType<typeof api.getHomeAssistantStatus>> = {
  connected: false, instanceId: null, protocolVersion: null, connectedAt: null, lastUpdateAt: null,
  stale: false, supportedProtocolVersion: 3, protocolOutdated: false, lastRequestPollAt: null,
  workerOnline: false, intake: null, intakeReady: false, people: [],
  contexts: [makePhysicalContext({ name: "Current context" })],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function WriteControls({ target }: { target: Target }) {
  const taskActions = useTaskActions();
  const projectActions = useProjectActions();
  const { bump } = useRefresh();
  return <>
    <button onClick={bump}>Start background read</button>
    <button onClick={() => {
      if (target === "task") void taskActions.update(task, { notes: "Accepted write" }, true);
      else void projectActions.update(project, { notes: "Accepted write" }, true);
    }}>Save independent property</button>
  </>;
}

function HostControls({ target }: { target: Target }) {
  const taskWorkflow = useTaskWorkflow();
  const projectWorkflow = useProjectWorkflow();
  return <>
    <WriteControls target={target} />
    <button onClick={() => {
      if (target === "task") taskWorkflow.open("refinement", task.id);
      else projectWorkflow.open("refinement", project.id);
    }}>Open refinement</button>
    {target === "task" ? <TaskWorkflowHost /> : <ProjectWorkflowHost />}
  </>;
}

describe("canceled read callback authority", () => {
  beforeEach(() => {
    localStorage.setItem("machbar:identity-member-id", "1");
    vi.spyOn(api, "getMembers").mockResolvedValue([makeMember({ id: 1 })]);
    vi.spyOn(api, "getAuthStatus").mockResolvedValue({ enabled: false, authenticated: false, member: null });
    vi.spyOn(api, "getTask").mockResolvedValue(task);
    vi.spyOn(api, "getProject").mockResolvedValue(project);
    vi.spyOn(api, "updateTask").mockResolvedValue({ ...task, revision: 2 });
    vi.spyOn(api, "updateProject").mockResolvedValue({ ...project, revision: 2 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  describe.each<Target>(["task", "project"])("%s workflow", target => {
    it.each([403, 404])("preserves current authored text after canceled GET %s, but ends on a live denial", async status => {
      const oldTask = deferred<Awaited<ReturnType<typeof api.getTask>>>();
      const oldProject = deferred<Awaited<ReturnType<typeof api.getProject>>>();
      const getTask = vi.mocked(api.getTask)
        .mockResolvedValueOnce(task).mockReturnValueOnce(oldTask.promise)
        .mockResolvedValue({ ...task, title: "Current task", revision: 2 });
      const getProject = vi.mocked(api.getProject)
        .mockResolvedValueOnce(project).mockReturnValueOnce(oldProject.promise)
        .mockResolvedValue({ ...project, title: "Current project", revision: 2 });
      const read = target === "task" ? getTask : getProject;
      renderWithProviders(<HostControls target={target} />);
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Open refinement" }));
      const instruction = await screen.findByLabelText(strings.workRefinementInstructionLabel);
      await user.type(instruction, "Current authored focus");
      await user.click(screen.getByRole("button", { name: "Start background read" }));
      await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
      await user.click(screen.getByRole("button", { name: "Save independent property" }));
      await screen.findByRole("dialog", { name: `${strings.workRefinement}: Current ${target}` });
      expect(read).toHaveBeenCalledTimes(3);

      await act(async () => {
        const error = new ApiError(status, "Canceled denied read");
        if (target === "task") oldTask.reject(error);
        else oldProject.reject(error);
      });
      expect(instruction).toBeInTheDocument();
      expect(instruction).toHaveValue("Current authored focus");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();

      const liveError = new ApiError(status, "Live denied read");
      if (target === "task") getTask.mockRejectedValueOnce(liveError);
      else getProject.mockRejectedValueOnce(liveError);
      await user.click(screen.getByRole("button", { name: "Start background read" }));
      await screen.findByRole("alert");
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
      expect(screen.getByRole("dialog")).not.toHaveTextContent(`Current ${target}`);
    });
  });

  it("ignores access denial from a canceled project read after reopening the same workflow", async () => {
    const oldProject = deferred<Awaited<ReturnType<typeof api.getProject>>>();
    const getProject = vi.mocked(api.getProject)
      .mockResolvedValueOnce(project)
      .mockReturnValueOnce(oldProject.promise)
      .mockResolvedValue(project);
    renderWithProviders(<HostControls target="project" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Open refinement" }));
    await user.click(screen.getByRole("button", { name: "Start background read" }));
    await waitFor(() => expect(getProject).toHaveBeenCalledTimes(2));

    await user.click(screen.getByRole("button", { name: "Open refinement" }));
    const instruction = await screen.findByLabelText(strings.workRefinementInstructionLabel);
    await user.type(instruction, "Current replacement focus");
    await act(async () => oldProject.reject(new ApiError(403, "Retired denied read")));

    expect(instruction).toHaveValue("Current replacement focus");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each(["task-tags", "project-tags", "task-contexts", "project-contexts", "project-conversion"] as const)(
    "retires canceled %s error forwarding while preserving live error forwarding",
    async kind => {
      const oldTags = deferred<Awaited<ReturnType<typeof api.getTags>>>();
      const oldContexts = deferred<Awaited<ReturnType<typeof api.getHomeAssistantStatus>>>();
      const oldProject = deferred<Awaited<ReturnType<typeof api.getProject>>>();
      const tags = vi.spyOn(api, "getTags").mockReturnValueOnce(oldTags.promise)
        .mockResolvedValue([makeTag({ name: "Current tag" })]);
      const contexts = vi.spyOn(api, "getHomeAssistantStatus").mockReturnValueOnce(oldContexts.promise)
        .mockResolvedValue(integration);
      const projects = vi.mocked(api.getProject).mockReturnValueOnce(oldProject.promise)
        .mockResolvedValue({ ...project, revision: 2 });
      const onFailure = vi.fn();
      const onClose = vi.fn();
      const editor = kind === "task-tags" ? <TaskTagsSheet task={task} onClose={onClose} onFailure={onFailure} />
        : kind === "project-tags" ? <ProjectTagsSheet story={project} onClose={onClose} onSave={async () => {}} onFailure={onFailure} />
        : kind === "task-contexts" ? <TaskContextsSheet task={task} onClose={onClose} onFailure={onFailure} />
        : kind === "project-contexts" ? <ProjectContextsSheet story={project} onClose={onClose} onFailure={onFailure} />
        : <ProjectConvertToTaskSheet story={project} onClose={onClose} onFailure={onFailure} />;
      const read = kind.endsWith("tags") ? tags : kind.endsWith("contexts") ? contexts : projects;
      renderWithProviders(<><WriteControls target={kind.startsWith("task") ? "task" : "project"} />{editor}</>);
      const user = userEvent.setup();
      await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
      await user.click(screen.getByRole("button", { name: "Save independent property" }));
      await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
      if (kind.endsWith("tags")) await screen.findByRole("button", { name: "Current tag" });
      if (kind.endsWith("contexts")) await screen.findByRole("button", { name: "Current context" });
      if (kind === "project-conversion") {
        const title = await screen.findByLabelText(strings.title);
        await user.clear(title);
        await user.type(title, "Current authored conversion");
      }

      const oldError = new ApiError(403, "Canceled denied read");
      await act(async () => {
        if (kind.endsWith("tags")) oldTags.reject(oldError);
        else if (kind.endsWith("contexts")) oldContexts.reject(oldError);
        else oldProject.reject(oldError);
      });
      expect(onFailure).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      if (kind === "project-conversion") expect(screen.getByLabelText(strings.title)).toHaveValue("Current authored conversion");

      const liveError = new ApiError(404, "Live missing read");
      if (kind.endsWith("tags")) tags.mockRejectedValueOnce(liveError);
      else if (kind.endsWith("contexts")) contexts.mockRejectedValueOnce(liveError);
      else projects.mockRejectedValueOnce(liveError);
      await user.click(screen.getByRole("button", { name: "Start background read" }));
      await waitFor(() => expect(onFailure).toHaveBeenCalledExactlyOnceWith(liveError));
    },
  );
});
