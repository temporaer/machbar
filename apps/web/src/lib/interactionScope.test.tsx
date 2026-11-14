import { describe, expect, it, vi, beforeEach } from "vitest";
import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/testUtils";
import { TaskOutline } from "../components/TaskOutline";
import { WorkItemKeyboardNavMount } from "../components/WorkItemKeyboardNavMount";
import { InteractionScopeProvider, useInteractionScope, type StructuralMoveDirection } from "./interactionScope";
import { api } from "./api";
import { makeMember, makeTask } from "../test/fixtures";

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

beforeEach(() => {
  vi.clearAllMocks();
  mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1 })]);
});

function ActiveIdProbe() {
  const scope = useInteractionScope();
  return <output data-testid="active-id">{String(scope.activeId)}</output>;
}

function ScopeProbe() {
  const scope = useInteractionScope();
  return (
    <>
      <output data-testid="capability">{String(scope.canReorder)}|{String(scope.canReparent)}|{String(Boolean(scope.moveBy))}</output>
      <output data-testid="rails">{scope.openRailId ?? "none"}|{scope.openLifecycleId ?? "none"}</output>
      <button onClick={() => scope.setOpenRail(1)}>Rail 1</button>
      <button onClick={() => scope.setOpenRail(2)}>Rail 2</button>
      <button onClick={() => scope.setOpenLifecycle(3)}>Lifecycle 3</button>
    </>
  );
}

describe("useInteractionScope", () => {
  it("throws outside of a provider", () => {
    function Probe() {
      useInteractionScope();
      return null;
    }
    expect(() => render(<Probe />)).toThrow(/InteractionScopeProvider/);
  });

  it("shares one logical active item across every TaskOutline mounted in the same scope", async () => {
    // Two separate project outlines (distinct sibling groups) mounted side
    // by side, as e.g. a future zoomed subtree view or a page rendering
    // several outlines at once would. Before this consolidation each
    // `useOutlineOrganize` instance kept its own private `selectedId`, so
    // moving the cursor in one outline never affected the other. They must
    // now share exactly one active item, sourced from the interaction
    // scope both are rendered inside -- demonstrated here via the shared
    // `j` keyboard cursor rather than the removed selection toolbar.
    const outlineA = [makeTask({ id: 1, title: "Alpha", position: 0, projectId: 5 })];
    const outlineB = [makeTask({ id: 2, title: "Delta", position: 0, projectId: 6 })];
    renderWithProviders(
      <>
        <WorkItemKeyboardNavMount />
        <TaskOutline tasks={outlineA} emptyMessage="Nichts da" organizable />
        <TaskOutline tasks={outlineB} emptyMessage="Nichts da" organizable />
        <ActiveIdProbe />
      </>,
    );
    await screen.findByText("Alpha");
    await screen.findByText("Delta");

    expect(screen.getByTestId("active-id")).toHaveTextContent("null");

    // Moving the cursor with `j` lands on Alpha (outline A) first, then on
    // Delta (outline B) -- proving the two outlines read and advance one
    // shared active id rather than each keeping an independent selection.
    await userEvent.keyboard("j");
    expect(screen.getByTestId("active-id")).toHaveTextContent("1");

    await userEvent.keyboard("j");
    expect(screen.getByTestId("active-id")).toHaveTextContent("2");
  });

  it("declares structural capability from the mounted outline's own organizable prop", async () => {
    function CapabilityProbe() {
      const scope = useInteractionScope();
      return <output data-testid="can-reorder">{String(scope.canReorder)}</output>;
    }
    const { rerender } = renderWithProviders(
      <>
        <TaskOutline tasks={[]} emptyMessage="Nichts da" />
        <CapabilityProbe />
      </>,
    );
    expect(screen.getByTestId("can-reorder")).toHaveTextContent("false");

    rerender(
      <>
        <TaskOutline tasks={[]} emptyMessage="Nichts da" organizable />
        <CapabilityProbe />
      </>,
    );
    expect(await screen.findByText("true")).toBeInTheDocument();
  });

  it("retires structural capability when the project outline unmounts or becomes compiled", () => {
    const task = makeTask({ id: 1 });
    const { rerender } = renderWithProviders(
      <><TaskOutline tasks={[task]} emptyMessage="Empty" organizable /><ScopeProbe /></>,
    );
    expect(screen.getByTestId("capability")).toHaveTextContent("true|true|true");
    rerender(<ScopeProbe />);
    expect(screen.getByTestId("capability")).toHaveTextContent("false|false|false");
    rerender(<><TaskOutline tasks={[task]} emptyMessage="Empty" organizable /><ScopeProbe /></>);
    rerender(<><TaskOutline tasks={[task]} emptyMessage="Empty" /><ScopeProbe /></>);
    expect(screen.getByTestId("capability")).toHaveTextContent("false|false|false");
  });

  it.each([false, true])("routes keyboard movement to the active outline with compiled sibling first=%s", async (compiledFirst) => {
    const first = makeTask({ id: 1, title: "Alpha", position: 0, projectId: 5 });
    const second = makeTask({ id: 2, title: "Beta", position: 1, projectId: 5 });
    const third = makeTask({ id: 3, title: "Gamma", position: 0, projectId: 6 });
    const fourth = makeTask({ id: 4, title: "Delta", position: 1, projectId: 6 });
    mockedApi.moveTask.mockResolvedValue(first);
    const compiled = <TaskOutline key="compiled" tasks={[makeTask({ id: 9, title: "Compiled" })]} emptyMessage="Empty" />;
    const outlines = [
      <TaskOutline key="a" tasks={[first, second]} emptyMessage="Empty" organizable />,
      <TaskOutline key="b" tasks={[third, fourth]} emptyMessage="Empty" organizable />,
    ];
    const { rerender } = renderWithProviders(
      <><WorkItemKeyboardNavMount />{compiledFirst && compiled}{outlines}{!compiledFirst && compiled}<ScopeProbe /></>,
    );
    await userEvent.keyboard("j");
    if (compiledFirst) await userEvent.keyboard("j");
    expect(screen.getByRole("button", { name: "Alpha" })).toHaveFocus();
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await waitFor(() => expect(mockedApi.moveTask).toHaveBeenCalledWith(1, expect.objectContaining({ position: 1 })));

    rerender(<><WorkItemKeyboardNavMount />{outlines[0]}{compiled}<ScopeProbe /></>);
    expect(screen.getByTestId("capability")).toHaveTextContent("true|true|true");
    await userEvent.keyboard("j");
    await userEvent.keyboard("k");
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await waitFor(() => expect(mockedApi.moveTask).toHaveBeenCalledTimes(2));
  });

  it("keeps swipe and lifecycle rails mutually exclusive across rows", async () => {
    renderWithProviders(<ScopeProbe />);
    fireEvent.click(screen.getByText("Rail 1"));
    expect(screen.getByTestId("rails")).toHaveTextContent("1|none");
    fireEvent.click(screen.getByText("Rail 2"));
    expect(screen.getByTestId("rails")).toHaveTextContent("2|none");
    fireEvent.click(screen.getByText("Lifecycle 3"));
    expect(screen.getByTestId("rails")).toHaveTextContent("none|3");
    fireEvent.click(screen.getByText("Rail 1"));
    expect(screen.getByTestId("rails")).toHaveTextContent("1|none");
  });

  it("does not restore an unmounted outline when its pending move completes after replacement", async () => {
    const first = makeTask({ id: 1, title: "Alpha", position: 0, projectId: 5 });
    const second = makeTask({ id: 2, title: "Beta", position: 1, projectId: 5 });
    const replacement = makeTask({ id: 3, title: "Gamma", position: 0, projectId: 6 });
    const sibling = makeTask({ id: 4, title: "Delta", position: 1, projectId: 6 });
    let finish!: (task: typeof first) => void;
    mockedApi.moveTask.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const { rerender } = renderWithProviders(
      <StrictMode><WorkItemKeyboardNavMount /><TaskOutline key="old" tasks={[first, second]} emptyMessage="Empty" organizable /><ScopeProbe /></StrictMode>,
    );
    await userEvent.keyboard("j");
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await waitFor(() => expect(mockedApi.moveTask).toHaveBeenCalledTimes(1));
    rerender(<StrictMode><WorkItemKeyboardNavMount /><TaskOutline key="new" tasks={[replacement, sibling]} emptyMessage="Empty" organizable /><ScopeProbe /></StrictMode>);
    expect(screen.getByTestId("capability")).toHaveTextContent("true|true|true");
    await act(async () => finish(first));
    expect(screen.getByTestId("capability")).toHaveTextContent("true|true|true");
    mockedApi.moveTask.mockResolvedValueOnce(replacement);
    await userEvent.keyboard("j");
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await waitFor(() => expect(mockedApi.moveTask).toHaveBeenCalledWith(3, expect.objectContaining({ position: 1 })));
  });

  it("retires a previously read mover and resets state when the page scope is replaced", async () => {
    const first = makeTask({ id: 1, title: "Alpha", position: 0 });
    const second = makeTask({ id: 2, title: "Beta", position: 1 });
    let oldMove: ((id: number, direction: StructuralMoveDirection) => void) | null = null;
    function ReadMover() {
      const { moveBy } = useInteractionScope();
      if (moveBy && !oldMove) oldMove = moveBy;
      return <ActiveIdProbe />;
    }
    const page = (key: string, outline: boolean) => (
      <InteractionScopeProvider key={key}>
        <WorkItemKeyboardNavMount />
        {outline && <TaskOutline tasks={[first, second]} emptyMessage="Empty" organizable />}
        <ReadMover />
        <ScopeProbe />
      </InteractionScopeProvider>
    );
    const { rerender } = renderWithProviders(page("old", true));
    await userEvent.keyboard("j");
    expect(screen.getByTestId("active-id")).toHaveTextContent("1");
    expect(oldMove).not.toBeNull();
    rerender(page("new", false));
    expect(screen.getByTestId("active-id")).toHaveTextContent("null");
    expect(screen.getByTestId("capability")).toHaveTextContent("false|false|false");
    act(() => oldMove?.(1, "down"));
    expect(mockedApi.moveTask).not.toHaveBeenCalled();
  });
});
