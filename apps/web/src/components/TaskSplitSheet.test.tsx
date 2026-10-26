import { useTaskActions } from "../lib/useTaskActions";
import { useWorkItemCommands } from "../lib/useWorkItemCommands";
import { useRefresh } from "../lib/refresh";
import { TaskWorkflowHost } from "./TaskWorkflowHost";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { api } from "../lib/api";
import { renderWithProviders } from "../test/testUtils";
import { makeMember, makeProject, makeTask } from "../test/fixtures";
import { IdentityProvider } from "../lib/identity";
import { LocaleProvider } from "../lib/locale";
import { ProjectActionsProvider } from "../lib/useProjectActions";
import { RefreshProvider } from "../lib/refresh";
import { SwipeCoachProvider } from "../lib/swipeCoach";
import { TaskActionsProvider } from "../lib/useTaskActions";
import { TaskDetailProvider } from "../lib/taskDetailContext";
import { TaskWorkflowProvider } from "../lib/taskWorkflowContext";
import { ProjectWorkflowProvider } from "../lib/projectWorkflowContext";
import { ThemeProvider } from "../lib/theme";
import { TaskSplitSheet } from "./TaskSplitSheet";
import { de as strings } from "../i18n/de";

vi.mock("../lib/api", () => ({
  api: {
    previewTaskUpdate: vi.fn().mockResolvedValue({ decision: null, activatingProjects: [] }),
    previewTaskConversion: vi.fn().mockResolvedValue({ decision: null, activatingProjects: [] }),
    previewTaskSteps: vi.fn().mockResolvedValue({ decision: null, activatingProjects: [] }),
    getMembers: vi.fn(),
    getTags: vi.fn(),
    createTaskStepBatchForTask: vi.fn(),
    getTask: vi.fn(),
    updateTask: vi.fn(),
    getProject: vi.fn(),
    moveTask: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

describe("TaskSplitSheet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.getMembers.mockResolvedValue([]);
    mockedApi.getTags.mockResolvedValue([]);
    mockedApi.getTask.mockResolvedValue(makeTask({ id: 7, revision: 1 }));
    mockedApi.createTaskStepBatchForTask.mockResolvedValue({ tasks: [] });
  });

  afterEach(() => { vi.useRealTimers(); });

  it("restores independent drafts when the member changes in another tab", async () => {
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1 }), makeMember({ id: 2 })]);
    localStorage.setItem("machbar:identity-member-id", "1");
    renderWithProviders(<TaskSplitSheet parentId={7} parentRevision={1} onClose={vi.fn()} />);
    const rows = () => screen.getAllByPlaceholderText(strings.splitTaskRowPlaceholder);
    await userEvent.type(rows()[0]!, "First member draft");
    const selectMember = (id: string) => act(() => {
      localStorage.setItem("machbar:identity-member-id", id);
      window.dispatchEvent(new StorageEvent("storage", { key: "machbar:identity-member-id", newValue: id, storageArea: localStorage }));
    });
    selectMember("2");
    await waitFor(() => expect(rows()[0]).toHaveValue(""));
    await userEvent.type(rows()[0]!, "Second member draft");
    selectMember("1");
    await waitFor(() => expect(rows()[0]).toHaveValue("First member draft"));
    selectMember("2");
    await waitFor(() => expect(rows()[0]).toHaveValue("Second member draft"));
  });

  it("uses equal-revision fetched children after editing a parent while its split workflow stays open", async () => {
    const oldChild = makeTask({ id: 8, title: "Old workflow child", parentTaskId: 7 });
    const newChild = makeTask({ id: 9, title: "Fresh workflow child", parentTaskId: 7 });
    const parent = makeTask({ id: 7, title: "Original parent", children: [oldChild] });
    const renamed = { ...parent, title: "Edited parent", revision: 2 };
    let saved = false;
    let changed = false;
    mockedApi.updateTask.mockImplementation(async () => { saved = true; return renamed; });
    mockedApi.getTask.mockImplementation(async () => saved ? { ...renamed, children: changed ? [newChild] : [oldChild] } : parent);
    function Controls() {
      const actions = useTaskActions();
      const dispatch = useWorkItemCommands();
      const { bump } = useRefresh();
      return <>
        <button onClick={() => void actions.update(parent, { title: renamed.title })}>Rename workflow parent</button>
        <button onClick={() => dispatch({ type: "task.split", taskId: parent.id })}>Open split workflow</button>
        <button onClick={() => { changed = true; bump(); }}>Refresh workflow children</button>
        <output data-testid="workflow-parent-held">{String(actions.holdingIds.has(parent.id))}</output>
      </>;
    }
    renderWithProviders(<><Controls /><TaskWorkflowHost /></>);
    const refresh = screen.getByRole("button", { name: "Refresh workflow children" });
    await userEvent.click(screen.getByRole("button", { name: "Rename workflow parent" }));
    await waitFor(() => expect(saved).toBe(true));
    await userEvent.click(screen.getByRole("button", { name: "Open split workflow" }));
    await screen.findByText(oldChild.title);
    vi.useFakeTimers();
    fireEvent.click(refresh);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText(newChild.title)).toBeInTheDocument();
    expect(screen.queryByText(oldChild.title)).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(screen.getByTestId("workflow-parent-held")).toHaveTextContent("true");
    expect(screen.getByText(newChild.title)).toBeInTheDocument();
  });

  it("submits all filled rows in one atomic request and keeps one empty trailing row", async () => {
    mockedApi.createTaskStepBatchForTask.mockResolvedValue({ tasks: [] });
    const onClose = vi.fn();
    renderWithProviders(<TaskSplitSheet parentId={7} parentRevision={1} onClose={onClose} />);

    const rows = () => screen.getAllByPlaceholderText("Schritt …");
    expect(rows()).toHaveLength(1);

    await userEvent.type(rows()[0]!, "Pakete prüfen{enter}");
    expect(rows()).toHaveLength(2);
    await userEvent.type(rows()[1]!, "Korpus aufbauen{enter}");
    expect(rows()).toHaveLength(3);
    await userEvent.type(rows()[2]!, "Türen montieren");

    await userEvent.click(screen.getByRole("button", { name: "3 Teilaufgaben anlegen" }));

    await waitFor(() => expect(mockedApi.createTaskStepBatchForTask).toHaveBeenCalledTimes(1));
    expect(mockedApi.createTaskStepBatchForTask).toHaveBeenCalledWith(7, {
      expectedRevision: 1,
      expectedProjectRevisions: [],
      steps: [
        { title: "Pakete prüfen" },
        { title: "Korpus aufbauen" },
        { title: "Türen montieren" },
      ],
    });
    // The sheet stays open after creating: it is now a persistent
    // reorganize-and-add workspace, not a one-shot form, so the newly
    // created subtasks can immediately be reordered alongside existing
    // ones instead of requiring the user to reopen the workflow.
    expect(onClose).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(1);
    expect((rows()[0] as HTMLInputElement).value).toBe("");
  });

  it("removes a filled row without affecting the others", async () => {
    renderWithProviders(<TaskSplitSheet parentId={7} parentRevision={1} onClose={vi.fn()} />);

    const rows = () => screen.getAllByPlaceholderText("Schritt …");
    await userEvent.type(rows()[0]!, "Erster Schritt{enter}");
    await userEvent.type(rows()[1]!, "Zweiter Schritt");

    await userEvent.click(screen.getAllByRole("button", { name: "Schritt entfernen" })[0]!);
    expect(rows().map((row) => (row as HTMLInputElement).value)).toEqual(["Zweiter Schritt", ""]);
  });

  it("keeps the complete draft when atomic batch creation fails", async () => {
    mockedApi.createTaskStepBatchForTask.mockRejectedValue(new Error("Nicht gespeichert"));
    renderWithProviders(<TaskSplitSheet parentId={7} parentRevision={1} onClose={vi.fn()} />);

    const rows = () => screen.getAllByPlaceholderText("Schritt …");
    await userEvent.type(rows()[0]!, "Erster Schritt{enter}");
    await userEvent.type(rows()[1]!, "Zweiter Schritt");
    await userEvent.click(screen.getByRole("button", { name: "2 Teilaufgaben anlegen" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Nicht gespeichert");
    expect(rows().map((row) => (row as HTMLInputElement).value)).toEqual([
      "Erster Schritt",
      "Zweiter Schritt",
      "",
    ]);
  });

  it("keeps a captured Inbox item in task-with-steps mode by default and offers explicit project conversion", async () => {
    mockedApi.createTaskStepBatchForTask.mockResolvedValue({ tasks: [] });
    renderWithProviders(<TaskSplitSheet parentId={7} parentRevision={4} parentStatus="captured" onClose={vi.fn()} />);
    expect(screen.getByRole("checkbox", { name: "Als Projekt behandeln" })).not.toBeChecked();
    await userEvent.type(screen.getByPlaceholderText("Schritt …"), "Ersten Schritt");
    await userEvent.click(screen.getByRole("checkbox", { name: "Als Projekt behandeln" }));
    await userEvent.click(screen.getByRole("button", { name: "1 Teilaufgabe anlegen" }));
    await waitFor(() => expect(mockedApi.createTaskStepBatchForTask).toHaveBeenCalledWith(7, expect.objectContaining({
      expectedRevision: 4,
      expectedProjectRevisions: [],
      convertParentToProject: true,
      steps: [{ title: "Ersten Schritt" }],
    })));
  });

  it("uses the updated Inbox classification and parent revision for a second batch in the same sheet", async () => {
    mockedApi.createTaskStepBatchForTask
      .mockResolvedValueOnce({
        tasks: [],
        parent: makeTask({ id: 7, revision: 2, status: "actionable", needsClarification: false }),
        projectSnapshot: null,
      })
      .mockResolvedValueOnce({
        tasks: [],
        parent: makeTask({ id: 7, revision: 2, status: "actionable", needsClarification: false }),
        projectSnapshot: null,
      });
    renderWithProviders(<TaskSplitSheet parentId={7} parentRevision={1} parentStatus="captured" onClose={vi.fn()} />);

    await userEvent.type(screen.getByPlaceholderText("Schritt …"), "Erster Schritt");
    await userEvent.click(screen.getByRole("button", { name: "1 Teilaufgabe anlegen" }));
    await waitFor(() => expect(mockedApi.createTaskStepBatchForTask).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("checkbox", { name: "Als Projekt behandeln" })).not.toBeInTheDocument();

    await userEvent.type(screen.getByPlaceholderText("Schritt …"), "Zweiter Schritt");
    await userEvent.click(screen.getByRole("button", { name: "1 Teilaufgabe anlegen" }));
    await waitFor(() => expect(mockedApi.createTaskStepBatchForTask).toHaveBeenCalledTimes(2));
    expect(mockedApi.createTaskStepBatchForTask.mock.calls[1]?.[1]).toMatchObject({
      expectedRevision: 2,
      expectedProjectRevisions: [],
      steps: [{ title: "Zweiter Schritt" }],
    });
  });

  it("cancels without submitting the preserved draft", async () => {
    const onClose = vi.fn();
    renderWithProviders(<TaskSplitSheet parentId={7} parentRevision={1} onClose={onClose} />);
    await userEvent.type(screen.getByPlaceholderText("Schritt …"), "Noch nicht speichern");
    await userEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(mockedApi.createTaskStepBatchForTask).not.toHaveBeenCalled();
  });

  it("retains the dated batch while collecting server-required activation decisions", async () => {
    const project = makeProject({ id: 12, revision: 5, title: "Sommerfest", status: "backlog", ownerMemberId: null });
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1, name: "Mira" })]);
    mockedApi.getProject.mockResolvedValue({ ...project, tasks: [], ancestors: [] });
    mockedApi.createTaskStepBatchForTask
      .mockRejectedValueOnce(Object.assign(new Error("Treiber fehlt"), {
        code: "project_commitment_resolution_required",
        details: {
          projects: [{ projectId: 12, title: project.title, revision: 5, ownerMemberId: null, required: ["driver"] }],
          expectedProjects: [{ projectId: 12, revision: 5 }],
          targetRevision: 5,
        },
      }))
      .mockResolvedValueOnce({
        tasks: [],
        parent: makeTask({ id: 7, revision: 4, status: "actionable", projectId: 12 }),
        projectSnapshot: { ...project, revision: 6, status: "active", ancestors: [] },
      })
      .mockResolvedValueOnce({
        tasks: [],
        parent: makeTask({ id: 7, revision: 4, status: "actionable", projectId: 12 }),
        projectSnapshot: { ...project, revision: 6, status: "active", ancestors: [] },
      });
    renderWithProviders(
      <TaskSplitSheet parentId={7} parentRevision={4} parentStatus="actionable" projectId={12} onClose={vi.fn()} />,
    );

    await userEvent.type(screen.getByPlaceholderText("Schritt …"), "Maße prüfen");
    await userEvent.click(screen.getByText("Planung (optional)"));
    await userEvent.type(screen.getByLabelText("Geplant für"), "2027-03-12");
    await userEvent.click(screen.getByRole("button", { name: "1 Teilaufgabe anlegen" }));

    const driver = await screen.findByLabelText(strings.commitmentDriverFor(project.title));
    expect(screen.getByLabelText("Geplant für")).toHaveValue("2027-03-12");
    await userEvent.selectOptions(driver, "1");
    await userEvent.click(screen.getByRole("button", { name: "1 Teilaufgabe anlegen" }));

    await waitFor(() => expect(mockedApi.createTaskStepBatchForTask).toHaveBeenCalledTimes(2));
    expect(mockedApi.createTaskStepBatchForTask).toHaveBeenLastCalledWith(7, expect.objectContaining({
      expectedRevision: 4,
      expectedProjectRevisions: [{ projectId: 12, revision: 5 }],
      steps: [{ title: "Maße prüfen", scheduledDate: "2027-03-12" }],
      activationResolution: {
        expectedProjects: [{ projectId: 12, revision: 5 }],
        drivers: [{ projectId: 12, ownerMemberId: 1 }],
      },
    }));

    await userEvent.type(screen.getByPlaceholderText("Schritt …"), "Zweiter Schritt");
    await userEvent.click(screen.getByRole("button", { name: "1 Teilaufgabe anlegen" }));
    await waitFor(() => expect(mockedApi.createTaskStepBatchForTask).toHaveBeenCalledTimes(3));
    expect(mockedApi.createTaskStepBatchForTask.mock.calls[2]?.[1]).toMatchObject({
      expectedRevision: 4,
      expectedProjectRevisions: [{ projectId: 12, revision: 6 }],
      steps: [{ title: "Zweiter Schritt" }],
    });
  });

  it("drops activation decisions when the user changes the batch after a requirement response", async () => {
    const project = makeProject({ id: 13, revision: 6, title: "Garten", status: "backlog", ownerMemberId: null });
    mockedApi.getProject.mockResolvedValue({ ...project, tasks: [], ancestors: [] });
    mockedApi.createTaskStepBatchForTask
      .mockRejectedValueOnce(Object.assign(new Error("Treiber fehlt"), {
        code: "project_commitment_resolution_required",
        details: {
          projects: [{ projectId: 13, title: project.title, revision: 6, ownerMemberId: null, required: ["driver"] }],
          expectedProjects: [{ projectId: 13, revision: 6 }],
        },
      }))
      .mockResolvedValueOnce({ tasks: [] });
    renderWithProviders(<TaskSplitSheet parentId={7} parentRevision={4} projectId={13} onClose={vi.fn()} />);
    const input = screen.getByPlaceholderText("Schritt …");
    await userEvent.type(input, "Schritt eins");
    await userEvent.click(screen.getByRole("button", { name: "1 Teilaufgabe anlegen" }));
    expect(await screen.findByLabelText(strings.commitmentDriverFor(project.title))).toBeInTheDocument();

    await userEvent.clear(input);
    await userEvent.type(input, "Schritt angepasst");
    expect(screen.queryByLabelText(strings.commitmentDriverFor(project.title))).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "1 Teilaufgabe anlegen" }));

    await waitFor(() => expect(mockedApi.createTaskStepBatchForTask).toHaveBeenCalledTimes(2));
    expect(mockedApi.createTaskStepBatchForTask).toHaveBeenLastCalledWith(7, expect.objectContaining({
      steps: [{ title: "Schritt angepasst" }],
    }));
    expect(mockedApi.createTaskStepBatchForTask.mock.calls[1]?.[1]).not.toHaveProperty("activationResolution");
  });

  it("has no existing-subtasks outline when the task has no children yet", () => {
    renderWithProviders(<TaskSplitSheet parentId={7} parentRevision={1} onClose={vi.fn()} />);
    expect(screen.queryByText("Vorhandene Teilaufgaben")).not.toBeInTheDocument();
  });

  it("shows existing subtasks in a reorganizable outline with drag handles", () => {
    const first = makeTask({ id: 101, parentTaskId: 7, position: 0, title: "Kisten kaufen" });
    const second = makeTask({ id: 102, parentTaskId: 7, position: 1, title: "Klebeband besorgen" });
    renderWithProviders(
        <TaskSplitSheet
        parentId={7}
          parentRevision={1}
        existingChildren={[first, second]}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("Vorhandene Teilaufgaben")).toBeInTheDocument();
    expect(screen.getByText("Teilaufgaben hinzufügen")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Verschieben: Kisten kaufen" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Verschieben: Klebeband besorgen" })).toBeInTheDocument();
  });

  it("reorders existing subtasks via the same structural move used in Project Detail", async () => {
    mockedApi.moveTask.mockResolvedValue({} as never);
    const first = makeTask({ id: 101, parentTaskId: 7, position: 0, title: "Kisten kaufen" });
    const second = makeTask({ id: 102, parentTaskId: 7, position: 1, title: "Klebeband besorgen" });
    renderWithProviders(
        <TaskSplitSheet
        parentId={7}
          parentRevision={1}
        existingChildren={[first, second]}
        onClose={vi.fn()}
      />,
    );

    const handle = screen.getByRole("button", { name: "Verschieben: Kisten kaufen" });
    handle.focus();
    fireEvent.keyDown(handle, { key: "ArrowDown" });

    await waitFor(() =>
      expect(mockedApi.moveTask).toHaveBeenCalledWith(
        101,
        expect.objectContaining({ parentTaskId: 7, position: 1 }),
      ),
    );
  });

  it("renders the existing-subtasks outline without a page-level InteractionScopeProvider", () => {
    // `TaskWorkflowHost` (which actually mounts this sheet in production)
    // sits outside every page's own `InteractionScopeProvider` -- unlike
    // `renderWithProviders`, which always wraps in one and would mask a
    // missing-context crash. Reproduce the real mount tree here instead.
    const first = makeTask({ id: 101, parentTaskId: 7, position: 0, title: "Kisten kaufen" });
    const second = makeTask({ id: 102, parentTaskId: 7, position: 1, title: "Klebeband besorgen" });
    render(
      <ThemeProvider>
        <LocaleProvider initialLocale="de">
          <MemoryRouter>
            <IdentityProvider>
              <RefreshProvider>
                  <SwipeCoachProvider>
                    <TaskActionsProvider>
                      <ProjectActionsProvider>
                        <TaskDetailProvider>
                          <TaskWorkflowProvider>
                            <ProjectWorkflowProvider>
                              <TaskSplitSheet parentId={7} parentRevision={1} existingChildren={[first, second]} onClose={vi.fn()} />
                            </ProjectWorkflowProvider>
                          </TaskWorkflowProvider>
                        </TaskDetailProvider>
                      </ProjectActionsProvider>
                    </TaskActionsProvider>
                  </SwipeCoachProvider>
              </RefreshProvider>
            </IdentityProvider>
          </MemoryRouter>
        </LocaleProvider>
      </ThemeProvider>,
    );

    expect(screen.getByText("Vorhandene Teilaufgaben")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Verschieben: Kisten kaufen" })).toBeInTheDocument();
  });
});
