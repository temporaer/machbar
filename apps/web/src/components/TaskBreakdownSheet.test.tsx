import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { Routes, Route } from "react-router-dom";
import { api } from "../lib/api";
import { renderWithProviders } from "../test/testUtils";
import { makeTask } from "../test/fixtures";
import { TaskBreakdownSheet } from "./TaskBreakdownSheet";

vi.mock("../lib/api", () => ({
  api: {
    getAuthStatus: vi.fn().mockResolvedValue({ enabled: false, authenticated: false, member: null }),
    getMembers: vi.fn().mockResolvedValue([]),
    startTaskBreakdown: vi.fn(),
  },
}));

describe("TaskBreakdownSheet", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it("starts a proposal and navigates to review without creating tasks", async () => {
    vi.mocked(api.startTaskBreakdown).mockResolvedValue({ id: "proposal" });
    const close = vi.fn();
    const task = makeTask({ id: 7, revision: 3 });
    renderWithProviders(
      <Routes>
        <Route path="/" element={<TaskBreakdownSheet task={task} onClose={close} />} />
        <Route path="/intake/:id" element={<p>Review proposal</p>} />
      </Routes>, { locale: "en" },
    );
    const generate = screen.getByRole("button", { name: "Prepare proposal" });
    expect(generate).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: "Make 20-minute steps" } });
    fireEvent.click(generate);
    expect(await screen.findByText("Review proposal")).toBeInTheDocument();
    expect(api.startTaskBreakdown).toHaveBeenCalledWith(7, {
      expectedRevision: 3, instruction: "Make 20-minute steps",
    });
    expect(close).toHaveBeenCalledOnce();
  });
  it("starts a default proposal without free-text instructions", async () => {
    vi.mocked(api.startTaskBreakdown).mockResolvedValue({ id: "default" });
    renderWithProviders(
      <Routes>
        <Route path="/" element={<TaskBreakdownSheet task={makeTask({ id: 7 })} onClose={vi.fn()} />} />
        <Route path="/intake/:id" element={<p>Default proposal</p>} />
      </Routes>, { locale: "en" },
    );
    fireEvent.click(screen.getByRole("button", { name: "Prepare proposal" }));
    expect(await screen.findByText("Default proposal")).toBeInTheDocument();
    expect(api.startTaskBreakdown).toHaveBeenCalledWith(7, { expectedRevision: 1 });
  });
  it("keeps instructions after failure and Cancel creates nothing", async () => {
    vi.mocked(api.startTaskBreakdown).mockRejectedValue(new Error("Bridge offline"));
    const close = vi.fn();
    renderWithProviders(<TaskBreakdownSheet task={makeTask()} onClose={close} />, { locale: "en" });
    fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: "Keep these small" } });
    fireEvent.click(screen.getByRole("button", { name: "Prepare proposal" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Bridge offline"));
    expect(screen.getByLabelText("Instructions")).toHaveValue("Keep these small");
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(close).toHaveBeenCalledOnce();
    expect(api.startTaskBreakdown).toHaveBeenCalledTimes(1);
  });
});
