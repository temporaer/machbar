import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/testUtils";
import { TaskOutline } from "../components/TaskOutline";
import { WorkItemKeyboardNavMount } from "../components/WorkItemKeyboardNavMount";
import { useInteractionScope } from "./interactionScope";
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
});
