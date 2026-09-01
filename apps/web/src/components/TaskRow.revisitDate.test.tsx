import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { makeMember, makeTask } from "../test/fixtures";
import { renderWithProviders } from "../test/testUtils";
import { TaskOutline } from "./TaskOutline";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    completeTask: vi.fn(),
    cancelTask: vi.fn(),
    reopenTask: vi.fn(),
    updateTask: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

describe("TaskRow Wiedervorlage date", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 25, 12));
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1 })]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("shows the wait revisit relatively only when the outline requests it", async () => {
    const task = makeTask({
      title: "Lieferung erneut prüfen",
      scheduledDate: "2026-09-02",
      externalWait: {
        waitingFor: "Lieferung",
        revisitDate: "2026-08-22",
      },
      nextBlockerAttentionDate: "2026-08-22",
      blocked: true,
      executable: false,
    });
    const { rerender } = renderWithProviders(
      <TaskOutline tasks={[task]} emptyMessage="Nichts da" />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByText(/^Wiedervorlage:/)).not.toBeInTheDocument();

    rerender(
      <TaskOutline tasks={[task]} emptyMessage="Nichts da" showRevisitDate />,
    );

    const prompt = screen.getByLabelText(
      "Wiedervorlage: seit 3 Tagen (22.08.2026)",
    );
    expect(prompt).toHaveTextContent("Wiedervorlage: seit 3 Tagen");
    expect(prompt).toHaveAttribute("title", "Wiedervorlage: 22.08.2026");
  });

  it("keeps task due and inherited project deadline rendering alongside the revisit", async () => {
    renderWithProviders(
      <TaskOutline
        tasks={[
          makeTask({
            title: "Abhängigkeit nachhalten",
            scheduledDate: "2026-09-05",
            externalWait: {
              waitingFor: "Antwort",
              revisitDate: "2026-08-25",
            },
            nextBlockerAttentionDate: "2026-08-25",
            blocked: true,
            executable: false,
            dueDate: "2026-08-24",
            projectDueDate: "2026-08-28",
          }),
        ]}
        emptyMessage="Nichts da"
        showRevisitDate
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText("Fällig: 24.08.2026")).toBeInTheDocument();
    expect(screen.getByText("Wiedervorlage: heute")).toBeInTheDocument();
    expect(screen.getByText("Projekt fällig: in 3 Tagen")).toBeInTheDocument();
  });
});
