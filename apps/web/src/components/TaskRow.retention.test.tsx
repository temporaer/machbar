import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { Task } from "@machbar/shared";
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

/** Flushes the microtask queue (mutation `await`s) without depending on real timers. */
async function flushMicrotasks(times = 3) {
  for (let i = 0; i < times; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
}

describe("TaskRow – retention of recently mutated rows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1 })]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a completed row visible with crossed-out styling after it leaves the compiled view, then drops it once the retention window elapses", async () => {
    vi.useFakeTimers();
    const task = makeTask({ id: 100, title: "Bericht abschicken", status: "actionable" });
    // Held open so the in-flight (busy) phase can be observed before the
    // mutation resolves.
    let resolveComplete: (value: Task) => void = () => {};
    mockedApi.completeTask.mockReturnValue(
      new Promise<Task>((resolve) => {
        resolveComplete = resolve;
      }),
    );

    const { rerender, container } = renderWithProviders(<TaskOutline tasks={[task]} emptyMessage="Nichts da" />);
    expect(screen.getByText("Bericht abschicken")).toBeInTheDocument();

    const checkbox = screen.getByRole("button", { name: "Erledigt" });
    fireEvent.click(checkbox);
    await act(async () => {
      await flushMicrotasks();
    });

    // Optimistic: crossed out immediately, before the network call is confirmed to the rest of the app.
    expect(mockedApi.completeTask).toHaveBeenCalledWith(100, "leave_open");
    const title = screen.getByText("Bericht abschicken");
    expect(title.className).toContain("done");
    expect(container.querySelector(".task-row-content.retained")).toBeInTheDocument();
    // Only *while the request is still in flight* is the row's own control
    // disabled, so the same task can't be mutated twice concurrently.
    expect(screen.getByRole("button", { name: "Wieder öffnen" })).toBeDisabled();

    await act(async () => {
      resolveComplete({ ...task, status: "done" });
      await flushMicrotasks();
    });

    // Once the request has completed the retained row is deliberately
    // actionable again — it keeps its optimistic crossed-out styling, but a
    // further tap/swipe may immediately continue the state cycle
    // (erledigt -> wieder offen) without waiting for retention to elapse.
    expect(container.querySelector(".task-row-content.retained")).toBeInTheDocument();
    expect(screen.getByText("Bericht abschicken").className).toContain("done");
    expect(screen.getByRole("button", { name: "Wieder öffnen" })).not.toBeDisabled();

    // The compiled view (Heute/Eingang/Suche/…) refetches and this task's new
    // status no longer matches that view's criteria — simulate it vanishing
    // from the `tasks` prop.
    rerender(<TaskOutline tasks={[]} emptyMessage="Nichts da" />);

    // Still rendered — retained — right after the prop-level removal.
    expect(screen.getByText("Bericht abschicken")).toBeInTheDocument();
    expect(container.querySelector(".task-row-content.retained")).toBeInTheDocument();

    // Not yet expired just before the retention window ends.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RETENTION_MS - 500);
    });
    expect(screen.getByText("Bericht abschicken")).toBeInTheDocument();

    // Past the retention window, the row is finally allowed to disappear.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.queryByText("Bericht abschicken")).not.toBeInTheDocument();
  });

  it("keeps a cancelled row visible with cancelled/crossed-out styling during the retention window", async () => {
    vi.useFakeTimers();
    const task = makeTask({ id: 101, title: "Altes Angebot", status: "actionable" });
    mockedApi.cancelTask.mockResolvedValue({ ...task, status: "cancelled" });
    window.localStorage.setItem("machbar:primary-swipe-action", "cancel");

    const { rerender, container } = renderWithProviders(<TaskOutline tasks={[task]} emptyMessage="Nichts da" />);
    // Drive it through the configured primary-swipe path rather than the checkbox,
    // since 'cancel' is only reachable that way (no direct cancel toggle button).
    const content = container.querySelector(".task-row-content") as HTMLElement;
    fireEvent.pointerDown(content, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(content, { clientX: 100, pointerId: 1 });
    fireEvent.pointerUp(content, { clientX: 100, pointerId: 1 });

    await act(async () => {
      await flushMicrotasks();
    });

    expect(mockedApi.cancelTask).toHaveBeenCalledWith(101, "leave_open");
    expect(screen.getByText("Altes Angebot").className).toContain("cancelled");

    rerender(<TaskOutline tasks={[]} emptyMessage="Nichts da" />);
    expect(screen.getByText("Altes Angebot")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RETENTION_MS + 500);
    });
    expect(screen.queryByText("Altes Angebot")).not.toBeInTheDocument();
  });

  it("restores the row and shows an inline error when the mutation fails, instead of retaining a bad optimistic state", async () => {
    const task = makeTask({ id: 102, title: "Fehlerfall", status: "actionable" });
    mockedApi.completeTask.mockRejectedValue(new Error("Netzwerkfehler"));

    renderWithProviders(<TaskOutline tasks={[task]} emptyMessage="Nichts da" />);
    const checkbox = screen.getByRole("button", { name: "Erledigt" });
    fireEvent.click(checkbox);

    await screen.findByText("Netzwerkfehler");

    // Rolled back: no longer shown as done, and the checkbox is usable again.
    expect(screen.getByText("Fehlerfall").className).not.toContain("done");
    expect(screen.getByRole("button", { name: "Erledigt" })).not.toBeDisabled();

    // The inline error can be dismissed explicitly.
    fireEvent.click(screen.getByRole("button", { name: "Schließen" }));
    expect(screen.queryByText("Netzwerkfehler")).not.toBeInTheDocument();
  });

  it("does not leave a stale retention timer running after the owning component unmounts", async () => {
    vi.useFakeTimers();
    const task = makeTask({ id: 103, title: "Wird entfernt", status: "actionable" });
    mockedApi.completeTask.mockResolvedValue({ ...task, status: "done" });

    const { unmount } = renderWithProviders(<TaskOutline tasks={[task]} emptyMessage="Nichts da" />);
    fireEvent.click(screen.getByRole("button", { name: "Erledigt" }));
    await act(async () => {
      await flushMicrotasks();
    });

    // Unmount mid-retention-window; the pending setTimeout callback must not
    // fire a setState on an unmounted component (useTaskActions clears its
    // timers on cleanup).
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RETENTION_MS + 1000);
    });
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining("memory leak"));
    errorSpy.mockRestore();
  });
});

describe("useTaskActions – retention timing constant", () => {
  it("keeps rows around for a reasonable 3-5s-ish window as required", () => {
    expect(RETENTION_MS).toBeGreaterThanOrEqual(3000);
    expect(RETENTION_MS).toBeLessThanOrEqual(5000);
  });
});

describe("TaskRow – parent retention snapshot covers the whole optimistic subtree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1 })]);
  });

  it("marks every open descendant (recursively, at any depth) done when completing a parent with 'complete_children'", async () => {
    const grandchild = makeTask({ id: 303, title: "Enkel", status: "actionable" });
    const openChild = makeTask({ id: 302, title: "Kind offen", status: "actionable", children: [grandchild] });
    const alreadyDoneChild = makeTask({
      id: 304,
      title: "Kind bereits erledigt",
      status: "done",
      completedAt: "2025-01-01T00:00:00.000Z",
    });
    const parent = makeTask({ id: 301, title: "Elternaufgabe", status: "actionable", children: [openChild, alreadyDoneChild] });
    mockedApi.completeTask.mockResolvedValue({ ...parent, status: "done" });

    const { container } = renderWithProviders(<TaskOutline tasks={[parent]} emptyMessage="Nichts da" />);
    await screen.findByText("Elternaufgabe");

    // The parent's own checkbox is the first "Erledigt" control in document order.
    const parentCheckbox = container.querySelector(".list > .task-row > .task-row-content > .task-row-checkbox") as HTMLElement;
    fireEvent.click(parentCheckbox);

    // Open descendants exist, so the mandatory policy prompt appears first.
    await screen.findByText("Wie soll mit den Teilaufgaben verfahren werden?");
    fireEvent.click(screen.getByRole("button", { name: "Teilaufgaben ebenfalls erledigen" }));

    await act(async () => {
      await flushMicrotasks();
    });

    expect(mockedApi.completeTask).toHaveBeenCalledWith(301, "complete_children");
    expect(mockedApi.cancelTask).not.toHaveBeenCalled();

    // Visual regression: the whole retained subtree — parent, the
    // previously-open child, and its previously-open grandchild — must show
    // the done/crossed-out styling immediately, not just the parent row.
    expect(screen.getByText("Elternaufgabe").className).toContain("done");
    expect(screen.getByText("Kind offen").className).toContain("done");
    expect(screen.getByText("Enkel").className).toContain("done");
    // An already-closed descendant keeps its own (done) state untouched.
    expect(screen.getByText("Kind bereits erledigt").className).toContain("done");
  });

  it("marks open descendants cancelled (recursively) when completing a parent but choosing to discard its children", async () => {
    const grandchild = makeTask({ id: 313, title: "Enkel B", status: "actionable" });
    const openChild = makeTask({ id: 312, title: "Kind offen B", status: "actionable", children: [grandchild] });
    const parent = makeTask({ id: 311, title: "Elternaufgabe B", status: "actionable", children: [openChild] });
    mockedApi.completeTask.mockResolvedValue({ ...parent, status: "done" });
    mockedApi.cancelTask.mockResolvedValue({ ...openChild, status: "cancelled" });

    const { container } = renderWithProviders(<TaskOutline tasks={[parent]} emptyMessage="Nichts da" />);
    await screen.findByText("Elternaufgabe B");

    const parentCheckbox = container.querySelector(".list > .task-row > .task-row-content > .task-row-checkbox") as HTMLElement;
    fireEvent.click(parentCheckbox);
    await screen.findByText("Wie soll mit den Teilaufgaben verfahren werden?");
    fireEvent.click(screen.getByRole("button", { name: "Teilaufgaben verwerfen" }));

    await act(async () => {
      await flushMicrotasks();
    });

    // Mixed policy: parent completes, its open descendants get cancelled —
    // via the real cascading cancelTask(openChild.id, "cancel_children") call.
    expect(mockedApi.cancelTask).toHaveBeenCalledWith(312, "cancel_children");
    expect(mockedApi.completeTask).toHaveBeenCalledWith(311, "leave_open");

    expect(screen.getByText("Elternaufgabe B").className).toContain("done");
    expect(screen.getByText("Kind offen B").className).toContain("cancelled");
    expect(screen.getByText("Enkel B").className).toContain("cancelled");
  });

  it("still retains a single nested task's own completion correctly, without touching its untouched parent, and without duplicating it at root", async () => {
    const child = makeTask({ id: 322, title: "Einzelnes Kind", status: "actionable" });
    const parent = makeTask({ id: 321, title: "Unveränderter Elternteil", status: "actionable", children: [child] });
    mockedApi.completeTask.mockResolvedValue({ ...child, status: "done" });

    const { container, rerender } = renderWithProviders(<TaskOutline tasks={[parent]} emptyMessage="Nichts da" />);
    await screen.findByText("Einzelnes Kind");

    // The child has no descendants of its own, so completing it never shows
    // the policy prompt — it's the second "Erledigt" control in document order.
    const checkboxes = screen.getAllByRole("button", { name: "Erledigt" });
    expect(checkboxes).toHaveLength(2);
    fireEvent.click(checkboxes[1]!);

    await act(async () => {
      await flushMicrotasks();
    });

    expect(mockedApi.completeTask).toHaveBeenCalledWith(322, "leave_open");
    expect(screen.getByText("Einzelnes Kind").className).toContain("done");
    // The parent itself is untouched by its child's own completion.
    expect(screen.getByText("Unveränderter Elternteil").className).not.toContain("done");

    // Simulate a refetch where the parent (and its still-nested child) are
    // unchanged in the compiled view. The retained child must not be
    // reinserted as a spurious duplicate root row alongside its still-present
    // nested rendering.
    rerender(<TaskOutline tasks={[parent]} emptyMessage="Nichts da" />);
    expect(screen.getAllByText("Einzelnes Kind")).toHaveLength(1);
    expect(container.querySelectorAll(".list > .task-row").length).toBe(1);
  });
});

describe("TaskRow – finished/cancelled rows offer 'Wieder öffnen' instead of a generic 'Warten' chip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1 })]);
    mockedApi.reopenTask.mockResolvedValue(makeTask());
  });

  it("shows 'Wieder öffnen' (not 'Warten') for a done task, and reopens via the real reopen flow", async () => {
    const task = makeTask({ id: 401, title: "Fertige Aufgabe", status: "done", completedAt: "2025-01-01T00:00:00.000Z" });
    renderWithProviders(<TaskOutline tasks={[task]} emptyMessage="Nichts da" />);
    await screen.findByText("Fertige Aufgabe");

    fireEvent.click(screen.getByRole("button", { name: "Weitere Aktionen" }));
    const chips = screen.getByRole("group", { name: "Weitere Aktionen" });

    expect(within(chips).getByRole("button", { name: "Wieder öffnen" })).toBeInTheDocument();
    expect(within(chips).queryByRole("button", { name: "Warten" })).not.toBeInTheDocument();

    fireEvent.click(within(chips).getByRole("button", { name: "Wieder öffnen" }));

    await waitFor(() => expect(mockedApi.reopenTask).toHaveBeenCalledWith(401));
    // Must go through the dedicated reopen flow, never a generic status patch
    // (which wouldn't clear completedAt/cancelledAt on the backend).
    expect(mockedApi.updateTask).not.toHaveBeenCalled();
  });

  it("shows 'Wieder öffnen' (not 'Warten') for a cancelled task, and reopens via the real reopen flow", async () => {
    const task = makeTask({ id: 402, title: "Verworfene Aufgabe", status: "cancelled", cancelledAt: "2025-01-01T00:00:00.000Z" });
    renderWithProviders(<TaskOutline tasks={[task]} emptyMessage="Nichts da" />);
    await screen.findByText("Verworfene Aufgabe");

    fireEvent.click(screen.getByRole("button", { name: "Weitere Aktionen" }));
    const chips = screen.getByRole("group", { name: "Weitere Aktionen" });

    expect(within(chips).getByRole("button", { name: "Wieder öffnen" })).toBeInTheDocument();
    expect(within(chips).queryByRole("button", { name: "Warten" })).not.toBeInTheDocument();

    fireEvent.click(within(chips).getByRole("button", { name: "Wieder öffnen" }));

    await waitFor(() => expect(mockedApi.reopenTask).toHaveBeenCalledWith(402));
    expect(mockedApi.updateTask).not.toHaveBeenCalled();
  });
});
