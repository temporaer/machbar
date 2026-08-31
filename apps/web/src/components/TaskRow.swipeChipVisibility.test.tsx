import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/testUtils";
import { TaskOutline } from "./TaskOutline";
import { TaskDetailSheet } from "./TaskDetailSheet";
import { api } from "../lib/api";
import { makeMember, makeTag, makeTask } from "../test/fixtures";
// Real stylesheet, not a mock — vitest's `css: true` lets jsdom actually
// cascade these rules, so `getComputedStyle` below reflects the real fix
// (grid placement / z-index / opacity), not just DOM presence.
import "../styles/index.css";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    getTags: vi.fn(),
    getTask: vi.fn(),
    completeTask: vi.fn(),
    cancelTask: vi.fn(),
    reopenTask: vi.fn(),
    updateTask: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

/** Drags horizontally without releasing, so mid-drag visual state can be inspected. */
function dragTo(content: HTMLElement, deltaX: number) {
  fireEvent.pointerDown(content, { clientX: 0, pointerId: 1 });
  fireEvent.pointerMove(content, { clientX: deltaX, pointerId: 1 });
}

/** Simulates a full horizontal drag past the swipe threshold and releases it. */
function swipe(container: HTMLElement, deltaX: number) {
  const content = container.querySelector(".task-row-content") as HTMLElement;
  dragTo(content, deltaX);
  fireEvent.pointerUp(content, { clientX: deltaX, pointerId: 1 });
}

describe("TaskRow – left-swipe reveals a visible, interactable chip strip (regression for the red-rectangle-hides-chips bug)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1 })]);
    mockedApi.getTags.mockResolvedValue([makeTag({ id: 20 })]);
  });

  it("keeps the chip strip structurally outside the swipe background/content cell, so `.task-row` overflow can never clip it", async () => {
    const task = makeTask({ id: 1, title: "Rechnung prüfen", status: "actionable" });
    const { container } = renderWithProviders(<TaskOutline tasks={[task]} emptyMessage="Nichts da" />);
    await screen.findByText("Rechnung prüfen");

    swipe(container, -100);

    const row = container.querySelector(".task-row") as HTMLElement;
    const chips = container.querySelector(".task-row-chips") as HTMLElement;
    const content = container.querySelector(".task-row-content") as HTMLElement;
    expect(chips).toBeInTheDocument();
    // Chips are a direct child of the row, never nested inside the
    // swipe-background/content stack — this is what keeps them from being
    // painted over by the absolutely-stretched backgrounds.
    expect(chips.parentElement).toBe(row);
    expect(content.contains(chips)).toBe(false);

    // The swipe cell (backgrounds + content) occupies grid row 1; the chip
    // strip auto-flows into a separate row below it, so it can never share
    // the same box the backgrounds paint into.
    const cancelBg = container.querySelector(".task-row-swipe-bg.cancel") as HTMLElement;
    expect(getComputedStyle(content).gridRow).toBe("1");
    expect(getComputedStyle(cancelBg).gridRow).toBe("1");
    expect(getComputedStyle(chips).gridRow).not.toBe("1");
  });

  it("makes the red 'Weitere Aktionen' background actually visible (opacity) once a left-swipe completes, and keeps the row from turning solid red beyond the row's own height", async () => {
    const task = makeTask({ id: 2, title: "Angebot pflegen", status: "actionable" });
    const { container } = renderWithProviders(<TaskOutline tasks={[task]} emptyMessage="Nichts da" />);
    await screen.findByText("Angebot pflegen");

    const completeBg = container.querySelector(".task-row-swipe-bg.complete") as HTMLElement;
    const cancelBg = container.querySelector(".task-row-swipe-bg.cancel") as HTMLElement;

    // At rest, neither background is shown.
    expect(getComputedStyle(cancelBg).opacity).toBe("0");
    expect(getComputedStyle(completeBg).opacity).toBe("0");

    swipe(container, -100);

    // After the completed left-swipe, only the cancel/"more actions"
    // background is visible — the complete/success one must stay hidden.
    expect(getComputedStyle(cancelBg).opacity).toBe("1");
    expect(getComputedStyle(completeBg).opacity).toBe("0");

    // And the chip strip itself (a separate grid row, not the swipe cell)
    // must never adopt the danger/cancel background class used for the row.
    const chips = container.querySelector(".task-row-chips") as HTMLElement;
    expect(chips.className).not.toContain("task-row-swipe-bg");
    expect(chips.className).not.toContain("cancel");
  });

  it("shows only the matching background while dragging right (never red), and only the matching one while dragging left", async () => {
    const task = makeTask({ id: 3, title: "Team-Update senden", status: "actionable" });
    const { container } = renderWithProviders(<TaskOutline tasks={[task]} emptyMessage="Nichts da" />);
    await screen.findByText("Team-Update senden");
    const content = container.querySelector(".task-row-content") as HTMLElement;
    const completeBg = container.querySelector(".task-row-swipe-bg.complete") as HTMLElement;
    const cancelBg = container.querySelector(".task-row-swipe-bg.cancel") as HTMLElement;

    // Stay within a single drag session (no pointerUp in between) so no
    // primary-swipe action actually fires — this test is only about which
    // background is shown while live-dragging in each direction.
    dragTo(content, 100);
    expect(getComputedStyle(completeBg).opacity).toBe("1");
    expect(getComputedStyle(cancelBg).opacity).toBe("0");

    fireEvent.pointerMove(content, { clientX: -100, pointerId: 1 });
    expect(getComputedStyle(cancelBg).opacity).toBe("1");
    expect(getComputedStyle(completeBg).opacity).toBe("0");

    fireEvent.pointerCancel(content);
    expect(getComputedStyle(cancelBg).opacity).toBe("0");
    expect(getComputedStyle(completeBg).opacity).toBe("0");
  });

  it("resets the drag transform back to no offset while keeping the chip strip open after releasing a completed left-swipe", async () => {
    const task = makeTask({ id: 4, title: "Notizen aktualisieren", status: "actionable" });
    const { container } = renderWithProviders(<TaskOutline tasks={[task]} emptyMessage="Nichts da" />);
    await screen.findByText("Notizen aktualisieren");

    swipe(container, -100);

    const content = container.querySelector(".task-row-content") as HTMLElement;
    // Drag resets — no lingering translateX — yet the chips are still there.
    expect(content.style.transform).toBe("");
    expect(screen.getByRole("group", { name: "Weitere Aktionen" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Zuweisen" })).toBeInTheDocument();
  });

  it("keeps every action chip enabled and directly clickable once revealed by a left-swipe", async () => {
    const task = makeTask({ id: 5, title: "Vertrag unterschreiben", status: "actionable" });
    mockedApi.getTask.mockResolvedValue(task);
    renderWithProviders(
      <div>
        <TaskOutline tasks={[task]} emptyMessage="Nichts da" />
        <TaskDetailSheet />
      </div>,
    );
    const row = (await screen.findByText("Vertrag unterschreiben")).closest(".task-row") as HTMLElement;

    swipe(row, -100);

    const chipButtons = ["Zuweisen", "Planen", "Notizen", "Mehr"].map((name) =>
      screen.getByRole("button", { name }),
    );
    for (const btn of chipButtons) {
      expect(btn).toBeEnabled();
      expect(btn).not.toHaveAttribute("aria-hidden");
    }

    // Actually interactable via a real pointer/click sequence, not just present in the DOM.
    await userEvent.click(screen.getByRole("button", { name: "Notizen" }));
    expect(await screen.findByLabelText("Notizen")).toBeInTheDocument();
  });

  it("closes the chip strip predictably when a chip is used, hiding the persisted red background again", async () => {
    const task = makeTask({ id: 6, title: "Rückruf einplanen", status: "actionable" });
    mockedApi.updateTask.mockResolvedValue(makeTask());
    const { container } = renderWithProviders(<TaskOutline tasks={[task]} emptyMessage="Nichts da" />);
    await screen.findByText("Rückruf einplanen");

    swipe(container, -100);
    expect(screen.getByRole("button", { name: "Notizen" })).toBeInTheDocument();
    const cancelBg = container.querySelector(".task-row-swipe-bg.cancel") as HTMLElement;
    expect(getComputedStyle(cancelBg).opacity).toBe("1");

    await userEvent.click(screen.getByRole("button", { name: "Notizen" }));
    expect(screen.queryByRole("group", { name: "Weitere Aktionen" })).not.toBeInTheDocument();
    expect(getComputedStyle(cancelBg).opacity).toBe("0");
  });

  it("closes the chip strip predictably when the kebab button is toggled again", async () => {
    const task = makeTask({ id: 7, title: "Angebot archivieren", status: "actionable" });
    const { container } = renderWithProviders(<TaskOutline tasks={[task]} emptyMessage="Nichts da" />);
    await screen.findByText("Angebot archivieren");

    swipe(container, -100);
    expect(screen.getByRole("group", { name: "Weitere Aktionen" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Weitere Aktionen" }));

    expect(screen.queryByRole("group", { name: "Weitere Aktionen" })).not.toBeInTheDocument();
    const cancelBg = container.querySelector(".task-row-swipe-bg.cancel") as HTMLElement;
    expect(getComputedStyle(cancelBg).opacity).toBe("0");
  });

  it("offers an explicit keyboard-accessible close action that resets the reveal without acting", async () => {
    const task = makeTask({ id: 10, title: "Aktionen verwerfen", status: "actionable" });
    const { container } = renderWithProviders(<TaskOutline tasks={[task]} emptyMessage="Nichts da" />);
    await screen.findByText("Aktionen verwerfen");

    swipe(container, -100);
    const kebab = screen.getByRole("button", { name: "Weitere Aktionen" });
    const close = screen.getByRole("button", { name: "Schließen" });
    close.focus();

    await userEvent.keyboard("{Enter}");

    expect(screen.queryByRole("group", { name: "Weitere Aktionen" })).not.toBeInTheDocument();
    expect(kebab).toHaveFocus();
    expect(kebab).toHaveAttribute("aria-expanded", "false");
    expect(getComputedStyle(container.querySelector(".task-row-swipe-bg.cancel") as HTMLElement).opacity).toBe("0");
    expect(mockedApi.completeTask).not.toHaveBeenCalled();
    expect(mockedApi.cancelTask).not.toHaveBeenCalled();
    expect(mockedApi.updateTask).not.toHaveBeenCalled();
  });

  it("returns focus to the visible task control when the mobile layout hides the kebab", async () => {
    const task = makeTask({ id: 11, title: "Mobile Aktionen schließen", status: "actionable" });
    const { container } = renderWithProviders(<TaskOutline tasks={[task]} emptyMessage="Nichts da" />);
    await screen.findByText("Mobile Aktionen schließen");

    swipe(container, -100);
    const kebab = screen.getByRole("button", { name: "Weitere Aktionen" });
    kebab.style.display = "none";
    const close = screen.getByRole("button", { name: "Schließen" });
    close.focus();

    await userEvent.keyboard("{Enter}");

    expect(screen.getByRole("button", { name: "Mobile Aktionen schließen" })).toHaveFocus();
  });

  it("does not leak a visible red background onto sibling rows that were not swiped", async () => {
    const taskA = makeTask({ id: 8, title: "Aufgabe A", status: "actionable" });
    const taskB = makeTask({ id: 9, title: "Aufgabe B", status: "actionable" });
    const { container } = renderWithProviders(<TaskOutline tasks={[taskA, taskB]} emptyMessage="Nichts da" />);
    await screen.findByText("Aufgabe A");

    const rowA = screen.getByText("Aufgabe A").closest(".task-row") as HTMLElement;
    swipe(rowA, -100);

    const rows = container.querySelectorAll(".task-row");
    const cancelBgs = Array.from(rows).map((row) => row.querySelector(".task-row-swipe-bg.cancel") as HTMLElement);
    expect(getComputedStyle(cancelBgs[0]!).opacity).toBe("1");
    expect(getComputedStyle(cancelBgs[1]!).opacity).toBe("0");
  });
});
