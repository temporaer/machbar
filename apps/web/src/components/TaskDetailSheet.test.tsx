import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { IdentityProvider } from "../lib/identity";
import { RefreshProvider } from "../lib/refresh";
import { TaskDetailProvider, useTaskDetail } from "../lib/taskDetailContext";
import { TaskDetailSheet } from "./TaskDetailSheet";
import { api } from "../lib/api";
import { makeMember, makeTag, makeTask } from "../test/fixtures";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    getTags: vi.fn(),
    getTask: vi.fn(),
    updateTask: vi.fn(),
    completeTask: vi.fn(),
    reopenTask: vi.fn(),
    deleteTask: vi.fn(),
    searchTasks: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

function OpenerHarness({ taskId, children }: { taskId: number; children: ReactNode }) {
  const { open } = useTaskDetail();
  return (
    <div>
      <button type="button" onClick={() => open(taskId)}>
        open
      </button>
      {children}
    </div>
  );
}

function renderSheet(taskId: number) {
  return render(
    <MemoryRouter>
      <IdentityProvider>
        <RefreshProvider>
          <TaskDetailProvider>
            <OpenerHarness taskId={taskId}>
              <TaskDetailSheet />
            </OpenerHarness>
          </TaskDetailProvider>
        </RefreshProvider>
      </IdentityProvider>
    </MemoryRouter>,
  );
}

describe("TaskDetailSheet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1, name: "Mira" })]);
    mockedApi.getTags.mockResolvedValue([makeTag({ id: 10, name: "büro" })]);
    mockedApi.updateTask.mockResolvedValue(makeTask());
  });

  it("zeigt geerbte Tags mit Ausschluss-Option und erlaubt das Umschalten des Zuständigkeits-Vererbungsmodus", async () => {
    const inheritedTag = makeTag({ id: 11, name: "eilig" });
    const task = makeTask({
      id: 42,
      title: "Bericht schreiben",
      ownerInheritanceMode: "inherit",
      effectiveTags: [inheritedTag],
      explicitTags: [],
      excludedTagIds: [],
    });
    mockedApi.getTask.mockResolvedValue(task);

    renderSheet(42);
    await userEvent.click(screen.getByText("open"));

    expect(await screen.findByDisplayValue("Bericht schreiben")).toBeInTheDocument();
    expect(screen.getByText("eilig")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Eigene Zuständigkeit setzen" }));
    await waitFor(() => expect(mockedApi.updateTask).toHaveBeenCalledWith(42, { ownerInheritanceMode: "explicit" }));
  });

  it("schließt einen ausgeschlossenen geerbten Tag über den Umschalter aus", async () => {
    const inheritedTag = makeTag({ id: 11, name: "eilig" });
    const task = makeTask({
      id: 43,
      title: "Angebot prüfen",
      effectiveTags: [inheritedTag],
      explicitTags: [],
      excludedTagIds: [],
    });
    mockedApi.getTask.mockResolvedValue(task);

    renderSheet(43);
    await userEvent.click(screen.getByText("open"));
    await screen.findByDisplayValue("Angebot prüfen");

    await userEvent.click(screen.getByRole("button", { name: "Ausschließen" }));
    await waitFor(() => expect(mockedApi.updateTask).toHaveBeenCalledWith(43, { excludedTagIds: [11] }));
  });
});
