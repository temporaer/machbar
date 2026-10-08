import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WaitingFollowUpSheet } from "./WaitingFollowUpSheet";
import { api } from "../lib/api";
import { makeMember, makeTask } from "../test/fixtures";
import { renderWithProviders } from "../test/testUtils";
import { addIsoCalendarDays } from "../lib/naturalDate";
import {
  calendarDateForInstant,
  householdCalendarDateTimeToRevisitAt,
} from "@machbar/shared";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    followUpExternalWait: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

describe("WaitingFollowUpSheet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1, name: "Mira" })]);
  });

  it("continues waiting with a revisit shortcut, keeping the existing waitingFor", async () => {
    const task = makeTask({
      id: 9,
      notes: "Erste Anfrage.",
      revision: 3,
      externalWait: {
        waitingFor: "Vermieter",
        revisitDate: "2026-09-05",
      },
      scheduledDate: "2026-09-10",
      nextBlockerAttentionDate: "2026-08-31",
      blocked: true,
      executable: false,
    });
    mockedApi.followUpExternalWait.mockResolvedValue({
      ...task,
      revision: 4,
    });
    const onClose = vi.fn();
    renderWithProviders(<WaitingFollowUpSheet task={task} onClose={onClose} />);

    const content = await screen.findByLabelText("Notizen");
    expect(content).toHaveValue("");
    await userEvent.type(content, "Erneut angerufen.");
    await userEvent.click(screen.getByRole("button", { name: "Morgen" }));

    await waitFor(() =>
      expect(mockedApi.followUpExternalWait).toHaveBeenCalledWith(9, {
        action: "continue",
        content: "Erneut angerufen.",
        waitingFor: "Vermieter",
        revisitAt: expect.any(String),
        expectedRevision: 3,
      }),
    );
    expect(mockedApi.followUpExternalWait).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("continues waiting without a note", async () => {
    const task = makeTask({
      id: 13,
      revision: 2,
      externalWait: { waitingFor: "Lieferant", revisitDate: null },
    });
    mockedApi.followUpExternalWait.mockResolvedValue({
      ...task,
      revision: 3,
    });
    renderWithProviders(
      <WaitingFollowUpSheet task={task} onClose={vi.fn()} />,
    );

    expect(
      screen.getByLabelText("Notiz zum Nachhaken (optional)"),
    ).toHaveAttribute("placeholder", "Angerufen, Rückmeldung erhalten …");
    await userEvent.click(screen.getByRole("button", { name: "Morgen" }));

    await waitFor(() =>
      expect(mockedApi.followUpExternalWait).toHaveBeenCalledWith(13, {
        action: "continue",
        waitingFor: "Lieferant",
        revisitAt: householdCalendarDateTimeToRevisitAt(
          addIsoCalendarDays(
            calendarDateForInstant(new Date().toISOString(), "Europe/Berlin")!,
            1,
          ),
          "00:00",
          "Europe/Berlin",
        ),
        expectedRevision: 2,
      }),
    );
  });

  it("preserves the exact revisit instant when a shortcut selects the same local date", async () => {
    const tomorrow = addIsoCalendarDays(
      calendarDateForInstant(new Date().toISOString(), "Europe/Berlin")!,
      1,
    );
    const original = householdCalendarDateTimeToRevisitAt(
      tomorrow,
      "18:00",
      "Europe/Berlin",
    )!;
    const task = makeTask({
      id: 15,
      revision: 1,
      revisitAt: original,
      externalWait: { waitingFor: "Antwort" },
    });
    mockedApi.followUpExternalWait.mockResolvedValue(task);
    renderWithProviders(<WaitingFollowUpSheet task={task} onClose={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "Morgen" }));

    await waitFor(() =>
      expect(mockedApi.followUpExternalWait).toHaveBeenCalledWith(15, {
        action: "continue",
        waitingFor: "Antwort",
        revisitAt: original,
        expectedRevision: 1,
      }),
    );
  });

  it("preserves the household-local clock when a shortcut moves a revisit to another day", async () => {
    const today = calendarDateForInstant(new Date().toISOString(), "Europe/Berlin")!;
    const original = householdCalendarDateTimeToRevisitAt(
      addIsoCalendarDays(today, 1),
      "18:00",
      "Europe/Berlin",
    )!;
    const task = makeTask({
      id: 16,
      revision: 1,
      revisitAt: original,
      externalWait: { waitingFor: "Antwort" },
    });
    mockedApi.followUpExternalWait.mockResolvedValue(task);
    renderWithProviders(<WaitingFollowUpSheet task={task} onClose={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "3 Tage" }));

    await waitFor(() =>
      expect(mockedApi.followUpExternalWait).toHaveBeenCalledWith(16, {
        action: "continue",
        waitingFor: "Antwort",
        revisitAt: householdCalendarDateTimeToRevisitAt(
          addIsoCalendarDays(today, 3),
          "18:00",
          "Europe/Berlin",
        ),
        expectedRevision: 1,
      }),
    );
  });

  it("does not submit an empty custom date or clear the existing revisit", async () => {
    const today = calendarDateForInstant(new Date().toISOString(), "Europe/Berlin")!;
    const original = householdCalendarDateTimeToRevisitAt(
      addIsoCalendarDays(today, 2),
      "18:00",
      "Europe/Berlin",
    )!;
    const task = makeTask({
      id: 18,
      revision: 3,
      revisitAt: original,
      externalWait: { waitingFor: "Antwort" },
    });
    renderWithProviders(<WaitingFollowUpSheet task={task} onClose={vi.fn()} />);

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
    expect(screen.getByRole("button", { name: "Speichern" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));
    expect(mockedApi.followUpExternalWait).not.toHaveBeenCalled();
    expect(task.revisitAt).toBe(original);
  });

  it("saves a valid custom date and preserves the existing household-local clock", async () => {
    const today = calendarDateForInstant(new Date().toISOString(), "Europe/Berlin")!;
    const original = householdCalendarDateTimeToRevisitAt(
      addIsoCalendarDays(today, 2),
      "18:00",
      "Europe/Berlin",
    )!;
    const replacementDate = addIsoCalendarDays(today, 5);
    const task = makeTask({
      id: 19,
      revision: 4,
      revisitAt: original,
      externalWait: { waitingFor: "Antwort" },
    });
    mockedApi.followUpExternalWait.mockResolvedValue(task);
    renderWithProviders(<WaitingFollowUpSheet task={task} onClose={vi.fn()} />);

    await userEvent.click(
      screen.getByRole("button", { name: "Datum auswählen …" }),
    );
    fireEvent.change(
      document.querySelector<HTMLInputElement>('input[type="date"]')!,
      { target: { value: replacementDate } },
    );
    expect(screen.getByRole("button", { name: "Speichern" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));

    await waitFor(() =>
      expect(mockedApi.followUpExternalWait).toHaveBeenCalledWith(19, {
        action: "continue",
        waitingFor: "Antwort",
        revisitAt: householdCalendarDateTimeToRevisitAt(
          replacementDate,
          "18:00",
          "Europe/Berlin",
        ),
        expectedRevision: 4,
      }),
    );
  });

  it.each([
    ["2026-03-28T01:30:00.000Z", "2026-03-29"],
    ["2026-10-24T00:30:00.000Z", "2026-10-25"],
  ])("rejects a DST-invalid follow-up destination %s", async (revisitAt, date) => {
    const task = makeTask({
      id: 17,
      revisitAt,
      externalWait: { waitingFor: "Antwort" },
    });
    const onClose = vi.fn();
    renderWithProviders(<WaitingFollowUpSheet task={task} onClose={onClose} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Datum auswählen …" }),
    );
    fireEvent.change(document.querySelector<HTMLInputElement>('input[type="date"]')!, {
      target: { value: date },
    });
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Diese lokale Uhrzeit ist in der Haushaltszeitzone ungültig oder doppeldeutig.",
    );
    expect(mockedApi.followUpExternalWait).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("resolves the wait via the separate 'Warten beenden' action", async () => {
    const task = makeTask({
      id: 10,
      notes: "Erste Anfrage.",
      revision: 7,
      externalWait: {
        waitingFor: "Vermieter",
        revisitDate: "2026-09-05",
      },
      scheduledDate: "2026-09-05",
    });
    mockedApi.followUpExternalWait.mockResolvedValue({
      ...task,
      revision: 8,
      externalWait: null,
    });
    const onClose = vi.fn();
    renderWithProviders(<WaitingFollowUpSheet task={task} onClose={onClose} />);

    await userEvent.type(
      await screen.findByLabelText("Notizen"),
      "Antwort erhalten.",
    );
    await userEvent.click(screen.getByRole("button", { name: "Warten beenden" }));

    await waitFor(() =>
      expect(mockedApi.followUpExternalWait).toHaveBeenCalledWith(10, {
        action: "resolve",
        content: "Antwort erhalten.",
        expectedRevision: 7,
      }),
    );
    expect(mockedApi.followUpExternalWait).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ends waiting without a note", async () => {
    const task = makeTask({
      id: 14,
      revision: 6,
      scheduledDate: "2026-09-05",
      externalWait: { waitingFor: "Lieferant", revisitDate: "2026-09-05" },
    });
    mockedApi.followUpExternalWait.mockResolvedValue({
      ...task,
      revision: 7,
      externalWait: null,
      revisitAt: null,
    });
    renderWithProviders(
      <WaitingFollowUpSheet task={task} onClose={vi.fn()} />,
    );

    const endButton = screen.getByRole("button", { name: "Warten beenden" });
    expect(endButton).not.toHaveClass("btn-danger");
    await userEvent.click(endButton);

    await waitFor(() =>
      expect(mockedApi.followUpExternalWait).toHaveBeenCalledWith(14, {
        action: "resolve",
        expectedRevision: 6,
      }),
    );
  });

  it("retains the draft and error after a failed atomic save", async () => {
    const task = makeTask({
      id: 11,
      revision: 2,
      externalWait: { waitingFor: "Lieferant", revisitDate: null },
    });
    mockedApi.followUpExternalWait.mockRejectedValue(new Error("Save failed"));
    const onClose = vi.fn();
    renderWithProviders(<WaitingFollowUpSheet task={task} onClose={onClose} />);

    const content = await screen.findByLabelText("Notizen");
    await userEvent.type(content, "Mein Entwurf");
    await userEvent.click(screen.getByRole("button", { name: "Morgen" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Save failed");
    expect(content).toHaveValue("Mein Entwurf");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("blocks close while a follow-up is pending and closes once it resolves", async () => {
    const task = makeTask({
      id: 12,
      revision: 4,
      externalWait: { waitingFor: "Amt", revisitDate: null },
    });
    let resolveRequest!: (task: ReturnType<typeof makeTask>) => void;
    mockedApi.followUpExternalWait.mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );
    const onClose = vi.fn();
    renderWithProviders(<WaitingFollowUpSheet task={task} onClose={onClose} />);

    await userEvent.type(await screen.findByLabelText("Notizen"), "Nachfrage");
    await userEvent.click(screen.getByRole("button", { name: "Morgen" }));
    await waitFor(() =>
      expect(mockedApi.followUpExternalWait).toHaveBeenCalledTimes(1),
    );

    const cancel = screen.getByRole("button", { name: "Abbrechen" });
    expect(cancel).toBeDisabled();

    await userEvent.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();

    resolveRequest({ ...task, revision: 5 });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
