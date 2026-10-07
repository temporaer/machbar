import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { makeMember, makeProject, makeTask } from "../test/fixtures";
import { renderWithProviders } from "../test/testUtils";
import { CapturedProjectHandoff } from "./CapturedProjectHandoff";
import { ProjectWorkflowHost } from "./ProjectWorkflowHost";
import { de as strings } from "../i18n/de";

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

  it("creates a next action through the always-available step composer", async () => {
    const project = makeProject({ id: 42, title: "Küche" });
    renderWithProviders(
      <CapturedProjectHandoff project={project} onDone={vi.fn()} />,
    );

    await userEvent.type(screen.getByPlaceholderText("Schritt …"), "Material bestellen");
    await userEvent.click(
      screen.getByRole("button", { name: "Nächsten Schritt hinzufügen" }),
    );

    await waitFor(() =>
      expect(mockedApi.createTask).toHaveBeenCalledWith({
        title: "Material bestellen",
        projectId: 42,
        status: "actionable",
        createdByMemberId: null,
      }),
    );
  });

  it("shows an added step in the visible list right away", async () => {
    const project = makeProject({ id: 42, title: "Küche" });
    const created = makeTask({ id: 99, projectId: 42, title: "Material bestellen" });
    mockedApi.createTask.mockResolvedValue(created);
    mockedApi.getProject.mockResolvedValueOnce({
      ...makeProject({ id: 42, status: "backlog", ownerMemberId: 1 }),
      tasks: [],
    });
    mockedApi.getProject.mockResolvedValue({
      ...makeProject({ id: 42, status: "backlog", ownerMemberId: 1 }),
      tasks: [created],
    });
    renderWithProviders(
      <CapturedProjectHandoff project={project} onDone={vi.fn()} />,
    );

    await userEvent.type(screen.getByPlaceholderText("Schritt …"), "Material bestellen");
    await userEvent.click(
      screen.getByRole("button", { name: "Nächsten Schritt hinzufügen" }),
    );

    expect(await screen.findByText("Material bestellen")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Schritt …")).toHaveValue("");
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

  it.each(["executable", "future waiting"])(
    "assigns a driver and activates atomically for %s progress",
    async (progress) => {
      const project = makeProject({
        id: 42,
        status: "backlog",
        ownerMemberId: null,
        activationReadiness: {
          ready: false,
          hasDriver: false,
          hasViableProgressPath: progress === "executable",
          hasHealthyFutureWaiting: progress === "future waiting",
        },
      });
      mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1, name: "Mira" })]);
      mockedApi.getProject.mockResolvedValue({ ...project, tasks: [] });
      mockedApi.activateProject.mockResolvedValue({
        ...project,
        status: "active",
        ownerMemberId: 1,
        revision: 2,
        availableActions: ["return_to_backlog", "complete", "archive"],
      });
      renderWithProviders(
        <>
          <CapturedProjectHandoff project={project} onDone={vi.fn()} />
          <ProjectWorkflowHost />
        </>,
      );

      await userEvent.click(screen.getByRole("button", { name: "Starten" }));
      const picker = await screen.findByRole("dialog", { name: strings.assignDriver });
      expect(within(picker).getByText(strings.assignDriverToActivateHint)).toBeInTheDocument();
      expect(within(picker).queryByRole("button", { name: strings.noDriver })).not.toBeInTheDocument();
      expect(mockedApi.activateProject).not.toHaveBeenCalled();

      await userEvent.click(within(picker).getByRole("button", { name: /Mira/ }));

      await waitFor(() =>
        expect(mockedApi.activateProject).toHaveBeenCalledWith(42, {
          expectedRevision: 1,
          ownerMemberId: 1,
        }),
      );
      await waitFor(() => expect(picker).not.toBeInTheDocument());
      expect(screen.queryByRole("button", { name: "Starten" })).not.toBeInTheDocument();
    },
  );

  it("leaves the handoff available when driver selection is cancelled", async () => {
    const project = makeProject({
      id: 42,
      status: "backlog",
      ownerMemberId: null,
      nextAction: makeTask({ projectId: 42, executable: true }),
    });
    mockedApi.getProject.mockResolvedValue({ ...project, tasks: [] });
    renderWithProviders(
      <>
        <CapturedProjectHandoff project={project} onDone={vi.fn()} />
        <ProjectWorkflowHost />
      </>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Starten" }));
    const picker = await screen.findByRole("dialog", { name: strings.assignDriver });
    await userEvent.click(within(picker).getByRole("button", { name: "Abbrechen" }));

    expect(picker).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Starten" })).toBeEnabled();
    expect(mockedApi.activateProject).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Starten" }));
    expect(await screen.findByRole("dialog", { name: strings.assignDriver })).toBeInTheDocument();
  });
});
