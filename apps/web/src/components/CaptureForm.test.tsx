import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CaptureForm } from "./CaptureForm";
import { api, ApiError } from "../lib/api";
import { makeTask } from "../test/fixtures";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    api: {
      createTask: vi.fn(),
      getTags: vi.fn(),
      getProjects: vi.fn(),
      getHomeAssistantStatus: vi.fn(),
    },
  };
});

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
      supportedProtocolVersion: 3,
      protocolOutdated: false,
      lastRequestPollAt: null,
      workerOnline: false,
      intake: null,
      intakeReady: false,
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

  it("keeps a dated project capture draft and completes project decisions in the same form", async () => {
    mockedApi.createTask
      .mockRejectedValueOnce(new ApiError(
        409,
        "Project decisions are required.",
        "project_commitment_resolution_required",
        {
          projects: [{
            projectId: 42,
            title: "Keller",
            revision: 3,
            ownerMemberId: null,
            required: ["driver", "progressPath"],
          }],
          expectedProjects: [{ projectId: 42, revision: 3 }],
        },
      ))
      .mockResolvedValueOnce(makeTask({ projectId: 42, status: "actionable" }));
    const onCaptured = vi.fn();
    render(
      <CaptureForm
        initialTitle="Maße aufnehmen"
        initialDueDate="2026-12-01"
        showDueDate
        projectId={42}
        onCancel={vi.fn()}
        onCaptured={onCaptured}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Erstellen" }));
    expect(await screen.findByText("Vor dem Start noch entscheiden")).toBeInTheDocument();
    expect(mockedApi.createTask).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Erstellen" })).toBeDisabled();

    await userEvent.selectOptions(screen.getByLabelText("Verantwortlich für „Keller“"), "2");
    await userEvent.type(
      screen.getByLabelText("Welcher konkrete nächste Schritt bringt das Projekt voran?"),
      "Maße prüfen",
    );
    await userEvent.click(screen.getByRole("button", { name: "Erstellen" }));

    await waitFor(() => expect(mockedApi.createTask).toHaveBeenCalledTimes(2));
    expect(mockedApi.createTask).toHaveBeenLastCalledWith(expect.objectContaining({
      title: "Maße aufnehmen",
      projectId: 42,
      dueDate: "2026-12-01",
      activationResolution: {
        expectedProjects: [{ projectId: 42, revision: 3 }],
        drivers: [{ projectId: 42, ownerMemberId: 2 }],
        nextActionTitle: "Maße prüfen",
      },
    }));
    expect(onCaptured).toHaveBeenCalledTimes(1);
  });

  it("discards activation requirements when the dated commitment changes", async () => {
    mockedApi.createTask
      .mockRejectedValueOnce(new ApiError(
        409,
        "Project decisions are required.",
        "project_commitment_resolution_required",
        {
          projects: [{
            projectId: 42,
            title: "Keller",
            revision: 3,
            ownerMemberId: null,
            required: ["driver", "progressPath"],
          }],
          expectedProjects: [{ projectId: 42, revision: 3 }],
        },
      ))
      .mockResolvedValueOnce(makeTask({ projectId: 42, status: "actionable" }));
    render(
      <CaptureForm
        initialTitle="Material bestellen"
        initialDueDate="2026-12-01"
        showDueDate
        projectId={42}
        onCancel={vi.fn()}
        onCaptured={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Erstellen" }));
    expect(await screen.findByText("Vor dem Start noch entscheiden")).toBeInTheDocument();
    const date = screen.getByLabelText("Fällig");
    await userEvent.clear(date);
    await userEvent.type(date, "05.12.2026");
    await userEvent.tab();

    expect(screen.queryByText("Vor dem Start noch entscheiden")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Erstellen" }));
    await waitFor(() => expect(mockedApi.createTask).toHaveBeenCalledTimes(2));
    expect(mockedApi.createTask.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      title: "Material bestellen",
      projectId: 42,
      dueDate: "2026-12-05",
    }));
    expect(mockedApi.createTask.mock.calls[1]?.[0]).not.toHaveProperty("activationResolution");
  });

  it("can cancel a blocked dated capture without submitting a second time", async () => {
    mockedApi.createTask.mockRejectedValueOnce(new ApiError(
      409,
      "Project decisions are required.",
      "project_commitment_resolution_required",
      {
        projects: [{ projectId: 42, title: "Keller", revision: 3, ownerMemberId: null, required: ["driver"] }],
        expectedProjects: [{ projectId: 42, revision: 3 }],
      },
    ));
    const onCancel = vi.fn();
    const onCaptured = vi.fn();
    render(
      <CaptureForm
        initialTitle="Material bestellen"
        initialDueDate="2026-12-01"
        showDueDate
        projectId={42}
        onCancel={onCancel}
        onCaptured={onCaptured}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Erstellen" }));
    expect(await screen.findByLabelText("Verantwortlich für „Keller“")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(mockedApi.createTask).toHaveBeenCalledOnce();
    expect(onCaptured).not.toHaveBeenCalled();
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
