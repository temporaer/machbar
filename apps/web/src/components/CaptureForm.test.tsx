import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CaptureForm } from "./CaptureForm";
import { api } from "../lib/api";
import { makeProject, makeTask } from "../test/fixtures";

vi.mock("../lib/api", () => ({
  api: {
    createTask: vi.fn(),
    createProject: vi.fn(),
  },
}));

vi.mock("../lib/identity", () => ({
  useIdentity: () => ({ currentMemberId: 1 }),
}));

const mockedApi = vi.mocked(api, true);

describe("CaptureForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.createTask.mockResolvedValue(makeTask());
    mockedApi.createProject.mockResolvedValue(makeProject());
  });

  it("keeps the ordinary Capture deadline hidden and null", async () => {
    render(
      <CaptureForm
        initialTitle="Milch kaufen"
        onCancel={vi.fn()}
        onCaptured={vi.fn()}
      />,
    );

    expect(screen.queryByLabelText("Fällig")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Machbar" }));

    await waitFor(() =>
      expect(mockedApi.createTask).toHaveBeenCalledWith(
        expect.objectContaining({ dueDate: null }),
      ),
    );
  });

  it("submits an initial deadline for a new Task", async () => {
    render(
      <CaptureForm
        initialTitle="Elternabend"
        initialDueDate="2026-09-15"
        showDueDate
        onCancel={vi.fn()}
        onCaptured={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Fällig")).toHaveValue("15.09.2026");
    await userEvent.click(screen.getByRole("button", { name: "Machbar" }));

    await waitFor(() =>
      expect(mockedApi.createTask).toHaveBeenCalledWith(
        expect.objectContaining({ dueDate: "2026-09-15" }),
      ),
    );
  });

  it("submits an initial deadline for a new Project", async () => {
    render(
      <CaptureForm
        initialTitle="Sommerfest"
        initialDueDate="2026-09-15"
        showDueDate
        onCancel={vi.fn()}
        onCaptured={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Projekt" }));

    await waitFor(() =>
      expect(mockedApi.createProject).toHaveBeenCalledWith(
        expect.objectContaining({ dueDate: "2026-09-15" }),
      ),
    );
  });

  it("allows clearing an inferred deadline before capture", async () => {
    render(
      <CaptureForm
        initialTitle="Sommerfest"
        initialDueDate="2026-09-15"
        showDueDate
        onCancel={vi.fn()}
        onCaptured={vi.fn()}
      />,
    );

    const dueDate = screen.getByLabelText("Fällig");
    await userEvent.clear(dueDate);
    await userEvent.tab();
    await userEvent.click(screen.getByRole("button", { name: "Projekt" }));

    await waitFor(() =>
      expect(mockedApi.createProject).toHaveBeenCalledWith(
        expect.objectContaining({ dueDate: null }),
      ),
    );
  });
});
