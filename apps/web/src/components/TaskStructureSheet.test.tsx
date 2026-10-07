import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation } from "react-router-dom";
import { renderWithProviders } from "../test/testUtils";
import { api } from "../lib/api";
import { makeMember, makeProject, makeTask } from "../test/fixtures";
import { useTaskWorkflow } from "../lib/taskWorkflowContext";
import { TaskWorkflowHost } from "./TaskWorkflowHost";
import { ProjectWorkflowHost } from "./ProjectWorkflowHost";
import { de as strings } from "../i18n/de";

/**
 * Coverage for the fixed row rail's `Struktur` sheet
 * (`TaskStructureSheet.tsx`): it never renders its own workflow, it only
 * dispatches `task.split`/`task.changeProject`/`task.convertToProject`,
 * and `TaskWorkflowHost` opens the correct destination sheet for each —
 * including the `task.convertToProject` conversion flow's behaviour, which
 * used to be reachable from the task detail's own `Weitere Aktionen` list
 * (see `TaskDetailSheet.test.tsx`) before movement/conversion moved to this
 * rail sheet exclusively.
 */

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    getTags: vi.fn(),
    getTask: vi.fn(),
    convertTaskToStory: vi.fn(),
    createChildTask: vi.fn(),
    moveTask: vi.fn(),
    getProjects: vi.fn(),
    getProject: vi.fn(),
    activateProject: vi.fn(),
    updateProject: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

function OpenStructureHarness({ taskId }: { taskId: number }) {
  const workflow = useTaskWorkflow();
  return (
    <button type="button" onClick={() => workflow.open("structure", taskId)}>
      open structure
    </button>
  );
}

function LocationProbe() {
  const location = useLocation();
  return <output>{location.pathname}{location.search}</output>;
}

function renderStructure(taskId: number) {
  return renderWithProviders(
    <div>
      <OpenStructureHarness taskId={taskId} />
      <TaskWorkflowHost />
      <ProjectWorkflowHost />
    </div>,
  );
}

describe("TaskStructureSheet routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.getMembers.mockResolvedValue([]);
    mockedApi.getTags.mockResolvedValue([]);
    mockedApi.getProjects.mockResolvedValue([]);
    mockedApi.getProject.mockResolvedValue({
      id: 2,
      title: "Ziel-Projekt",
      tasks: [],
    } as never);
  });

  it("dispatches task.split and opens TaskSplitSheet, not a sheet of its own", async () => {
    const task = makeTask({ id: 70, title: "Umzug organisieren", status: "actionable" });
    mockedApi.getTask.mockResolvedValue(task);
    renderStructure(70);

    await userEvent.click(screen.getByRole("button", { name: "open structure" }));
    await userEvent.click(await screen.findByRole("button", { name: "Aufteilen" }));

    expect(await screen.findByRole("dialog", { name: "Aufgabe aufteilen" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Schritt …")).toBeInTheDocument();
  });

  it("dispatches task.changeProject and opens MoveTaskSheet", async () => {
    const task = makeTask({ id: 71, title: "Regal montieren", status: "actionable", projectId: 2 });
    mockedApi.getTask.mockResolvedValue(task);
    renderStructure(71);

    await userEvent.click(screen.getByRole("button", { name: "open structure" }));
    await userEvent.click(await screen.findByRole("button", { name: "Verschieben …" }));

    expect(
      await screen.findByRole("dialog", { name: "In anderes Projekt verschieben" }),
    ).toBeInTheDocument();
  });

  it("dispatches task.convertToProject and opens the conversion workflow", async () => {
    const task = makeTask({
      id: 72,
      title: "Keller organisieren",
      status: "actionable",
      projectId: null,
      parentTaskId: null,
      children: [makeTask({ id: 73, parentTaskId: 72, title: "Regale ausmessen" })],
    });
    mockedApi.getTask.mockResolvedValue(task);
    renderStructure(72);

    await userEvent.click(screen.getByRole("button", { name: "open structure" }));
    await userEvent.click(await screen.findByRole("button", { name: "Zum Projekt machen" }));

    await userEvent.click(await screen.findByRole("button", { name: "Ins Backlog" }));

    await waitFor(() =>
      expect(mockedApi.convertTaskToStory).toHaveBeenCalledWith(72, {
        status: "backlog",
        expectedRevision: 1,
      }),
    );
  });

  it("explains in the conversion workflow why a non-standalone task cannot convert", async () => {
    const task = makeTask({ id: 74, title: "Teilaufgabe", parentTaskId: 58, status: "actionable" });
    mockedApi.getTask.mockResolvedValue(task);
    renderStructure(74);

    await userEvent.click(screen.getByRole("button", { name: "open structure" }));
    await userEvent.click(await screen.findByRole("button", { name: "Zum Projekt machen" }));

    expect(
      await screen.findByText(
        "Nur eigenständige Aufgaben ohne Elternaufgabe und Projekt können zu einem Projekt werden.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ins Backlog" })).not.toBeInTheDocument();
    expect(mockedApi.convertTaskToStory).not.toHaveBeenCalled();
  });

  it("collects a driver and activates a converted project in the same flow", async () => {
    const nextAction = makeTask({ id: 73, projectId: 72, executable: true });
    const project = makeProject({
      id: 72,
      title: "Keller organisieren",
      status: "backlog",
      ownerMemberId: null,
      revision: 2,
      nextAction,
    });
    mockedApi.getTask.mockResolvedValue(makeTask({ id: 72, status: "captured" }));
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1, name: "Mira" })]);
    mockedApi.convertTaskToStory.mockResolvedValue(project);
    mockedApi.getProject.mockResolvedValue({ ...project, tasks: [nextAction] });
    mockedApi.activateProject.mockResolvedValue({
      ...project,
      status: "active",
      ownerMemberId: 1,
      revision: 3,
      availableActions: ["return_to_backlog", "complete", "archive"],
    });
    renderStructure(72);

    await userEvent.click(screen.getByRole("button", { name: "open structure" }));
    await userEvent.click(await screen.findByRole("button", { name: "Zum Projekt machen" }));
    await userEvent.click(await screen.findByRole("button", { name: "Aktivieren" }));

    const picker = await screen.findByRole("dialog", { name: strings.assignDriver });
    expect(within(picker).getByText(strings.assignDriverToActivateHint)).toBeInTheDocument();
    expect(mockedApi.convertTaskToStory).toHaveBeenCalledWith(72, {
      status: "backlog",
      expectedRevision: 1,
    });
    expect(mockedApi.activateProject).not.toHaveBeenCalled();

    await userEvent.click(within(picker).getByRole("button", { name: /Mira/ }));

    await waitFor(() =>
      expect(mockedApi.activateProject).toHaveBeenCalledWith(72, {
        expectedRevision: 2,
        ownerMemberId: 1,
      }),
    );
    expect(mockedApi.updateProject).not.toHaveBeenCalled();
    await waitFor(() => expect(picker).not.toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("activates a converted project with an existing driver without opening the picker", async () => {
    const project = makeProject({
      id: 72,
      status: "backlog",
      ownerMemberId: 1,
      revision: 2,
      nextAction: makeTask({ projectId: 72, executable: true }),
    });
    mockedApi.getTask.mockResolvedValue(makeTask({ id: 72 }));
    mockedApi.convertTaskToStory.mockResolvedValue(project);
    mockedApi.getProject.mockResolvedValue({ ...project, tasks: [] });
    mockedApi.activateProject.mockResolvedValue({ ...project, status: "active", revision: 3 });
    renderStructure(72);

    await userEvent.click(screen.getByRole("button", { name: "open structure" }));
    await userEvent.click(await screen.findByRole("button", { name: "Zum Projekt machen" }));
    await userEvent.click(await screen.findByRole("button", { name: "Aktivieren" }));

    await waitFor(() =>
      expect(mockedApi.activateProject).toHaveBeenCalledWith(72, { expectedRevision: 2 }),
    );
    expect(screen.queryByRole("dialog", { name: strings.assignDriver })).not.toBeInTheDocument();
  });

  it("collects the missing driver then guides an unprepared conversion to its next action", async () => {
    const project = makeProject({
      id: 72,
      status: "backlog",
      ownerMemberId: null,
      revision: 2,
      nextAction: null,
    });
    mockedApi.getTask.mockResolvedValue(makeTask({ id: 72, status: "captured" }));
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1, name: "Mira" })]);
    mockedApi.convertTaskToStory.mockResolvedValue(project);
    mockedApi.getProject.mockResolvedValue({ ...project, tasks: [] });
    mockedApi.updateProject.mockResolvedValue({ ...project, ownerMemberId: 1, revision: 3 });
    renderWithProviders(
      <>
        <OpenStructureHarness taskId={72} />
        <TaskWorkflowHost />
        <ProjectWorkflowHost />
        <LocationProbe />
      </>,
    );

    await userEvent.click(screen.getByRole("button", { name: "open structure" }));
    await userEvent.click(await screen.findByRole("button", { name: "Zum Projekt machen" }));
    await userEvent.click(await screen.findByRole("button", { name: "Aktivieren" }));
    const picker = await screen.findByRole("dialog", { name: strings.assignDriver });
    await userEvent.click(within(picker).getByRole("button", { name: /Mira/ }));

    await waitFor(() =>
      expect(mockedApi.updateProject).toHaveBeenCalledWith(72, {
        expectedRevision: 2,
        ownerMemberId: 1,
      }),
    );
    expect(await screen.findByText("/projects/72?focus=next-action")).toBeInTheDocument();
    expect(mockedApi.activateProject).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("hides split but still offers move and conversion for a captured inbox item", async () => {
    const task = makeTask({
      id: 75,
      title: "Unklarer Einfall",
      status: "captured",
      projectId: null,
      parentTaskId: null,
    });
    mockedApi.getTask.mockResolvedValue(task);
    renderStructure(75);

    await userEvent.click(screen.getByRole("button", { name: "open structure" }));
    await screen.findByRole("dialog", { name: "Struktur: Unklarer Einfall" });

    expect(screen.queryByRole("button", { name: "Aufteilen" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Verschieben …" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Zum Projekt machen" })).toBeInTheDocument();
  });

  it("dispatches task.changeProject and opens MoveTaskSheet for a captured inbox item (refile flow)", async () => {
    const task = makeTask({
      id: 76,
      title: "Unklarer Einfall",
      status: "captured",
      projectId: null,
      parentTaskId: null,
    });
    mockedApi.getTask.mockResolvedValue(task);
    renderStructure(76);

    await userEvent.click(screen.getByRole("button", { name: "open structure" }));
    await userEvent.click(await screen.findByRole("button", { name: "Verschieben …" }));

    expect(
      await screen.findByRole("dialog", { name: "In anderes Projekt verschieben" }),
    ).toBeInTheDocument();
  });

  it("hides split and conversion for a reference task but still offers move", async () => {
    const task = makeTask({
      id: 77,
      title: "Fahrplan",
      kind: "reference",
      status: "captured",
      projectId: 2,
      parentTaskId: 61,
    });
    mockedApi.getTask.mockResolvedValue(task);
    renderStructure(77);

    await userEvent.click(screen.getByRole("button", { name: "open structure" }));
    await screen.findByRole("dialog", { name: "Struktur: Fahrplan" });

    expect(screen.queryByRole("button", { name: "Aufteilen" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Zum Projekt machen" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Verschieben …" })).toBeInTheDocument();
  });
});
