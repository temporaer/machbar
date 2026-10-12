import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { api } from "../lib/api";
import { renderWithProviders } from "../test/testUtils";
import { makeTask } from "../test/fixtures";
import { WorkClarificationSheet } from "./WorkClarificationSheet";

vi.mock("../lib/api", () => ({
  api: {
    getAuthStatus: vi.fn().mockResolvedValue({ enabled: false, authenticated: false, member: null }),
    startTaskBreakdown: vi.fn(),
    startWorkRefinement: vi.fn(),
  },
}));

describe("WorkClarificationSheet", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("starts the smaller-steps intent without requiring instructions", async () => {
    vi.mocked(api.startTaskBreakdown).mockResolvedValue({ id: "proposal" });
    const close = vi.fn();
    const task = makeTask({ id: 7, revision: 3 });
    renderWithProviders(
      <Routes>
        <Route path="/" element={<WorkClarificationSheet targetType="task" targetId={task.id} revision={task.revision} title={task.title} task={task} onClose={close} />} />
        <Route path="/intake/:id" element={<p>Review proposal</p>} />
      </Routes>, { locale: "en" },
    );

    fireEvent.change(screen.getByLabelText("What should AI help with?"), { target: { value: "smaller_steps" } });
    fireEvent.click(screen.getByRole("button", { name: "Prepare proposal" }));

    expect(await screen.findByText("Review proposal")).toBeInTheDocument();
    expect(api.startTaskBreakdown).toHaveBeenCalledWith(7, { expectedRevision: 3 });
    expect(api.startWorkRefinement).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("retains optional focus after a failed request so the same intent can be retried", async () => {
    vi.mocked(api.startTaskBreakdown)
      .mockRejectedValueOnce(new Error("Bridge offline"))
      .mockResolvedValueOnce({ id: "retry" });
    const close = vi.fn();
    const task = makeTask({ id: 8, revision: 5 });
    renderWithProviders(
      <Routes>
        <Route path="/" element={<WorkClarificationSheet targetType="task" targetId={task.id} revision={task.revision} title={task.title} task={task} onClose={close} />} />
        <Route path="/intake/:id" element={<p>Review retry</p>} />
      </Routes>, { locale: "en" },
    );

    fireEvent.change(screen.getByLabelText("What should AI help with?"), { target: { value: "smaller_steps" } });
    fireEvent.change(screen.getByLabelText("Additional focus (optional)"), { target: { value: "Preparation only" } });
    fireEvent.click(screen.getByRole("button", { name: "Prepare proposal" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Bridge offline"));
    expect(screen.getByLabelText("Additional focus (optional)")).toHaveValue("Preparation only");
    expect(screen.getByLabelText("What should AI help with?")).toHaveValue("smaller_steps");
    expect(close).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Prepare proposal" }));
    expect(await screen.findByText("Review retry")).toBeInTheDocument();
    expect(api.startTaskBreakdown).toHaveBeenNthCalledWith(2, 8, {
      expectedRevision: 5,
      instruction: "Preparation only",
    });
  });
});
