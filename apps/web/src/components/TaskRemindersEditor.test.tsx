import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { TaskReminderInput } from "@machbar/shared";
import { renderWithProviders } from "../test/testUtils";
import { TaskRemindersEditor } from "./TaskRemindersEditor";

vi.mock("../lib/api", () => ({
  api: { getMembers: vi.fn().mockResolvedValue([]), getTags: vi.fn().mockResolvedValue([]) },
}));

describe("TaskRemindersEditor", () => {
  it("keeps reminder edits as a draft for the planning workflow", async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <TaskRemindersEditor
        reminders={[
          { id: 1, kind: "absolute", at: "2026-09-01T19:00:00.000Z" },
          { id: 2, kind: "absolute", at: "2026-09-02T08:00:00.000Z" },
        ]}
        dueDate={null}
        onChange={onChange}
      />,
    );

    await userEvent.click((await screen.findAllByRole("button", { name: "Erinnerung entfernen" }))[0]!);
    expect(onChange).toHaveBeenLastCalledWith([
      { id: 2, kind: "absolute", at: "2026-09-02T08:00:00.000Z" },
    ]);
  });

  it("opens directly to reminder choices and creates an absolute preset draft", async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <TaskRemindersEditor reminders={[]} dueDate={null} onChange={onChange} autoOpen />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Morgen früh" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    const reminders = onChange.mock.calls[0]![0] as TaskReminderInput[];
    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toMatchObject({ kind: "absolute", at: expect.any(String) });
    expect(screen.getByRole("button", { name: "+ Erinnerung" })).toBeInTheDocument();
  });

  it("only offers deadline-relative reminders when the planning draft has a deadline", async () => {
    const onChange = vi.fn();
    const { rerender } = renderWithProviders(
      <TaskRemindersEditor reminders={[]} dueDate={null} onChange={onChange} autoOpen />,
    );
    await screen.findByRole("button", { name: "Morgen früh" });
    expect(screen.queryByRole("button", { name: "Am selben Tag" })).not.toBeInTheDocument();

    rerender(
      <TaskRemindersEditor reminders={[]} dueDate="2026-09-20" onChange={onChange} autoOpen />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Am selben Tag" }));
    expect(onChange).toHaveBeenLastCalledWith([
      { kind: "deadline_relative", daysBefore: 0, time: "08:00", timezone: expect.any(String) },
    ]);
  });
});
