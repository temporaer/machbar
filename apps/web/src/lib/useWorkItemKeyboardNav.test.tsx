import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/testUtils";
import { TaskOutline } from "../components/TaskOutline";
import { ProjectStoryRow } from "../components/ProjectStoryRow";
import { WorkItemKeyboardNavMount } from "../components/WorkItemKeyboardNavMount";
import { BottomSheet } from "../components/BottomSheet";
import { api } from "./api";
import { useTaskDetail } from "./taskDetailContext";
import { makeMember, makeTask, makeProject } from "../test/fixtures";

vi.mock("./api", () => ({
  api: {
    getMembers: vi.fn(),
    getTags: vi.fn(),
    completeTask: vi.fn(),
    cancelTask: vi.fn(),
    reopenTask: vi.fn(),
    updateTask: vi.fn(),
    moveTask: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

function OpenTaskProbe() {
  const { openTaskId } = useTaskDetail();
  return <output data-testid="open-task-id">{openTaskId ?? "none"}</output>;
}

function handleFor(title: string): HTMLElement {
  return screen.getByRole("button", { name: `Verschieben: ${title}` });
}

function mainButtonFor(title: string): HTMLElement {
  return screen.getByRole("button", { name: title });
}

describe("useWorkItemKeyboardNav (j/k/h/l/Alt+arrows)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1 })]);
  });

  it("traverses visible nested rows with j/k, including into and out of a child", async () => {
    const child = makeTask({ id: 2, title: "Kind", position: 0 });
    const parent = makeTask({ id: 1, title: "Elternaufgabe", position: 0, children: [child] });
    const sibling = makeTask({ id: 3, title: "Geschwister", position: 1 });
    renderWithProviders(
      <>
        <WorkItemKeyboardNavMount />
        <TaskOutline tasks={[parent, sibling]} emptyMessage="Nichts da" />
      </>,
    );
    await screen.findByText("Elternaufgabe");

    await userEvent.keyboard("j");
    expect(mainButtonFor("Elternaufgabe")).toHaveFocus();

    await userEvent.keyboard("j");
    expect(mainButtonFor("Kind")).toHaveFocus();

    await userEvent.keyboard("j");
    expect(mainButtonFor("Geschwister")).toHaveFocus();

    await userEvent.keyboard("k");
    expect(mainButtonFor("Kind")).toHaveFocus();

    await userEvent.keyboard("k");
    expect(mainButtonFor("Elternaufgabe")).toHaveFocus();
  });

  it("skips collapsed descendants when traversing with j", async () => {
    const child = makeTask({ id: 2, title: "Kind", position: 0 });
    const parent = makeTask({ id: 1, title: "Elternaufgabe", position: 0, children: [child] });
    const sibling = makeTask({ id: 3, title: "Geschwister", position: 1 });
    renderWithProviders(
      <>
        <WorkItemKeyboardNavMount />
        <TaskOutline tasks={[parent, sibling]} emptyMessage="Nichts da" />
      </>,
    );
    await screen.findByText("Elternaufgabe");
    expect(screen.getByText("Kind")).toBeInTheDocument();

    // Collapsing itself sets Elternaufgabe as the active item (see
    // `dispatch()`'s generic "update the active item" side effect), so the
    // very next `j` already moves *past* it -- straight to Geschwister,
    // proving Kind is skipped rather than merely hidden from view.
    await userEvent.click(screen.getByRole("button", { name: "Einklappen" }));
    expect(screen.queryByText("Kind")).not.toBeInTheDocument();

    await userEvent.keyboard("j");
    expect(mainButtonFor("Geschwister")).toHaveFocus();
  });

  it("h/l collapse and expand the active item", async () => {
    const child = makeTask({ id: 2, title: "Kind", position: 0 });
    const parent = makeTask({ id: 1, title: "Elternaufgabe", position: 0, children: [child] });
    renderWithProviders(
      <>
        <WorkItemKeyboardNavMount />
        <TaskOutline tasks={[parent]} emptyMessage="Nichts da" />
      </>,
    );
    await screen.findByText("Elternaufgabe");
    await userEvent.keyboard("j");
    expect(screen.getByText("Kind")).toBeInTheDocument();

    await userEvent.keyboard("h");
    expect(screen.queryByText("Kind")).not.toBeInTheDocument();

    await userEvent.keyboard("l");
    expect(await screen.findByText("Kind")).toBeInTheDocument();
  });

  it("traverses across multiple TaskOutline sections mounted in one scope", async () => {
    const first = makeTask({ id: 1, title: "Erste Sektion", position: 0 });
    const second = makeTask({ id: 2, title: "Zweite Sektion", position: 0 });
    renderWithProviders(
      <>
        <WorkItemKeyboardNavMount />
        <TaskOutline tasks={[first]} emptyMessage="Nichts da" />
        <TaskOutline tasks={[second]} emptyMessage="Nichts da" />
      </>,
    );
    await screen.findByText("Erste Sektion");
    await screen.findByText("Zweite Sektion");

    await userEvent.keyboard("j");
    expect(mainButtonFor("Erste Sektion")).toHaveFocus();
    await userEvent.keyboard("j");
    expect(mainButtonFor("Zweite Sektion")).toHaveFocus();
  });

  it("continues j/k traversal into a ProjectStoryRow (story) mounted alongside a TaskOutline", async () => {
    const task = makeTask({ id: 3, title: "Vorbereitende Aufgabe", position: 0 });
    const story = makeProject({ id: 42, title: "Story im selben Scope", status: "active", ownerMemberId: 1 });
    const { container } = renderWithProviders(
      <>
        <WorkItemKeyboardNavMount />
        <TaskOutline tasks={[task]} emptyMessage="Nichts da" />
        <ul>
          <ProjectStoryRow story={story} />
        </ul>
      </>,
    );
    await screen.findByText("Vorbereitende Aufgabe");
    await screen.findByText("Story im selben Scope");

    await userEvent.keyboard("j");
    expect(mainButtonFor("Vorbereitende Aufgabe")).toHaveFocus();
    await userEvent.keyboard("j");
    const storyLink = container.querySelector('[data-workitem-id="42"] .story-row-main');
    expect(storyLink).toHaveFocus();
  });

  it("does not fire j/k/h/l while a text field is focused", async () => {
    const task = makeTask({ id: 1, title: "Aufgabe", position: 0 });
    renderWithProviders(
      <>
        <WorkItemKeyboardNavMount />
        <input aria-label="Anderes Feld" />
        <TaskOutline tasks={[task]} emptyMessage="Nichts da" />
      </>,
    );
    await screen.findByText("Aufgabe");

    const field = screen.getByLabelText("Anderes Feld");
    await userEvent.click(field);
    await userEvent.keyboard("j");

    expect(field).toHaveFocus();
  });

  it("does not fire j/k/h/l while a BottomSheet is open", async () => {
    const task = makeTask({ id: 1, title: "Aufgabe", position: 0 });
    renderWithProviders(
      <>
        <WorkItemKeyboardNavMount />
        <TaskOutline tasks={[task]} emptyMessage="Nichts da" />
        <BottomSheet title="Modal" onClose={() => {}}>
          <button type="button">Im Dialog</button>
        </BottomSheet>
      </>,
    );
    await screen.findByText("Aufgabe");

    await userEvent.keyboard("j");

    expect(mainButtonFor("Aufgabe")).not.toHaveFocus();
  });

  it("Enter opens the task natively once j has focused its row's primary button", async () => {
    mockedApi.completeTask.mockResolvedValue(makeTask());
    const task = makeTask({ id: 42, title: "Aufgabe öffnen", position: 0 });
    renderWithProviders(
      <>
        <WorkItemKeyboardNavMount />
        <TaskOutline tasks={[task]} emptyMessage="Nichts da" />
        <OpenTaskProbe />
      </>,
    );
    await screen.findByText("Aufgabe öffnen");

    await userEvent.keyboard("j");
    expect(mainButtonFor("Aufgabe öffnen")).toHaveFocus();

    await userEvent.keyboard("{enter}");

    expect(screen.getByTestId("open-task-id")).toHaveTextContent("42");
  });

  it("Alt+arrows call the structural mover only in an organizable (structurally valid) scope", async () => {
    mockedApi.moveTask.mockResolvedValue(makeTask({ id: 2 }));
    const first = makeTask({ id: 1, title: "Erste", position: 0 });
    const second = makeTask({ id: 2, title: "Zweite", position: 1 });
    renderWithProviders(
      <>
        <WorkItemKeyboardNavMount />
        <TaskOutline tasks={[first, second]} emptyMessage="Nichts da" />
      </>,
    );
    await screen.findByText("Erste");

    // A compiled view (organizable=false, the default here) must never
    // mutate sibling order via keyboard, mirroring the same restriction as
    // pointer drag -- the rendered set is not the complete stored group.
    await userEvent.keyboard("j");
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(mockedApi.moveTask).not.toHaveBeenCalled();
  });

  it("Alt+ArrowDown moves the active item and keeps focus on it once organizable", async () => {
    mockedApi.moveTask.mockResolvedValue(makeTask({ id: 1, position: 1 }));
    const first = makeTask({ id: 1, title: "Erste", position: 0 });
    const second = makeTask({ id: 2, title: "Zweite", position: 1 });
    renderWithProviders(
      <>
        <WorkItemKeyboardNavMount />
        <TaskOutline tasks={[first, second]} emptyMessage="Nichts da" organizable />
      </>,
    );
    await screen.findByText("Erste");

    await userEvent.keyboard("j");
    expect(mainButtonFor("Erste")).toHaveFocus();

    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");

    await waitFor(() => expect(mockedApi.moveTask).toHaveBeenCalled());
    await waitFor(() => expect(handleFor("Erste")).toHaveFocus());
  });

  it("Alt+ArrowRight (indent/reparent) keeps focus on the moved item", async () => {
    mockedApi.moveTask.mockResolvedValue(makeTask({ id: 2, parentTaskId: 1 }));
    const first = makeTask({ id: 1, title: "Erste", position: 0, children: [] });
    const second = makeTask({ id: 2, title: "Zweite", position: 1 });
    renderWithProviders(
      <>
        <WorkItemKeyboardNavMount />
        <TaskOutline tasks={[first, second]} emptyMessage="Nichts da" organizable />
      </>,
    );
    await screen.findByText("Erste");

    // Select "Zweite" directly so Alt+Right indents it under "Erste" (its
    // previous sibling), i.e. actually reparents it rather than merely
    // reordering it at the same level.
    await userEvent.click(handleFor("Zweite"));
    await userEvent.keyboard("{Alt>}{ArrowRight}{/Alt}");

    await waitFor(() => expect(mockedApi.moveTask).toHaveBeenCalled());
    await waitFor(() => expect(handleFor("Zweite")).toHaveFocus());
  });
});
