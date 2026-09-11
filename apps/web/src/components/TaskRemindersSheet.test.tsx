import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { makeTask } from "../test/fixtures";
import { renderWithProviders } from "../test/testUtils";
import { TaskRemindersSheet } from "./TaskRemindersSheet";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    getTags: vi.fn(),
    updateTask: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

describe("TaskRemindersSheet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.getMembers.mockResolvedValue([]);
    mockedApi.getTags.mockResolvedValue([]);
    mockedApi.updateTask.mockResolvedValue(makeTask() as never);
  });

  it("shows the existing reminders and removes one before saving as a single update", async () => {
    const task = makeTask({
      id: 10,
      title: "Mehrere Erinnerungen",
      revision: 3,
      reminders: [
        { id: 1, kind: "absolute", at: "2026-09-01T19:00:00.000Z" },
        { id: 2, kind: "absolute", at: "2026-09-02T08:00:00.000Z" },
      ],
    });
    const onClose = vi.fn();
    renderWithProviders(<TaskRemindersSheet task={task} onClose={onClose} />);

    const removeButtons = await screen.findAllByRole("button", { name: "Erinnerung entfernen" });
    expect(removeButtons).toHaveLength(2);
    await userEvent.click(removeButtons[0]!);

    await userEvent.click(screen.getByRole("button", { name: "Fertig" }));

    await waitFor(() => expect(mockedApi.updateTask).toHaveBeenCalledTimes(1));
    const [, patch] = mockedApi.updateTask.mock.calls[0]!;
    expect((patch as { reminders: unknown[] }).reminders).toHaveLength(1);
    expect(onClose).toHaveBeenCalled();
  });

  it("adds an absolute quick-preset reminder resolved to a concrete instant", async () => {
    const task = makeTask({ id: 11, title: "Ohne Erinnerung", reminders: [] });
    renderWithProviders(<TaskRemindersSheet task={task} onClose={vi.fn()} />);

    await userEvent.click(await screen.findByRole("button", { name: "Heute Abend" }));

    expect(screen.getByText(/Heute Abend/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Fertig" }));
    await waitFor(() => expect(mockedApi.updateTask).toHaveBeenCalledTimes(1));
    const [, patch] = mockedApi.updateTask.mock.calls[0]!;
    const reminders = (patch as { reminders: Array<{ kind: string }> }).reminders;
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.kind).toBe("absolute");
  });

  it("only offers deadline-relative presets when the task currently has a deadline", async () => {
    const withoutDeadline = makeTask({ id: 12, title: "Ohne Deadline", dueDate: null, reminders: [] });
    renderWithProviders(<TaskRemindersSheet task={withoutDeadline} onClose={vi.fn()} />);
    await screen.findByRole("button", { name: "Heute Abend" });
    expect(screen.queryByRole("button", { name: "Am selben Tag" })).not.toBeInTheDocument();
  });

  it("offers deadline-relative presets once the task has a deadline", async () => {
    const withDeadline = makeTask({ id: 13, title: "Mit Deadline", dueDate: "2026-09-20", reminders: [] });
    renderWithProviders(<TaskRemindersSheet task={withDeadline} onClose={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Am selben Tag" }));

    expect(screen.getByText(/Am selben Tag/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Fertig" }));
    await waitFor(() => expect(mockedApi.updateTask).toHaveBeenCalledTimes(1));
    const [, patch] = mockedApi.updateTask.mock.calls[0]!;
    const reminders = (patch as { reminders: Array<{ kind: string }> }).reminders;
    expect(reminders[0]!.kind).toBe("deadline_relative");
  });

  it("leaves the task untouched when cancelled", async () => {
    const task = makeTask({
      id: 14,
      title: "Abbrechen",
      reminders: [{ id: 1, kind: "absolute", at: "2026-09-01T19:00:00.000Z" }],
    });
    const onClose = vi.fn();
    renderWithProviders(<TaskRemindersSheet task={task} onClose={onClose} />);

    await userEvent.click(await screen.findAllByRole("button", { name: "Erinnerung entfernen" }).then((b) => b[0]!));
    await userEvent.click(screen.getByRole("button", { name: "Abbrechen" }));

    expect(mockedApi.updateTask).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("renders an inactive deadline-relative reminder distinctly when the task currently has no deadline", async () => {
    const task = makeTask({
      id: 15,
      title: "Ohne Deadline mit Erinnerung",
      dueDate: null,
      reminders: [{ id: 1, kind: "deadline_relative", daysBefore: 2, time: "09:00", timezone: "UTC" }],
    });
    renderWithProviders(<TaskRemindersSheet task={task} onClose={vi.fn()} />);
    expect(await screen.findByText(/keine Deadline/)).toBeInTheDocument();
  });

  it("opens straight to the preset choices when the task has no reminders yet", async () => {
    const task = makeTask({ id: 16, title: "Frisch ohne Erinnerung", reminders: [] });
    renderWithProviders(<TaskRemindersSheet task={task} onClose={vi.fn()} />);

    expect(await screen.findByRole("button", { name: "Heute Abend" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "+ Erinnerung" })).not.toBeInTheDocument();
  });

  it("opens to the reminder list, not the preset choices, when the task already has reminders", async () => {
    const task = makeTask({
      id: 17,
      title: "Bereits mit Erinnerung",
      reminders: [{ id: 1, kind: "absolute", at: "2026-09-01T19:00:00.000Z" }],
    });
    renderWithProviders(<TaskRemindersSheet task={task} onClose={vi.fn()} />);

    expect(await screen.findByRole("button", { name: "Erinnerung entfernen" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Heute Abend" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ Erinnerung" })).toBeInTheDocument();
  });
});
