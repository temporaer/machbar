import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { MemoryRouter, Routes, Route, useParams } from "react-router-dom";
import { render, fireEvent, screen, act, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IdentityProvider } from "../lib/identity";
import { RefreshProvider } from "../lib/refresh";
import { TaskDetailProvider, useTaskDetail } from "../lib/taskDetailContext";
import { api } from "../lib/api";
import { makeMember } from "../test/fixtures";
import type { RefinementListItem } from "../lib/useRefinementActions";
import { useRefinementActions, REFINEMENT_RETENTION_MS } from "../lib/useRefinementActions";
import { RefinementTaskRow } from "./RefinementTaskRow";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    updateTask: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

function makeItem(overrides: Partial<RefinementListItem> = {}): RefinementListItem {
  return {
    id: 1,
    title: "Angebot erstellen",
    status: "actionable",
    size: null,
    projectId: null,
    projectTitle: null,
    effectiveOwnerId: null,
    effectiveOwnerSource: "none",
    position: 0,
    updatedAt: "2026-01-01T09:00:00.000Z",
    blocked: false,
    effectiveTags: [],
    waitingFor: null,
    ...overrides,
  };
}

/** Records which task id/focus field the *full* task detail sheet was opened for, without mounting it. */
function OpenSpy({ onOpen }: { onOpen: (id: number, field?: string) => void }) {
  const { openTaskId, focusField } = useTaskDetail();
  if (openTaskId !== null) onOpen(openTaskId, focusField ?? undefined);
  return null;
}

function Harness({
  task,
  onOpen,
  routes = false,
}: {
  task: RefinementListItem;
  onOpen: (id: number, field?: string) => void;
  routes?: boolean;
}) {
  const actions = useRefinementActions();
  const row = <RefinementTaskRow task={task} ownerName={null} actions={actions} />;
  if (!routes) return row;
  return (
    <Routes>
      <Route path="/" element={row} />
      <Route
        path="/projekte/:id"
        element={
          <ProjectMarker />
        }
      />
    </Routes>
  );
}

function ProjectMarker() {
  const { id } = useParams();
  return <div data-testid="project-page">Projektseite {id}</div>;
}

function renderRow(task: RefinementListItem, opts: { routes?: boolean } = {}) {
  const onOpen = vi.fn();
  const utils = render(
    <MemoryRouter initialEntries={["/"]}>
      <IdentityProvider>
        <RefreshProvider>
          <TaskDetailProvider>
            <Harness task={task} onOpen={onOpen} routes={opts.routes ?? false} />
            <OpenSpy onOpen={onOpen} />
          </TaskDetailProvider>
        </RefreshProvider>
      </IdentityProvider>
    </MemoryRouter>,
  );
  return { ...utils, onOpen };
}

function swipe(container: HTMLElement, deltaX: number) {
  const content = container.querySelector(".refinement-row-content") as HTMLElement;
  fireEvent.pointerDown(content, { clientX: 0, pointerId: 1 });
  fireEvent.pointerMove(content, { clientX: deltaX, pointerId: 1 });
  fireEvent.pointerUp(content, { clientX: deltaX, pointerId: 1 });
}

async function flushMicrotasks(times = 3) {
  for (let i = 0; i < times; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
}

describe("RefinementTaskRow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.getMembers.mockResolvedValue([
      makeMember({ id: 1, name: "Mira" }),
      makeMember({ id: 2, name: "Jonas" }),
    ]);
  });

  it("shows story/owner/status meta and the current size on the badge", async () => {
    const task = makeItem({ title: "Kunde anrufen", projectTitle: "Hausumbau", size: "M" });
    renderRow(task);
    expect(await screen.findByText("Kunde anrufen")).toBeInTheDocument();
    expect(screen.getByText(/Hausumbau/)).toBeInTheDocument();
    expect(screen.getByText("M")).toBeInTheDocument();
  });

  it("shows blocked and waiting-for context when present", async () => {
    const task = makeItem({ status: "waiting", waitingFor: "Antwort vom Handwerker", blocked: true });
    renderRow(task);
    expect(await screen.findByText(/Antwort vom Handwerker/)).toBeInTheDocument();
    expect(screen.getByLabelText("Blockiert durch")).toBeInTheDocument();
  });

  it("a right swipe past the threshold cycles the size forward (null -> S)", async () => {
    const task = makeItem({ id: 20, size: null });
    mockedApi.updateTask.mockResolvedValue({ ...task, size: "S" } as never);
    const { container } = renderRow(task);

    swipe(container, 100);
    await act(async () => {
      await flushMicrotasks();
    });

    expect(mockedApi.updateTask).toHaveBeenCalledWith(20, { size: "S" });
  });

  it("cycles XL back to unestimated (null) rather than remaining stuck at XL", async () => {
    const task = makeItem({ id: 21, size: "XL" });
    mockedApi.updateTask.mockResolvedValue({ ...task, size: null } as never);
    const { container } = renderRow(task);

    swipe(container, 100);
    await act(async () => {
      await flushMicrotasks();
    });

    expect(mockedApi.updateTask).toHaveBeenCalledWith(21, { size: null });
  });

  it("also cycles the size via a plain click on the size badge (non-gesture alternative)", async () => {
    const task = makeItem({ id: 22, size: "S" });
    mockedApi.updateTask.mockResolvedValue({ ...task, size: "M" } as never);
    renderRow(task);

    await userEvent.click(screen.getByRole("button", { name: /Aufwand: S/ }));
    await act(async () => {
      await flushMicrotasks();
    });

    expect(mockedApi.updateTask).toHaveBeenCalledWith(22, { size: "M" });
  });

  it("a left swipe past the threshold reveals direct S/M/L/XL/clear/assign/project chips", async () => {
    const task = makeItem({ id: 23 });
    const { container } = renderRow(task);
    await screen.findByText("Angebot erstellen");

    swipe(container, -100);

    const chips = screen.getByRole("group", { name: "Weitere Aktionen" });
    expect(chips).toBeInTheDocument();
    for (const label of ["S", "M", "L", "XL"]) {
      expect(screen.getAllByRole("button", { name: label }).length).toBeGreaterThan(0);
    }
    expect(screen.getByRole("button", { name: "Aufwand entfernen" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Zuweisen" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Zum Projekt" })).toBeInTheDocument();
  });

  it("also opens the chip strip via the ⋯ kebab (non-gesture access)", async () => {
    const task = makeItem({ id: 24 });
    renderRow(task);

    await userEvent.click(screen.getByRole("button", { name: "Weitere Aktionen" }));
    expect(screen.getByRole("group", { name: "Weitere Aktionen" })).toBeInTheDocument();
  });

  it("a direct size chip sets the exact chosen size", async () => {
    const task = makeItem({ id: 25, size: "S" });
    mockedApi.updateTask.mockResolvedValue({ ...task, size: "XL" } as never);
    const { container } = renderRow(task);

    swipe(container, -100);
    await userEvent.click(screen.getByRole("button", { name: "XL" }));
    await act(async () => {
      await flushMicrotasks();
    });

    expect(mockedApi.updateTask).toHaveBeenCalledWith(25, { size: "XL" });
    // Chip strip closes after choosing.
    expect(screen.queryByRole("group", { name: "Weitere Aktionen" })).not.toBeInTheDocument();
  });

  it("'Aufwand entfernen' clears the size to null", async () => {
    const task = makeItem({ id: 26, size: "L" });
    mockedApi.updateTask.mockResolvedValue({ ...task, size: null } as never);
    const { container } = renderRow(task);

    swipe(container, -100);
    await userEvent.click(screen.getByRole("button", { name: "Aufwand entfernen" }));
    await act(async () => {
      await flushMicrotasks();
    });

    expect(mockedApi.updateTask).toHaveBeenCalledWith(26, { size: null });
  });

  it("'Zuweisen' opens the focused assignment popup — never the full task detail sheet", async () => {
    const task = makeItem({ id: 27 });
    mockedApi.updateTask.mockResolvedValue({ ...task, effectiveOwnerId: 2 } as never);
    const { container, onOpen } = renderRow(task);

    swipe(container, -100);
    await userEvent.click(screen.getByRole("button", { name: "Zuweisen" }));

    // Only the single Zuständig control — no title/notes/tags editor, and the
    // shared task-detail context is never opened.
    const group = await screen.findByRole("group", { name: "Zuständig" });
    expect(screen.queryByLabelText("Titel")).not.toBeInTheDocument();
    expect(onOpen).not.toHaveBeenCalled();

    // Tap targets, not a native <select>: the whole household is on screen.
    expect(within(group).queryByRole("combobox")).not.toBeInTheDocument();
    expect(
      within(group)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Gemeinsam / offen", "Mira", "Jonas"]);
    expect(within(group).getByRole("button", { name: "Gemeinsam / offen" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await userEvent.click(within(group).getByRole("button", { name: "Jonas" }));
    expect(within(group).getByRole("button", { name: "Jonas" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(group).getByRole("button", { name: "Gemeinsam / offen" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    await userEvent.click(screen.getByRole("button", { name: "Änderungen speichern" }));

    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(27, {
        ownerMemberId: 2,
        ownerInheritanceMode: "explicit",
      }),
    );
    // The popup closes again and the row keeps the new owner optimistically.
    expect(screen.queryByRole("group", { name: "Zuständig" })).not.toBeInTheDocument();
    expect(container.querySelector(".refinement-row-content.retained")).toBeInTheDocument();
  });

  it("clears the owner back to the shared bucket from the same popup", async () => {
    const task = makeItem({ id: 32, effectiveOwnerId: 2, effectiveOwnerSource: "task" });
    mockedApi.updateTask.mockResolvedValue({ ...task, effectiveOwnerId: null } as never);
    const { container } = renderRow(task);

    swipe(container, -100);
    await userEvent.click(screen.getByRole("button", { name: "Zuweisen" }));
    const group = await screen.findByRole("group", { name: "Zuständig" });
    // The current owner starts pressed, so the state is visible before tapping.
    expect(within(group).getByRole("button", { name: "Jonas" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await userEvent.click(within(group).getByRole("button", { name: "Gemeinsam / offen" }));
    await userEvent.click(screen.getByRole("button", { name: "Änderungen speichern" }));

    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(32, {
        ownerMemberId: null,
        ownerInheritanceMode: "none",
      }),
    );
  });

  it("'Zum Projekt' navigates to the task's project and is disabled when there is none", async () => {
    const task = makeItem({ id: 28, projectId: 77 });
    const { container } = render(
      <MemoryRouter initialEntries={["/"]}>
        <IdentityProvider>
          <RefreshProvider>
            <TaskDetailProvider>
              <Harness task={task} onOpen={vi.fn()} routes />
            </TaskDetailProvider>
          </RefreshProvider>
        </IdentityProvider>
      </MemoryRouter>,
    );

    swipe(container, -100);
    await userEvent.click(screen.getByRole("button", { name: "Zum Projekt" }));
    expect(await screen.findByTestId("project-page")).toHaveTextContent("Projektseite 77");
  });

  it("disables 'Zum Projekt' for a projectless task", async () => {
    const task = makeItem({ id: 29, projectId: null });
    const { container } = renderRow(task);
    await screen.findByText("Angebot erstellen");

    swipe(container, -100);
    const chip = screen.getByRole("button", { name: "Zum Projekt" });
    expect(chip).toBeDisabled();
  });

  it("retains the row (muted, disabled) with its new size for the retention window after a size change", async () => {
    const task = makeItem({ id: 30, size: "S" });
    mockedApi.updateTask.mockResolvedValue({ ...task, size: "M" } as never);
    vi.useFakeTimers();
    const { container } = renderRow(task);

    swipe(container, 100);
    await act(async () => {
      await flushMicrotasks();
    });

    expect(container.querySelector(".refinement-row-content.retained")).toBeInTheDocument();
    expect(screen.getByText("M")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFINEMENT_RETENTION_MS + 500);
    });
    expect(container.querySelector(".refinement-row-content.retained")).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("shows an inline error and does not retain a bad optimistic state when the mutation fails", async () => {
    const task = makeItem({ id: 31, size: "S" });
    mockedApi.updateTask.mockRejectedValue(new Error("Netzwerkfehler"));
    const { container } = renderRow(task);

    swipe(container, 100);
    await screen.findByText("Netzwerkfehler");
    expect(container.querySelector(".refinement-row-content.retained")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Schließen" }));
    expect(screen.queryByText("Netzwerkfehler")).not.toBeInTheDocument();
  });
});
