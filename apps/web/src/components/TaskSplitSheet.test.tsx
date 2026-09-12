import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { api } from "../lib/api";
import { renderWithProviders } from "../test/testUtils";
import { makeTask } from "../test/fixtures";
import { IdentityProvider } from "../lib/identity";
import { LocaleProvider } from "../lib/locale";
import { ProjectActionsProvider } from "../lib/useProjectActions";
import { RailConfigProvider } from "../lib/railConfigContext";
import { RefreshProvider } from "../lib/refresh";
import { SwipeCoachProvider } from "../lib/swipeCoach";
import { SwipeSettingsProvider } from "../lib/swipeSettings";
import { TaskActionsProvider } from "../lib/useTaskActions";
import { TaskDetailProvider } from "../lib/taskDetailContext";
import { TaskWorkflowProvider } from "../lib/taskWorkflowContext";
import { ProjectWorkflowProvider } from "../lib/projectWorkflowContext";
import { ThemeProvider } from "../lib/theme";
import { TaskSplitSheet } from "./TaskSplitSheet";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    getTags: vi.fn(),
    createChildTask: vi.fn(),
    moveTask: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

describe("TaskSplitSheet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.getMembers.mockResolvedValue([]);
    mockedApi.getTags.mockResolvedValue([]);
  });

  it("creates one child task per filled row, always keeping one empty trailing row", async () => {
    mockedApi.createChildTask.mockResolvedValue({} as never);
    const onClose = vi.fn();
    renderWithProviders(<TaskSplitSheet parentId={7} onClose={onClose} />);

    const rows = () => screen.getAllByPlaceholderText("Schritt …");
    expect(rows()).toHaveLength(1);

    await userEvent.type(rows()[0]!, "Pakete prüfen{enter}");
    expect(rows()).toHaveLength(2);
    await userEvent.type(rows()[1]!, "Korpus aufbauen{enter}");
    expect(rows()).toHaveLength(3);
    await userEvent.type(rows()[2]!, "Türen montieren");

    await userEvent.click(screen.getByRole("button", { name: "3 Teilaufgaben anlegen" }));

    await waitFor(() => expect(mockedApi.createChildTask).toHaveBeenCalledTimes(3));
    expect(mockedApi.createChildTask).toHaveBeenNthCalledWith(1, 7, {
      title: "Pakete prüfen",
      createdByMemberId: null,
      status: "actionable",
    });
    expect(mockedApi.createChildTask).toHaveBeenNthCalledWith(3, 7, {
      title: "Türen montieren",
      createdByMemberId: null,
      status: "actionable",
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
    mockedApi.createChildTask.mockResolvedValue({} as never);
    renderWithProviders(<TaskSplitSheet parentId={7} onClose={vi.fn()} />);

    const rows = () => screen.getAllByPlaceholderText("Schritt …");
    await userEvent.type(rows()[0]!, "Erster Schritt{enter}");
    await userEvent.type(rows()[1]!, "Zweiter Schritt");

    await userEvent.click(screen.getAllByRole("button", { name: "Schritt entfernen" })[0]!);
    expect(rows().map((row) => (row as HTMLInputElement).value)).toEqual(["Zweiter Schritt", ""]);
  });

  it("keeps the entered rows and reports a failed child creation", async () => {
    mockedApi.createChildTask.mockRejectedValue(new Error("Nicht gespeichert"));
    renderWithProviders(<TaskSplitSheet parentId={7} onClose={vi.fn()} />);

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

  it("has no existing-subtasks outline when the task has no children yet", () => {
    renderWithProviders(<TaskSplitSheet parentId={7} onClose={vi.fn()} />);
    expect(screen.queryByText("Vorhandene Teilaufgaben")).not.toBeInTheDocument();
  });

  it("shows existing subtasks in a reorganizable outline with drag handles", () => {
    const first = makeTask({ id: 101, parentTaskId: 7, position: 0, title: "Kisten kaufen" });
    const second = makeTask({ id: 102, parentTaskId: 7, position: 1, title: "Klebeband besorgen" });
    renderWithProviders(
      <TaskSplitSheet
        parentId={7}
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
                <SwipeSettingsProvider>
                  <RailConfigProvider>
                    <SwipeCoachProvider>
                      <TaskActionsProvider>
                        <ProjectActionsProvider>
                          <TaskDetailProvider>
                            <TaskWorkflowProvider>
                              <ProjectWorkflowProvider>
                                <TaskSplitSheet parentId={7} existingChildren={[first, second]} onClose={vi.fn()} />
                              </ProjectWorkflowProvider>
                            </TaskWorkflowProvider>
                          </TaskDetailProvider>
                        </ProjectActionsProvider>
                      </TaskActionsProvider>
                    </SwipeCoachProvider>
                  </RailConfigProvider>
                </SwipeSettingsProvider>
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
