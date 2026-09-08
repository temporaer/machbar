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
  useIdentity: () => ({
    currentMemberId: 1,
    members: [
      { id: 1, name: "Mira" },
      { id: 2, name: "Sarah" },
    ],
  }),
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

  it("applies a person modifier to the same explicit owner metadata as typed capture", async () => {
    render(
      <CaptureForm
        initialTitle="Sarah zurückrufen"
        onCancel={vi.fn()}
        onCaptured={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "+ Person" }));
    await userEvent.click(screen.getByRole("button", { name: "Sarah" }));
    await waitFor(() =>
      expect(screen.getByPlaceholderText("Was ist zu tun?")).toHaveFocus(),
    );
    await userEvent.click(screen.getByRole("button", { name: "Erstellen" }));

    await waitFor(() =>
      expect(mockedApi.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerMemberId: 2,
          ownerInheritanceMode: "explicit",
        }),
      ),
    );
  });

  it("applies a planning shortcut through the capture metadata state", async () => {
    render(
      <CaptureForm
        initialTitle="Paket wegbringen"
        onCancel={vi.fn()}
        onCaptured={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "+ Planen" }));
    await userEvent.click(screen.getByRole("button", { name: "Heute" }));
    await waitFor(() =>
      expect(screen.getByPlaceholderText("Was ist zu tun?")).toHaveFocus(),
    );
    await userEvent.click(screen.getByRole("button", { name: "Erstellen" }));

    await waitFor(() =>
      expect(mockedApi.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          scheduledDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        }),
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
