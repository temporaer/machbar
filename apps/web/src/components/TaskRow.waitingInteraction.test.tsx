import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { renderWithProviders } from "../test/testUtils";
import { TaskOutline } from "./TaskOutline";
import { api } from "../lib/api";
import { RETENTION_MS } from "../lib/useTaskActions";
import { makeMember, makeTask } from "../test/fixtures";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    getTags: vi.fn(),
    getTask: vi.fn(),
    completeTask: vi.fn(),
    cancelTask: vi.fn(),
    reopenTask: vi.fn(),
    updateTask: vi.fn(),
    reorderTask: vi.fn(),
    indentTask: vi.fn(),
    outdentTask: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

/** Simulates a horizontal drag past the swipe threshold and releases it. */
function swipe(container: HTMLElement, deltaX: number) {
  const content = container.querySelector(".task-row-content") as HTMLElement;
  fireEvent.pointerDown(content, { clientX: 0, pointerId: 1 });
  fireEvent.pointerMove(content, { clientX: deltaX, pointerId: 1 });
  fireEvent.pointerUp(content, { clientX: deltaX, pointerId: 1 });
}

/** Flushes the microtask queue (mutation `await`s) without depending on real timers. */
async function flushMicrotasks(times = 3) {
  for (let i = 0; i < times; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
}

describe("TaskOutline/TaskRow – waiting row mode (host interaction config)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1 })]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("right-swipe always sets a waiting task actionable, independent of the globally configured swipe action", async () => {
    // The global setting is deliberately something else entirely, to prove
    // waiting row mode overrides it rather than merely defaulting alongside it.
    window.localStorage.setItem("machbar:primary-swipe-action", "cancel");
    const task = makeTask({ id: 1, title: "Rückmeldung Steuerberater", status: "waiting", waitingFor: "Steuerberater" });
    mockedApi.updateTask.mockResolvedValue({ ...task, status: "actionable" });

    const { container } = renderWithProviders(
      <TaskOutline tasks={[task]} emptyMessage="Nichts da" waitingInteraction={{ onFollowUp: vi.fn() }} />,
    );
    await screen.findByText("Rückmeldung Steuerberater");

    swipe(container, 100);
    await act(async () => {
      await flushMicrotasks();
    });

    expect(mockedApi.updateTask).toHaveBeenCalledWith(1, {
      status: "actionable",
      expectedRevision: 1,
    });
    expect(mockedApi.cancelTask).not.toHaveBeenCalled();
  });

  it("reveals the 'Wieder machbar' label on the swipe background instead of the globally configured label", async () => {
    const task = makeTask({ id: 2, title: "Angebot einholen", status: "waiting" });
    const { container } = renderWithProviders(
      <TaskOutline tasks={[task]} emptyMessage="Nichts da" waitingInteraction={{ onFollowUp: vi.fn() }} />,
    );
    await screen.findByText("Angebot einholen");
    // Let any still-pending async work from the initial render (e.g. the
    // identity provider's member fetch) settle before driving pointer
    // events, so React has nothing left to flush outside of `act(...)`.
    await act(async () => {
      await flushMicrotasks();
    });

    const content = container.querySelector(".task-row-content") as HTMLElement;
    act(() => {
      fireEvent.pointerDown(content, { clientX: 0, pointerId: 1 });
      fireEvent.pointerMove(content, { clientX: 100, pointerId: 1 });
    });

    const bg = container.querySelector(".task-row-swipe-bg.complete");
    expect(bg).toHaveTextContent("Wieder machbar");
    expect(bg?.className).toContain("visible");

    // Releasing past the threshold fires the real `setStatus` mutation (see
    // `finishDrag`), whose `runTransition` continuation (busy/pending reset)
    // resolves on a later microtask — flush it inside `act` too, otherwise
    // that continuation lands after this synchronous callback returns and
    // React flags it as an update outside of `act`.
    await act(async () => {
      fireEvent.pointerUp(content, { clientX: 100, pointerId: 1 });
      await flushMicrotasks();
    });
  });

  it("keeps the row optimistically actionable through the existing 4s retention window, and rolls back with an inline error on failure", async () => {
    vi.useFakeTimers();
    const task = makeTask({ id: 3, title: "Antwort Nachbar", status: "waiting" });
    let resolveUpdate: (value: typeof task) => void = () => {};
    mockedApi.updateTask.mockReturnValue(
      new Promise((resolve) => {
        resolveUpdate = resolve;
      }),
    );

    const { container, rerender } = renderWithProviders(
      <TaskOutline tasks={[task]} emptyMessage="Nichts da" waitingInteraction={{ onFollowUp: vi.fn() }} />,
    );
    swipe(container, 100);
    await act(async () => {
      await flushMicrotasks();
    });

    expect(container.querySelector(".task-row-content.retained")).toBeInTheDocument();

    await act(async () => {
      resolveUpdate({ ...task, status: "actionable" });
      await flushMicrotasks();
    });

    // Compiled "Warten" view refetches and no longer includes the now-
    // actionable task — same retention contract as every other transition.
    rerender(<TaskOutline tasks={[]} emptyMessage="Nichts da" waitingInteraction={{ onFollowUp: vi.fn() }} />);
    expect(screen.getByText("Antwort Nachbar")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RETENTION_MS + 500);
    });
    expect(screen.queryByText("Antwort Nachbar")).not.toBeInTheDocument();
  });

  it("restores the row and shows an inline error when the underlying mutation fails", async () => {
    const task = makeTask({ id: 4, title: "Fehlerfall Warten", status: "waiting" });
    mockedApi.updateTask.mockRejectedValue(new Error("Netzwerkfehler"));

    const { container } = renderWithProviders(
      <TaskOutline tasks={[task]} emptyMessage="Nichts da" waitingInteraction={{ onFollowUp: vi.fn() }} />,
    );
    swipe(container, 100);

    await screen.findByText("Netzwerkfehler");
    expect(container.querySelector(".task-row-content.retained")).not.toBeInTheDocument();
  });

  it("shows a 'Nachhaken' chip with a full German aria-label/title only for a waiting task, and hands the task to the host callback", async () => {
    const task = makeTask({ id: 5, title: "Angebot Handwerker", status: "waiting" });
    const onFollowUp = vi.fn();

    renderWithProviders(<TaskOutline tasks={[task]} emptyMessage="Nichts da" waitingInteraction={{ onFollowUp }} />);
    await screen.findByText("Angebot Handwerker");

    fireEvent.click(screen.getByRole("button", { name: "Weitere Aktionen" }));
    const chips = screen.getByRole("group", { name: "Weitere Aktionen" });
    const chip = within(chips).getByRole("button", { name: "Nachhaken" });
    expect(chip).toHaveAttribute("title", "Nachhaken");

    fireEvent.click(chip);
    expect(onFollowUp).toHaveBeenCalledTimes(1);
    expect(onFollowUp).toHaveBeenCalledWith(expect.objectContaining({ id: 5 }));
    // Same as every other chip: activating it closes the strip.
    expect(screen.queryByRole("group", { name: "Weitere Aktionen" })).not.toBeInTheDocument();
  });

  it("does not show the 'Nachhaken' chip once the task is no longer waiting, even with the callback configured", async () => {
    const task = makeTask({ id: 6, title: "Bereits machbar", status: "actionable" });
    renderWithProviders(
      <TaskOutline tasks={[task]} emptyMessage="Nichts da" waitingInteraction={{ onFollowUp: vi.fn() }} />,
    );
    await screen.findByText("Bereits machbar");

    fireEvent.click(screen.getByRole("button", { name: "Weitere Aktionen" }));
    const chips = screen.getByRole("group", { name: "Weitere Aktionen" });
    expect(within(chips).queryByRole("button", { name: "Nachhaken" })).not.toBeInTheDocument();
  });

  it("does not show the 'Nachhaken' chip, and leaves standard swipe behavior untouched, when no waitingInteraction is passed (global-setting isolation)", async () => {
    window.localStorage.setItem("machbar:primary-swipe-action", "waiting");
    const task = makeTask({ id: 7, title: "Ganz normale Aufgabe", status: "waiting" });
    mockedApi.updateTask.mockResolvedValue({ ...task, status: "waiting" });

    const { container } = renderWithProviders(<TaskOutline tasks={[task]} emptyMessage="Nichts da" />);
    await screen.findByText("Ganz normale Aufgabe");

    fireEvent.click(screen.getByRole("button", { name: "Weitere Aktionen" }));
    const chips = screen.getByRole("group", { name: "Weitere Aktionen" });
    expect(within(chips).queryByRole("button", { name: "Nachhaken" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Weitere Aktionen" }));

    // Standard behavior: the globally configured "waiting" primary swipe
    // re-applies "waiting" (not "actionable") to an already-waiting task.
    swipe(container, 100);
    await act(async () => {
      await flushMicrotasks();
    });
    expect(mockedApi.updateTask).toHaveBeenCalledWith(7, {
      status: "waiting",
      expectedRevision: 1,
    });

    const bg = container.querySelector(".task-row-swipe-bg.complete");
    expect(bg).toHaveTextContent("Wartet");
    expect(bg).not.toHaveTextContent("Wieder machbar");
  });
});
