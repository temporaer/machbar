import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/testUtils";
import { api } from "../lib/api";
import { makeTask } from "../test/fixtures";
import { useTaskWorkflow } from "../lib/taskWorkflowContext";
import { TaskWorkflowHost } from "./TaskWorkflowHost";

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

function renderStructure(taskId: number) {
  return renderWithProviders(
    <div>
      <OpenStructureHarness taskId={taskId} />
      <TaskWorkflowHost />
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
});
