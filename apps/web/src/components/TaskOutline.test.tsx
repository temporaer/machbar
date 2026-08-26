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
    reorderTask: vi.fn(),
    indentTask: vi.fn(),
    outdentTask: vi.fn(),
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
      expect(mockedApi.completeTask).toHaveBeenCalledWith(1, "complete_children"),
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

    await waitFor(() => expect(mockedApi.completeTask).toHaveBeenCalledWith(3, "leave_open"));
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
});
