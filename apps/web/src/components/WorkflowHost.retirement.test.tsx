import { StrictMode, useState } from "react";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../lib/api";
import { useIdentity } from "../lib/identity";
import { ProjectWorkflowProvider, useProjectWorkflow } from "../lib/projectWorkflowContext";
import { TaskWorkflowProvider, useTaskWorkflow } from "../lib/taskWorkflowContext";
import { readRecentDestinationIds } from "../lib/recentDestinations";
import { de as strings } from "../i18n/de";
import { makeMember, makeProject, makeTask } from "../test/fixtures";
import { renderWithProviders } from "../test/testUtils";
import { ProjectWorkflowHost } from "./ProjectWorkflowHost";
import { TaskWorkflowHost } from "./TaskWorkflowHost";

type Target = "task" | "project";

function OpeningControls({ target }: { target: Target }) {
  const task = useTaskWorkflow();
  const project = useProjectWorkflow();
  return <>
    <button onClick={() => target === "task" ? task.open("refinement", 731) : project.open("refinement", 731)}>Open refinement</button>
    <button onClick={() => target === "task" ? task.open("changeProject", 731) : project.open("move", 731)}>Open move</button>
    {target === "task" ? <TaskWorkflowHost /> : <ProjectWorkflowHost />}
  </>;
}

function ProjectOpeningControls() {
  const project = useProjectWorkflow();
  return <>
    <output aria-label="Project opening id">{project.currentOpeningId ?? "closed"}</output>
    <button onClick={() => {
      project.open("refinement", 731);
      project.open("refinement", 731);
    }}>Open same refinement twice</button>
  </>;
}

function KeyedHostScope({ target }: { target: Target }) {
  const identity = useIdentity();
  const [scope, setScope] = useState(0);
  const location = useLocation();
  return <>
    <output aria-label="Current path">{location.pathname}</output>
    <button onClick={() => {
      identity.setCurrentMemberId(2);
      setScope(value => value + 1);
    }}>Replace identity scope</button>
    <TaskWorkflowProvider key={scope}>
      <ProjectWorkflowProvider>
        <ProjectOpeningControls />
        <OpeningControls target={target} />
      </ProjectWorkflowProvider>
    </TaskWorkflowProvider>
  </>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const task = makeTask({ id: 731, title: "Scoped task", revision: 7 });
const source = { ...makeProject({ id: 731, title: "Scoped project", revision: 7 }), tasks: [] };
const destination = { ...makeProject({ id: 732, title: "Destination" }), tasks: [] };

describe("workflow host keyed-unmount retirement", () => {
  beforeEach(() => {
    localStorage.setItem("machbar:identity-member-id", "1");
    vi.spyOn(api, "getMembers").mockResolvedValue([makeMember({ id: 1 }), makeMember({ id: 2 })]);
    vi.spyOn(api, "getAuthStatus").mockResolvedValue({ enabled: false, authenticated: false, member: null });
    vi.spyOn(api, "getTask").mockResolvedValue(task);
    vi.spyOn(api, "getProject").mockImplementation(async id => id === 731 ? source : destination);
    vi.spyOn(api, "getProjects").mockResolvedValue([source, destination]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  it.each<Target>(["task", "project"])("retires held %s refinement navigation while the replacement remains usable under StrictMode", async target => {
    const retired = deferred<{ id: string }>();
    const start = vi.spyOn(api, "startWorkRefinement")
      .mockReturnValueOnce(retired.promise)
      .mockResolvedValue({ id: "replacement-intake" });
    renderWithProviders(<StrictMode><KeyedHostScope target={target} /></StrictMode>);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Open refinement" }));
    await user.click(await screen.findByRole("button", { name: strings.workRefinementGenerate }));
    expect(start).toHaveBeenCalledWith(target, 731, { expectedRevision: 7, intent: "improve" });

    await user.click(screen.getByRole("button", { name: "Replace identity scope" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open refinement" }));
    const instruction = await screen.findByLabelText(strings.workRefinementInstructionLabel);
    await user.type(instruction, "Replacement authored focus");
    await act(async () => retired.resolve({ id: "retired-intake" }));

    expect(screen.getByLabelText("Current path")).toHaveTextContent(/^\/$/);
    expect(instruction).toHaveValue("Replacement authored focus");
    expect(start).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: strings.workRefinementGenerate }));
    await waitFor(() => expect(screen.getByLabelText("Current path")).toHaveTextContent("/intake/replacement-intake"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("assigns a distinct opening identity to each batched same-project open", async () => {
    renderWithProviders(<KeyedHostScope target="project" />);
    const user = userEvent.setup();
    const openingId = screen.getByLabelText("Project opening id");
    await user.click(screen.getByRole("button", { name: "Open refinement" }));
    const firstOpeningId = Number(openingId.textContent);

    await user.click(screen.getByRole("button", { name: "Open same refinement twice" }));

    expect(Number(openingId.textContent)).toBe(firstOpeningId + 2);
  });

  it.each(["resolve", "deny"] as const)(
    "retires a held project refinement %s after same-project replacement and close/reopen",
    async outcome => {
      const retired = deferred<{ id: string }>();
      const start = vi.spyOn(api, "startWorkRefinement")
        .mockReturnValueOnce(retired.promise)
        .mockResolvedValue({ id: "replacement-intake" });
      renderWithProviders(<StrictMode><KeyedHostScope target="project" /></StrictMode>);
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Open refinement" }));
      await user.click(await screen.findByRole("button", { name: strings.workRefinementGenerate }));
      expect(start).toHaveBeenCalledTimes(1);

      await user.click(screen.getByRole("button", { name: "Open refinement" }));
      let instruction = await screen.findByLabelText(strings.workRefinementInstructionLabel);
      await user.type(instruction, "Draft before close");
      await user.click(screen.getByRole("button", { name: strings.cancel }));
      await user.click(screen.getByRole("button", { name: "Open refinement" }));
      instruction = await screen.findByLabelText(strings.workRefinementInstructionLabel);
      await user.type(instruction, "Replacement draft");

      await act(async () => {
        if (outcome === "resolve") retired.resolve({ id: "retired-intake" });
        else retired.reject(new ApiError(403, "Retired denial"));
      });

      expect(screen.getByLabelText("Current path")).toHaveTextContent(/^\/$/);
      expect(instruction).toHaveValue("Replacement draft");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: strings.workRefinementGenerate }));
      await waitFor(() => expect(screen.getByLabelText("Current path")).toHaveTextContent("/intake/replacement-intake"));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    },
  );

  it.each<Target>(["task", "project"])("retires held %s move destination publication after keyed unmount", async target => {
    const taskMove = deferred<Awaited<ReturnType<typeof api.moveTask>>>();
    const projectMove = deferred<Awaited<ReturnType<typeof api.moveProject>>>();
    const moveTask = vi.spyOn(api, "moveTask").mockReturnValueOnce(taskMove.promise).mockResolvedValue(task);
    const moveProject = vi.spyOn(api, "moveProject").mockReturnValueOnce(projectMove.promise).mockResolvedValue(source);
    renderWithProviders(<StrictMode><KeyedHostScope target={target} /></StrictMode>);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Open move" }));
    await user.click(await screen.findByRole("button", { name: "Destination" }));
    const submit = screen.getByRole("button", { name: strings.moveHere });
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    expect(target === "task" ? moveTask : moveProject).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Replace identity scope" }));
    await user.click(screen.getByRole("button", { name: "Open refinement" }));
    const instruction = await screen.findByLabelText(strings.workRefinementInstructionLabel);
    await user.type(instruction, "Replacement draft");
    await act(async () => {
      if (target === "task") taskMove.resolve(task);
      else projectMove.resolve(source);
    });

    expect(readRecentDestinationIds("project")).toEqual([]);
    expect(instruction).toHaveValue("Replacement draft");
    expect(screen.getByLabelText("Current path")).toHaveTextContent(/^\/$/);
  });
});
