import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/testUtils";
import { TaskOutline } from "./TaskOutline";
import { api } from "../lib/api";
import { makeMember, makeTask } from "../test/fixtures";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    completeTask: vi.fn(),
    cancelTask: vi.fn(),
    reopenTask: vi.fn(),
    updateTask: vi.fn(),
    moveTask: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

describe("TaskOutline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1 })]);
    mockedApi.completeTask.mockResolvedValue(makeTask());
  });

  it("fragt bei offenen Teilaufgaben nach, bevor die Elternaufgabe erledigt wird", async () => {
    const child = makeTask({ id: 2, title: "Teilaufgabe offen", status: "actionable" });
    const parent = makeTask({ id: 1, title: "Elternaufgabe", status: "actionable", children: [child] });
    renderWithProviders(<TaskOutline tasks={[parent]} emptyMessage="Nichts da" />);

    await screen.findByText("Elternaufgabe");
    const checkboxes = screen.getAllByRole("button", { name: "Erledigt" });
    await userEvent.click(checkboxes[0] as HTMLElement);

    expect(await screen.findByText("Diese Aufgabe hat offene Teilaufgaben.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Teilaufgaben ebenfalls erledigen" }));

    await waitFor(() =>
      expect(mockedApi.completeTask).toHaveBeenCalledWith(
        1,
        "complete_children",
        undefined,
        1,
      ),
    );
  });

  it("fragt auch bei offenen tieferen Nachkommen unter erledigten Teilaufgaben", async () => {
    const grandchild = makeTask({ id: 3, title: "Enkelaufgabe offen", status: "actionable" });
    const child = makeTask({
      id: 2,
      title: "Teilaufgabe erledigt",
      status: "done",
      children: [grandchild],
    });
    const parent = makeTask({
      id: 1,
      title: "Elternaufgabe",
      status: "actionable",
      children: [child],
    });
    renderWithProviders(<TaskOutline tasks={[parent]} emptyMessage="Nichts da" />);

    await screen.findByText("Elternaufgabe");
    await userEvent.click(screen.getAllByRole("button", { name: "Erledigt" })[0] as HTMLElement);

    expect(await screen.findByText("Diese Aufgabe hat offene Teilaufgaben.")).toBeInTheDocument();
  });

  it("erledigt eine Aufgabe ohne Teilaufgaben sofort", async () => {
    const task = makeTask({ id: 3, title: "Einfache Aufgabe", status: "actionable" });
    renderWithProviders(<TaskOutline tasks={[task]} emptyMessage="Nichts da" />);

    await screen.findByText("Einfache Aufgabe");
    await userEvent.click(screen.getByRole("button", { name: "Erledigt" }));

    await waitFor(() =>
      expect(mockedApi.completeTask).toHaveBeenCalledWith(
        3,
        "leave_open",
        undefined,
        1,
      ),
    );
  });

  it("explains swipe gestures in plain language and can hide the inline hint", async () => {
    const task = makeTask({ id: 7, title: "Wischbare Aufgabe" });
    const { rerender } = renderWithProviders(
      <TaskOutline tasks={[task]} emptyMessage="Nichts da" />,
    );

    expect(
      await screen.findByText(
        "Nach rechts wischen: „Erledigen / Wieder öffnen“. Nach links wischen öffnet weitere Aktionen wie Zuweisen, Planen und Notizen. Am Desktop geht das auch über ⋯.",
      ),
    ).toBeInTheDocument();

    rerender(
      <TaskOutline
        tasks={[task]}
        emptyMessage="Nichts da"
        showSwipeHint={false}
      />,
    );
    expect(screen.queryByText(/Nach rechts wischen:/)).not.toBeInTheDocument();
  });

  it("wiederholt keine Sortierwerkzeuge unter jeder Zeile", async () => {
    const child = makeTask({ id: 5, title: "Teilaufgabe", parentTaskId: 4, position: 0 });
    const task = makeTask({ id: 4, title: "Sortieraufgabe", position: 0, children: [child] });
    const second = makeTask({ id: 6, title: "Zweite Aufgabe", position: 1 });
    renderWithProviders(<TaskOutline tasks={[task, second]} emptyMessage="Nichts da" organizable />);

    await screen.findByText("Sortieraufgabe");

    // Kein globaler Sortiermodus mehr …
    expect(screen.queryByRole("button", { name: "Sortieren" })).toBeNull();
    // … und keine Werkzeugleiste je Zeile, solange nichts ausgewählt ist.
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(screen.queryAllByRole("button", { name: "Nach oben" })).toHaveLength(0);
    expect(screen.queryAllByRole("button", { name: "Teilbaum verschieben" })).toHaveLength(0);

    // Genau ein sichtbarer Ziehgriff pro Zeile.
    expect(screen.getAllByRole("button", { name: /^Verschieben:/ })).toHaveLength(3);
  });

  it("preserves compiled queue order without changing the default outline order", () => {
    const firstByQueue = makeTask({ id: 8, title: "Früh fällig", position: 2 });
    const firstByOutline = makeTask({ id: 9, title: "Erste Position", position: 1 });
    const { rerender } = renderWithProviders(
      <TaskOutline
        tasks={[firstByQueue, firstByOutline]}
        emptyMessage="Nichts da"
        preserveRootOrder
        showSwipeHint={false}
      />,
    );

    expect(
      screen.getAllByRole("listitem").map((item) => item.textContent),
    ).toEqual([
      expect.stringContaining("Früh fällig"),
      expect.stringContaining("Erste Position"),
    ]);

    rerender(
      <TaskOutline
        tasks={[firstByQueue, firstByOutline]}
        emptyMessage="Nichts da"
        showSwipeHint={false}
      />,
    );
    expect(
      screen.getAllByRole("listitem").map((item) => item.textContent),
    ).toEqual([
      expect.stringContaining("Erste Position"),
      expect.stringContaining("Früh fällig"),
    ]);
  });

  describe("compactDescendants (Today)", () => {
    it("keeps the root row full-featured while rendering descendants compactly", async () => {
      const child = makeTask({
        id: 101,
        title: "Nachkomme",
        status: "actionable",
        scheduledDate: "2026-02-01",
      });
      const parent = makeTask({
        id: 100,
        title: "Wurzelaufgabe",
        status: "actionable",
        scheduledDate: "2026-02-01",
        children: [child],
      });
      renderWithProviders(
        <TaskOutline
          tasks={[parent]}
          emptyMessage="Nichts da"
          compactDescendants
        />,
      );

      await screen.findByText("Wurzelaufgabe");
      await screen.findByText("Nachkomme");

      // The root row keeps its full metadata stack (e.g. the scheduled chip)…
      expect(screen.getAllByText(/Geplant:/)).toHaveLength(1);
    });

    it("keeps open descendants visible", async () => {
      const child = makeTask({ id: 111, title: "Offener Nachkomme", status: "actionable" });
      const parent = makeTask({
        id: 110,
        title: "Elternaufgabe",
        status: "actionable",
        children: [child],
      });
      renderWithProviders(
        <TaskOutline tasks={[parent]} emptyMessage="Nichts da" compactDescendants />,
      );

      await screen.findByText("Elternaufgabe");
      expect(await screen.findByText("Offener Nachkomme")).toBeInTheDocument();
    });

    it("collapses done/cancelled descendants into a summary affordance and can reveal them again", async () => {
      const doneChild = makeTask({ id: 121, title: "Erledigter Nachkomme", status: "done" });
      const cancelledChild = makeTask({
        id: 122,
        title: "Abgesagter Nachkomme",
        status: "cancelled",
      });
      const openChild = makeTask({ id: 123, title: "Offener Nachkomme", status: "actionable" });
      const parent = makeTask({
        id: 120,
        title: "Elternaufgabe",
        status: "actionable",
        children: [doneChild, cancelledChild, openChild],
      });
      renderWithProviders(
        <TaskOutline tasks={[parent]} emptyMessage="Nichts da" compactDescendants />,
      );

      await screen.findByText("Elternaufgabe");
      expect(await screen.findByText("Offener Nachkomme")).toBeInTheDocument();
      expect(screen.queryByText("Erledigter Nachkomme")).not.toBeInTheDocument();
      expect(screen.queryByText("Abgesagter Nachkomme")).not.toBeInTheDocument();

      const toggle = screen.getByRole("button", { name: "2 erledigt anzeigen" });
      await userEvent.click(toggle);

      expect(await screen.findByText("Erledigter Nachkomme")).toBeInTheDocument();
      expect(screen.getByText("Abgesagter Nachkomme")).toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: "2 erledigt ausblenden" }));
      expect(screen.queryByText("Erledigter Nachkomme")).not.toBeInTheDocument();
    });

    it("keeps an open descendant reachable even when its parent is terminal", async () => {
      const openGrandchild = makeTask({
        id: 133,
        title: "Offener Enkel",
        status: "actionable",
      });      const doneChild = makeTask({
        id: 132,
        title: "Erledigtes Kind",
        status: "done",
        children: [openGrandchild],
      });
      const parent = makeTask({
        id: 130,
        title: "Elternaufgabe",
        status: "actionable",
        children: [doneChild],
      });
      renderWithProviders(
        <TaskOutline tasks={[parent]} emptyMessage="Nichts da" compactDescendants />,
      );

      await screen.findByText("Elternaufgabe");
      // The path to open work must stay reachable: an ancestor on that path
      // is not hidden merely because it is itself terminal …
      expect(await screen.findByText("Erledigtes Kind")).toBeInTheDocument();
      // … and the open descendant underneath it is visible without extra clicks.
      expect(screen.getByText("Offener Enkel")).toBeInTheDocument();
    });

    it("does not affect the full outline used by Project Detail", async () => {
      const doneChild = makeTask({ id: 141, title: "Erledigter Nachkomme", status: "done" });
      const parent = makeTask({
        id: 140,
        title: "Elternaufgabe",
        status: "actionable",
        children: [doneChild],
      });
      renderWithProviders(<TaskOutline tasks={[parent]} emptyMessage="Nichts da" />);

      await screen.findByText("Elternaufgabe");
      expect(await screen.findByText("Erledigter Nachkomme")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /erledigt anzeigen/ })).not.toBeInTheDocument();
    });

    it("keeps a just-completed descendant visible while it is retained", async () => {
      const child = makeTask({ id: 151, title: "Frisch erledigt", status: "actionable" });
      const parent = makeTask({
        id: 150,
        title: "Elternaufgabe",
        status: "actionable",
        children: [child],
      });
      mockedApi.completeTask.mockResolvedValue(
        makeTask({ ...child, status: "done" }),
      );
      renderWithProviders(
        <TaskOutline tasks={[parent]} emptyMessage="Nichts da" compactDescendants />,
      );

      await screen.findByText("Elternaufgabe");
      await screen.findByText("Frisch erledigt");
      const checkboxes = screen.getAllByRole("button", { name: "Erledigt" });
      await userEvent.click(checkboxes[1] as HTMLElement);

      await waitFor(() => expect(mockedApi.completeTask).toHaveBeenCalled());
      // Retained: the just-completed child keeps showing instead of
      // instantly collapsing behind the "erledigt anzeigen" affordance.
      expect(screen.getByText("Frisch erledigt")).toBeInTheDocument();
    });
  });
});
