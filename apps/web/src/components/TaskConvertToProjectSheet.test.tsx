import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { de as strings } from "../i18n/de";
import { makeMember, makeProject, makeTask } from "../test/fixtures";
import { renderWithProviders } from "../test/testUtils";
import { TaskConvertToProjectSheet } from "./TaskConvertToProjectSheet";

vi.mock("../lib/api", () => ({
  api: {
    previewTaskConversion: vi.fn().mockResolvedValue({ decision: null, activatingProjects: [] }),
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
    mockedApi.getTask.mockImplementation(() => new Promise(() => {}));
    mockedApi.getMembers.mockResolvedValue([]);
    mockedApi.getProject.mockResolvedValue({ ...makeProject({ id: 42, title: "Vorhaben" }), tasks: [] });
    mockedApi.createTask.mockResolvedValue(makeTask());
    mockedApi.createTaskStepBatchForProject.mockResolvedValue({ tasks: [], project: makeProject() });
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

    await userEvent.clear(screen.getByLabelText(strings.convertToProjectPreservedStep));
    await userEvent.type(screen.getByLabelText(strings.convertToProjectPreservedStep), "Regale ausmessen");
    await userEvent.selectOptions(
      screen.getByLabelText(`${strings.convertToProjectOutgoingDependency}: Material klären`),
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

  it("shows incoming dependencies and allows mapping them to a nested open action", async () => {
    const nested = makeTask({ id: 13, title: "Montage vorbereiten", revision: 5 });
    const parent = makeTask({ id: 12, title: "Raum vorbereiten", revision: 4, children: [nested] });
    const task = makeTask({
      id: 42,
      title: "Schreibtisch montieren",
      incomingDependencies: [{
        id: 74,
        taskId: 90,
        dependsOnTaskId: 42,
        title: "Kinderzimmer einrichten",
        resolved: false,
      }],
      children: [parent],
    });
    renderWithProviders(<TaskConvertToProjectSheet task={task} onClose={vi.fn()} />);

    const dependencySelect = screen.getByLabelText(`${strings.convertToProjectIncomingDependency}: Kinderzimmer einrichten`);
    expect(dependencySelect).toHaveDisplayValue(strings.convertToProjectPreservedStep);
    expect(screen.getByRole("option", { name: "Montage vorbereiten" })).toBeInTheDocument();
    await userEvent.selectOptions(dependencySelect, "13");
    await userEvent.click(screen.getByRole("button", { name: strings.convertToProjectBacklog }));

    await waitFor(() => expect(mockedApi.convertTaskToStory).toHaveBeenCalledWith(42, expect.objectContaining({
      dependencyMappings: [{ dependencyId: 74, targetTaskId: 13, sourceEndpoint: "dependsOnTask" }],
      expectedDescendantRevisions: [
        { taskId: 12, revision: 4 },
        { taskId: 13, revision: 5 },
      ],
    })));
  });

  it("keeps the authored retained step for a nested task with an execution window", async () => {
    const task = makeTask({ id: 42, status: "someday", parentTaskId: 7,
      availabilityRule: { kind: "weekly", match: "inside", windows: [{ weekdays: [1], start: "09:00", end: "17:00" }] } });
    mockedApi.getTask.mockResolvedValue({ ...task, hierarchyRevisions: [{ id: 42, revision: 1 }, { id: 7, revision: 1 }], ancestors: [{ id: 7, role: "task", title: "Parent", revision: 1 }] });
    renderWithProviders(<TaskConvertToProjectSheet task={task} onClose={vi.fn()} />);
    const title = await screen.findByLabelText(strings.convertToProjectPreservedStep);
    await userEvent.clear(title);
    await userEvent.type(title, "Authored window step");
    await userEvent.click(screen.getByRole("button", { name: strings.convertToProjectBacklog }));
    await waitFor(() => expect(mockedApi.convertTaskToStory).toHaveBeenCalledWith(42, expect.objectContaining({ preservedStepTitle: "Authored window step" })));
  });

  it("preserves decisions when a concurrent change adds requirements after preview", async () => {
    const task = makeTask({ id: 42, status: "captured" });
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1, name: "Mira" })]);
    mockedApi.convertTaskToStory.mockRejectedValueOnce(Object.assign(new Error("changed"), { code: "project_commitment_resolution_required", details: {
      targetRevision: 1, expectedProjects: [{ projectId: 42, revision: 1 }],
      projects: [{ projectId: 42, title: "Vorhaben", revision: 1, ownerMemberId: null, required: ["driver"] }],
    } }));
    renderWithProviders(<TaskConvertToProjectSheet task={task} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: strings.convertToProjectActive }));
    await userEvent.selectOptions(await screen.findByLabelText(strings.commitmentDriverFor("Vorhaben")), "1");
    await userEvent.click(screen.getByRole("button", { name: strings.activateStory }));
    await waitFor(() => expect(mockedApi.convertTaskToStory).toHaveBeenCalledTimes(2));
    expect(mockedApi.convertTaskToStory).toHaveBeenLastCalledWith(42, expect.objectContaining({ activationResolution: { expectedProjects: [{ projectId: 42, revision: 1 }], drivers: [{ projectId: 42, ownerMemberId: 1 }] } }));
  });

  it("cancels without starting conversion", async () => {
    const onClose = vi.fn();
    renderWithProviders(<TaskConvertToProjectSheet task={makeTask({ id: 42 })} onClose={onClose} />);

    await userEvent.click(screen.getByRole("button", { name: strings.cancel }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(mockedApi.convertTaskToStory).not.toHaveBeenCalled();
  });
});
