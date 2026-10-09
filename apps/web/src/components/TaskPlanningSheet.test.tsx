import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskPlanningSheet } from "./TaskPlanningSheet";
import { api } from "../lib/api";
import { makeMember, makeTask } from "../test/fixtures";
import { renderWithProviders } from "../test/testUtils";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    updateTask: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);
const originalScrollIntoView = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollIntoView",
);

describe("TaskPlanningSheet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1, name: "Mira" })]);
  });

  afterEach(() => {
    if (originalScrollIntoView) {
      Object.defineProperty(
        HTMLElement.prototype,
        "scrollIntoView",
        originalScrollIntoView,
      );
    } else {
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it("shows the four cards in a fixed order without an active target", () => {
    const task = makeTask();
    renderWithProviders(<TaskPlanningSheet task={task} onClose={vi.fn()} />);
    const cards = Array.from(document.querySelectorAll(".task-planning-card"));
    expect(cards.map((card) => card.querySelector("h3")?.textContent)).toEqual([
      "Geplant für",
      "Wartet auf",
      "Wiedervorlage",
      "Fällig bis",
    ]);
    expect(cards.every((card) => !card.classList.contains("task-planning-card-active"))).toBe(
      true,
    );
  });

  it("adds waiting locally and commits it with the planning fields", async () => {
    const task = makeTask({ revision: 4 });
    mockedApi.updateTask.mockResolvedValue({
      ...task,
      revision: 5,
      externalWait: { waitingFor: "Werkstatt", revisitDate: null },
    });
    const onClose = vi.fn();
    renderWithProviders(<TaskPlanningSheet task={task} onClose={onClose} />);

    await userEvent.click(screen.getByRole("button", { name: "+ Warten hinzufügen" }));
    const waiting = screen
      .getAllByText("Wartet auf")[0]!
      .closest<HTMLElement>(".task-planning-card")!;
    const input = within(waiting).getByRole("textbox");
    await userEvent.type(input, "Werkstatt");
    expect(mockedApi.updateTask).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith( task.id, expect.objectContaining({
        externalWait: { waitingFor: "Werkstatt" },
        expectedRevision: task.revision,
      })),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not save an empty newly added wait", async () => {
    const task = makeTask();
    renderWithProviders(<TaskPlanningSheet task={task} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "+ Warten hinzufügen" }));
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Bitte gib an, worauf die Aufgabe wartet.",
    );
    expect(mockedApi.updateTask).not.toHaveBeenCalled();
  });

  it("ends an existing wait locally and can undo before saving", async () => {
    const task = makeTask({
      externalWait: { waitingFor: "Amt", revisitDate: null },
    });
    renderWithProviders(<TaskPlanningSheet task={task} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Warten beenden" }));
    expect(screen.getByText("Warten wird beendet")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Rückgängig" }));
    expect(screen.getByDisplayValue("Amt")).toBeInTheDocument();
    expect(mockedApi.updateTask).not.toHaveBeenCalled();
  });

  it("opens and scrolls to a targeted waiting card without focusing its input", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    const task = makeTask();
    renderWithProviders(
      <TaskPlanningSheet task={task} onClose={vi.fn()} initialTarget="waiting" />,
    );
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", behavior: "auto" });
    expect(document.activeElement).not.toBe(
      screen.getByRole("textbox", { name: "Wartet auf" }),
    );
  });

  it("resets the sheet when changing from a targeted entry to neutral planning", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    const task = makeTask();
    const view = renderWithProviders(
      <TaskPlanningSheet task={task} onClose={vi.fn()} initialTarget="waiting" />,
    );
    const sheet = document.querySelector<HTMLElement>(".sheet")!;
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    sheet.scrollTop = 240;

    view.rerender(<TaskPlanningSheet task={task} onClose={vi.fn()} />);

    await waitFor(() => expect(sheet.scrollTop).toBe(0));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("keeps a manually changed neutral scroll position across ordinary rerenders", async () => {
    const task = makeTask();
    const view = renderWithProviders(
      <TaskPlanningSheet task={task} onClose={vi.fn()} />,
    );
    const sheet = document.querySelector<HTMLElement>(".sheet")!;
    sheet.scrollTop = 180;

    view.rerender(<TaskPlanningSheet task={task} onClose={vi.fn()} />);

    expect(sheet.scrollTop).toBe(180);
  });
});
