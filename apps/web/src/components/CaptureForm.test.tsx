import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CaptureForm } from "./CaptureForm";
import { api } from "../lib/api";
import { makeTask } from "../test/fixtures";

vi.mock("../lib/api", () => ({
  api: {
    createTask: vi.fn(),
    getTags: vi.fn(),
    getProjects: vi.fn(),
    getHomeAssistantStatus: vi.fn(),
  },
}));

vi.mock("../lib/identity", () => ({
  useIdentity: () => ({ currentMemberId: 1, members: [{ id: 1, name: "Mira" }] }),
}));

vi.mock("../lib/useAsync", () => ({
  useAsync: () => ({ data: [] }),
}));

const mockedApi = vi.mocked(api, true);

describe("CaptureForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.createTask.mockResolvedValue(makeTask());
    mockedApi.getTags.mockResolvedValue([]);
    mockedApi.getProjects.mockResolvedValue([]);
    mockedApi.getHomeAssistantStatus.mockResolvedValue({
      connected: false,
      instanceId: null,
      protocolVersion: null,
      connectedAt: null,
      lastUpdateAt: null,
      stale: false,
      people: [],
      contexts: [],
    });
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
    await userEvent.click(screen.getByRole("button", { name: "Erstellen" }));

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
    await userEvent.click(screen.getByRole("button", { name: "Erstellen" }));

    await waitFor(() =>
      expect(mockedApi.createTask).toHaveBeenCalledWith(
        expect.objectContaining({ dueDate: "2026-09-15" }),
      ),
    );
  });

  it("creates project-scoped tasks as actionable without a defer option", async () => {
    render(
      <CaptureForm
        initialTitle="Farbe aussuchen"
        projectId={42}
        onCancel={vi.fn()}
        onCaptured={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Erstellen" }));

    await waitFor(() =>
      expect(mockedApi.createTask).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 42, status: "actionable" }),
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
    await userEvent.click(screen.getByRole("button", { name: "Erstellen" }));

    await waitFor(() =>
      expect(mockedApi.createTask).toHaveBeenCalledWith(
        expect.objectContaining({ dueDate: null }),
      ),
    );
  });
});
