import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import { api } from "../lib/api";
import { renderWithProviders } from "../test/testUtils";
import { makeMember, makeTask } from "../test/fixtures";
import { TaskOutline } from "./TaskOutline";

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
  },
}));

const mockedApi = vi.mocked(api, true);

describe("TaskRow project deadline hint", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 25, 12));
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1 })]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("shows a compact relative hint while preserving the exact date accessibly", async () => {
    renderWithProviders(
      <TaskOutline
        tasks={[
          makeTask({
            title: "Einladungen versenden",
            projectDueDate: "2026-08-28",
          }),
        ]}
        emptyMessage="Nichts da"
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText("Einladungen versenden")).toBeInTheDocument();
    const hint = screen.getByLabelText("Projekt fällig: in 3 Tagen (28.08.2026)");
    expect(hint).toHaveTextContent("Projekt fällig: in 3 Tagen");
    expect(hint).toHaveAttribute("title", "Projekt fällig: 28.08.2026");
  });

  it("does not render a project hint without an inherited project deadline", async () => {
    renderWithProviders(
      <TaskOutline tasks={[makeTask({ title: "Freie Aufgabe" })]} emptyMessage="Nichts da" />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText("Freie Aufgabe")).toBeInTheDocument();
    expect(screen.queryByText(/^Projekt fällig:/)).not.toBeInTheDocument();
  });
});
