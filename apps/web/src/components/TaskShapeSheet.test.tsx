import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../lib/api";
import { makeTask } from "../test/fixtures";
import { renderWithProviders } from "../test/testUtils";
import { useTaskWorkflow } from "../lib/taskWorkflowContext";
import { TaskWorkflowHost } from "./TaskWorkflowHost";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    getTags: vi.fn(),
    getTask: vi.fn(),
    convertTaskToStory: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

function OpenShape({ taskId }: { taskId: number }) {
  const workflow = useTaskWorkflow();
  return (
    <button type="button" onClick={() => workflow.open("shape", taskId)}>
      open shape
    </button>
  );
}

describe("TaskShapeSheet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.getMembers.mockResolvedValue([]);
    mockedApi.getTags.mockResolvedValue([]);
  });

  it("offers shape choices without lifecycle/status actions", async () => {
    const task = makeTask({ id: 201, title: "Unklarer Eingang", status: "captured" });
    mockedApi.getTask.mockResolvedValue(task);
    renderWithProviders(
      <>
        <OpenShape taskId={201} />
        <TaskWorkflowHost />
      </>,
    );

    await userEvent.click(screen.getByRole("button", { name: "open shape" }));
    expect(await screen.findByRole("dialog", { name: "Was ist das?" })).toBeInTheDocument();
    for (const name of ["Aufgabe", "Projekt", "Referenz"]) {
      expect(screen.getByRole("button", { name: new RegExp(name) })).toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: "Machbar" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Erledigt" })).not.toBeInTheDocument();
  });

  it("routes project choice through the existing guarded conversion workflow", async () => {
    const task = makeTask({ id: 202, title: "Projektkandidat", status: "captured" });
    mockedApi.getTask.mockResolvedValue(task);
    renderWithProviders(
      <>
        <OpenShape taskId={202} />
        <TaskWorkflowHost />
      </>,
    );

    await userEvent.click(screen.getByRole("button", { name: "open shape" }));
    await userEvent.click(screen.getByRole("button", { name: /Projekt/ }));
    expect(await screen.findByRole("dialog", { name: /Als Projekt behandeln/ })).toBeInTheDocument();
    expect(mockedApi.convertTaskToStory).not.toHaveBeenCalled();
  });
});
