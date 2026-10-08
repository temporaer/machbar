import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { householdCalendarDateTimeToRevisitAt, calendarDateForInstant } from "@machbar/shared";
import { TaskWaitSheet } from "./TaskWaitSheet";
import { api } from "../lib/api";
import { makeMember, makeTask } from "../test/fixtures";
import { renderWithProviders } from "../test/testUtils";
import { addIsoCalendarDays } from "../lib/naturalDate";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    setExternalWait: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

describe("TaskWaitSheet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1 })]);
  });

  it("preserves a timed revisit when replacing it with the same household date", async () => {
    const tomorrow = addIsoCalendarDays(
      calendarDateForInstant(new Date().toISOString(), "Europe/Berlin")!,
      1,
    );
    const original = householdCalendarDateTimeToRevisitAt(
      tomorrow,
      "18:00",
      "Europe/Berlin",
    )!;
    const task = makeTask({ id: 21, revision: 2, revisitAt: original });
    mockedApi.setExternalWait.mockResolvedValue({
      ...task,
      revision: 3,
      externalWait: { waitingFor: "Lieferant" },
    });
    renderWithProviders(
      <TaskWaitSheet task={task} members={[makeMember({ id: 1 })]} onClose={vi.fn()} />,
    );

    await userEvent.type(screen.getByLabelText("Worauf wartest du?"), "Lieferant");
    await userEvent.click(screen.getByRole("button", { name: "Morgen" }));
    await userEvent.click(screen.getByRole("button", { name: "Warten" }));

    await waitFor(() =>
      expect(mockedApi.setExternalWait).toHaveBeenCalledWith(
        21,
        { waitingFor: "Lieferant", revisitAt: original, expectedRevision: 2 },
      ),
    );
  });

  it("preserves the household-local clock when replacing a timed revisit with another day", async () => {
    const today = calendarDateForInstant(new Date().toISOString(), "Europe/Berlin")!;
    const original = householdCalendarDateTimeToRevisitAt(
      addIsoCalendarDays(today, 1),
      "18:00",
      "Europe/Berlin",
    )!;
    const task = makeTask({ id: 22, revision: 4, revisitAt: original });
    mockedApi.setExternalWait.mockResolvedValue({
      ...task,
      revision: 5,
      externalWait: { waitingFor: "Amt" },
    });
    renderWithProviders(
      <TaskWaitSheet task={task} members={[makeMember({ id: 1 })]} onClose={vi.fn()} />,
    );

    await userEvent.type(screen.getByLabelText("Worauf wartest du?"), "Amt");
    await userEvent.click(screen.getByRole("button", { name: "3 Tage" }));
    await userEvent.click(screen.getByRole("button", { name: "Warten" }));

    await waitFor(() =>
      expect(mockedApi.setExternalWait).toHaveBeenCalledWith(
        22,
        {
          waitingFor: "Amt",
          revisitAt: householdCalendarDateTimeToRevisitAt(
            addIsoCalendarDays(today, 3),
            "18:00",
            "Europe/Berlin",
          ),
          expectedRevision: 4,
        },
      ),
    );
  });

  it("keeps the exact revisit instant when an unrelated change leaves revisit unchanged", async () => {
    const task = makeTask({
      id: 23,
      revision: 1,
      revisitAt: "2026-09-05T16:00:00.000Z",
    });
    mockedApi.setExternalWait.mockResolvedValue({
      ...task,
      revision: 2,
      externalWait: { waitingFor: "Antwort" },
    });
    renderWithProviders(
      <TaskWaitSheet task={task} members={[makeMember({ id: 1 })]} onClose={vi.fn()} />,
    );

    await userEvent.type(screen.getByLabelText("Worauf wartest du?"), "Antwort");
    await userEvent.click(screen.getByRole("button", { name: "Warten" }));

    await waitFor(() =>
      expect(mockedApi.setExternalWait).toHaveBeenCalledWith(23, {
        waitingFor: "Antwort",
        expectedRevision: 1,
      }),
    );
  });

  it("allows explicitly clearing the revisit while starting the wait", async () => {
    const task = makeTask({
      id: 24,
      revision: 3,
      revisitAt: "2026-09-05T16:00:00.000Z",
    });
    mockedApi.setExternalWait.mockResolvedValue({
      ...task,
      revision: 4,
      revisitAt: null,
      externalWait: { waitingFor: "Antwort" },
    });
    renderWithProviders(
      <TaskWaitSheet task={task} members={[makeMember({ id: 1 })]} onClose={vi.fn()} />,
    );

    await userEvent.type(screen.getByLabelText("Worauf wartest du?"), "Antwort");
    await userEvent.click(screen.getByRole("button", { name: "Kein Datum" }));
    await userEvent.click(screen.getByRole("button", { name: "Warten" }));

    await waitFor(() =>
      expect(mockedApi.setExternalWait).toHaveBeenCalledWith(24, {
        waitingFor: "Antwort",
        revisitAt: null,
        expectedRevision: 3,
      }),
    );
  });

  it("does not allow an empty custom replacement to clear an existing revisit", async () => {
    const task = makeTask({
      id: 25,
      revisitAt: "2026-09-05T16:00:00.000Z",
    });
    renderWithProviders(
      <TaskWaitSheet task={task} members={[makeMember({ id: 1 })]} onClose={vi.fn()} />,
    );

    await userEvent.type(screen.getByLabelText("Worauf wartest du?"), "Antwort");
    await userEvent.click(
      screen.getByRole("button", { name: "Datum auswählen …" }),
    );
    await userEvent.clear(
      screen.getByPlaceholderText("z. B. morgen, Freitag, KW 36, 2w"),
    );
    await userEvent.tab();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Bitte ein Wiedervorlagedatum auswählen.",
    );
    expect(screen.getByRole("button", { name: "Warten" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Warten" }));
    expect(mockedApi.setExternalWait).not.toHaveBeenCalled();
  });

  it("accepts a valid custom replacement date and preserves the existing clock", async () => {
    const today = calendarDateForInstant(new Date().toISOString(), "Europe/Berlin")!;
    const originalDate = addIsoCalendarDays(today, 1);
    const replacementDate = addIsoCalendarDays(today, 4);
    const original = householdCalendarDateTimeToRevisitAt(
      originalDate,
      "18:00",
      "Europe/Berlin",
    )!;
    const task = makeTask({ id: 26, revision: 2, revisitAt: original });
    mockedApi.setExternalWait.mockResolvedValue({
      ...task,
      revision: 3,
      externalWait: { waitingFor: "Lieferant" },
    });
    renderWithProviders(
      <TaskWaitSheet task={task} members={[makeMember({ id: 1 })]} onClose={vi.fn()} />,
    );

    await userEvent.type(screen.getByLabelText("Worauf wartest du?"), "Lieferant");
    await userEvent.click(
      screen.getByRole("button", { name: "Datum auswählen …" }),
    );
    fireEvent.change(
      document.querySelector<HTMLInputElement>('input[type="date"]')!,
      { target: { value: replacementDate } },
    );

    expect(screen.getByRole("button", { name: "Warten" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Warten" }));
    await waitFor(() =>
      expect(mockedApi.setExternalWait).toHaveBeenCalledWith(26, {
        waitingFor: "Lieferant",
        revisitAt: householdCalendarDateTimeToRevisitAt(
          replacementDate,
          "18:00",
          "Europe/Berlin",
        ),
        expectedRevision: 2,
      }),
    );
  });

  it("recovers from an invalid custom date when a shortcut replaces the draft", async () => {
    const today = calendarDateForInstant(new Date().toISOString(), "Europe/Berlin")!;
    const tomorrow = addIsoCalendarDays(today, 1);
    const original = householdCalendarDateTimeToRevisitAt(
      addIsoCalendarDays(today, 2),
      "18:00",
      "Europe/Berlin",
    )!;
    const task = makeTask({ id: 27, revisitAt: original });
    mockedApi.setExternalWait.mockResolvedValue({
      ...task,
      externalWait: { waitingFor: "Antwort" },
    });
    renderWithProviders(
      <TaskWaitSheet task={task} members={[makeMember({ id: 1 })]} onClose={vi.fn()} />,
    );

    await userEvent.type(screen.getByLabelText("Worauf wartest du?"), "Antwort");
    await userEvent.click(screen.getByRole("button", { name: "Datum auswählen …" }));
    const customDate = screen.getByPlaceholderText(
      "z. B. morgen, Freitag, KW 36, 2w",
    );
    await userEvent.clear(customDate);
    await userEvent.type(customDate, "kein valides Datum");
    await userEvent.tab();
    expect(await screen.findByText("Datum nicht erkannt")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Warten" })).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "Morgen" }));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Warten" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Warten" }));
    await waitFor(() =>
      expect(mockedApi.setExternalWait).toHaveBeenCalledWith(27, {
        waitingFor: "Antwort",
        revisitAt: householdCalendarDateTimeToRevisitAt(
          tomorrow,
          "18:00",
          "Europe/Berlin",
        ),
        expectedRevision: 1,
      }),
    );
  });

  it("allows explicit clearing after an invalid custom date", async () => {
    const task = makeTask({
      id: 28,
      revisitAt: "2026-09-05T16:00:00.000Z",
    });
    mockedApi.setExternalWait.mockResolvedValue({
      ...task,
      revisitAt: null,
      externalWait: { waitingFor: "Antwort" },
    });
    renderWithProviders(
      <TaskWaitSheet task={task} members={[makeMember({ id: 1 })]} onClose={vi.fn()} />,
    );

    await userEvent.type(screen.getByLabelText("Worauf wartest du?"), "Antwort");
    await userEvent.click(screen.getByRole("button", { name: "Datum auswählen …" }));
    const customDate = screen.getByPlaceholderText(
      "z. B. morgen, Freitag, KW 36, 2w",
    );
    await userEvent.clear(customDate);
    await userEvent.type(
      customDate,
      "kein valides Datum",
    );
    await userEvent.tab();
    expect(await screen.findByText("Datum nicht erkannt")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Kein Datum" }));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Warten" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Warten" }));
    await waitFor(() =>
      expect(mockedApi.setExternalWait).toHaveBeenCalledWith(28, {
        waitingFor: "Antwort",
        revisitAt: null,
        expectedRevision: 1,
      }),
    );
  });
});
