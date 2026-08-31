import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { makeProject, makeTask } from "../test/fixtures";
import { renderWithProviders } from "../test/testUtils";
import { CapturedProjectHandoff } from "./CapturedProjectHandoff";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    createTask: vi.fn(),
    getProject: vi.fn(),
    activateProject: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

describe("CapturedProjectHandoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.getMembers.mockResolvedValue([]);
    mockedApi.createTask.mockResolvedValue(makeTask());
    mockedApi.getProject.mockResolvedValue({
      ...makeProject({ id: 42, status: "backlog", ownerMemberId: 1 }),
      tasks: [],
    });
  });

  it("creates a next action through the standard task composer", async () => {
    const project = makeProject({ id: 42, title: "Küche" });
    renderWithProviders(
      <CapturedProjectHandoff project={project} onDone={vi.fn()} />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Nächsten Schritt hinzufügen" }),
    );
    await userEvent.type(
      screen.getByPlaceholderText("Nächsten Schritt hinzufügen"),
      "Material bestellen",
    );
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));

    expect(mockedApi.createTask).toHaveBeenCalledWith({
      title: "Material bestellen",
      projectId: 42,
      status: "actionable",
      createdByMemberId: null,
    });
  });

  it("finishes without opening another editing workbench", async () => {
    const onDone = vi.fn();
    renderWithProviders(
      <CapturedProjectHandoff project={makeProject()} onDone={onDone} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Erledigt" }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("keeps activation separate and starts only from a prepared handoff", async () => {
    const nextAction = makeTask({ id: 77, projectId: 42, executable: true });
    const project = makeProject({
      id: 42,
      status: "backlog",
      ownerMemberId: 1,
      nextAction,
    });
    mockedApi.activateProject.mockResolvedValue({
      ...makeProject({
        id: 42,
        status: "active",
        ownerMemberId: 1,
        nextAction,
      }),
      revision: 2,
    });
    renderWithProviders(
      <CapturedProjectHandoff project={project} onDone={vi.fn()} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Starten" }));

    await waitFor(() =>
      expect(mockedApi.activateProject).toHaveBeenCalledWith(42, {
        expectedRevision: 1,
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Starten" })).not.toBeInTheDocument(),
    );
  });
});
