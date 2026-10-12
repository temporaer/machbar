import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { de as strings } from "../i18n/de";
import { makeProject, makeTask } from "../test/fixtures";
import { renderWithProviders } from "../test/testUtils";
import { TaskConvertToProjectSheet } from "./TaskConvertToProjectSheet";

vi.mock("../lib/api", () => ({
  api: {
    convertTaskToStory: vi.fn(),
    getTask: vi.fn(),
    getMembers: vi.fn(),
    createTask: vi.fn(),
    createTaskStepBatchForProject: vi.fn(),
    getProject: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

describe("TaskConvertToProjectSheet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.convertTaskToStory.mockResolvedValue(makeProject({ id: 42, title: "Vorhaben" }));
    mockedApi.getMembers.mockResolvedValue([]);
    mockedApi.getProject.mockResolvedValue({ ...makeProject({ id: 42, title: "Vorhaben" }), tasks: [] });
    mockedApi.createTask.mockResolvedValue(makeTask());
    mockedApi.createTaskStepBatchForProject.mockResolvedValue({ tasks: [] });
  });

  it("keeps commitments and lets users map each dependency before conversion", async () => {
    const target = makeTask({ id: 11, title: "Vorhandener Schritt", revision: 4 });
    const dependency = {
      id: 73,
      taskId: 42,
      dependsOnTaskId: 9,
      title: "Material klären",
      resolved: false,
    };
    const task = makeTask({
      id: 42,
      revision: 8,
      title: "Keller organisieren",
      status: "actionable",
      scheduledDate: "2026-10-20",
      dependencies: [dependency],
      children: [target],
    });
    renderWithProviders(<TaskConvertToProjectSheet task={task} onClose={vi.fn()} />);

    expect(screen.getByText(strings.convertToProjectCommitmentActive)).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText(strings.convertToProjectPreservedStep));
    await userEvent.type(screen.getByLabelText(strings.convertToProjectPreservedStep), "Regale ausmessen");
    await userEvent.selectOptions(
      screen.getByLabelText(`${strings.convertToProjectDependencyTarget}: Material klären`),
      "11",
    );
    await userEvent.click(screen.getByRole("button", { name: strings.convertToProjectBacklog }));

    await waitFor(() => expect(mockedApi.convertTaskToStory).toHaveBeenCalledWith(42, {
      status: "backlog",
      preservedStepTitle: "Regale ausmessen",
      dependencyMappings: [{ dependencyId: 73, targetTaskId: 11, sourceEndpoint: "task" }],
      expectedDescendantRevisions: [{ taskId: 11, revision: 4 }],
      expectedRevision: 8,
    }));
  });

  it("cancels without starting conversion", async () => {
    const onClose = vi.fn();
    renderWithProviders(<TaskConvertToProjectSheet task={makeTask({ id: 42 })} onClose={onClose} />);

    await userEvent.click(screen.getByRole("button", { name: strings.cancel }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(mockedApi.convertTaskToStory).not.toHaveBeenCalled();
  });
});
