import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
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
});
