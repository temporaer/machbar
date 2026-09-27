import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/testUtils";
import { QuickAdd } from "./QuickAdd";
import { WorkItemKeyboardNavMount } from "./WorkItemKeyboardNavMount";
import { api } from "../lib/api";
import { makeMember, makeProject, makeTask } from "../test/fixtures";
import { useTaskDetail } from "../lib/taskDetailContext";
import { InteractionScopeProvider } from "../lib/interactionScope";

function renderQuickAddInStory(storyId: number, ui = <QuickAdd />) {
  return renderWithProviders(
    <InteractionScopeProvider captureTarget={{ kind: "story", storyId }}>
      <WorkItemKeyboardNavMount />
      {ui}
    </InteractionScopeProvider>,
  );
}

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    createTask: vi.fn(),
    createProject: vi.fn(),
    getTags: vi.fn(),
    getProjects: vi.fn(),
    getHomeAssistantStatus: vi.fn(),
    moveTask: vi.fn(),
    updateTask: vi.fn(),
    addCriterion: vi.fn(),
    updateProject: vi.fn(),
    uploadPaperlessDocument: vi.fn(),
    preparePaperlessImageForCrop: vi.fn(),
    createIntake: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);
const originalCreateObjectUrl = Object.getOwnPropertyDescriptor(
  URL,
  "createObjectURL",
);
const originalRevokeObjectUrl = Object.getOwnPropertyDescriptor(
  URL,
  "revokeObjectURL",
);

async function openCapture() {
  await userEvent.click(screen.getByRole("button", { name: "Schnell hinzufügen" }));
  await userEvent.click(screen.getByRole("button", { name: "Aufgabe erfassen" }));
  expect(screen.getByText("Nur Titel reicht")).toBeInTheDocument();
}

async function cropCapturedPhoto(index = 0, croppedName = "photo-cropped.jpg") {
  Object.defineProperties(URL, {
    createObjectURL: { configurable: true, value: vi.fn(() => "blob:prepared") },
    revokeObjectURL: { configurable: true, value: vi.fn() },
  });
  mockedApi.preparePaperlessImageForCrop.mockResolvedValue(
    new Blob(["prepared"], { type: "image/jpeg" }),
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
    (callback) => callback(new Blob(["cropped"], { type: "image/jpeg" })),
  );
  await userEvent.click((await screen.findAllByRole("button", { name: "Foto zuschneiden" }))[index]!);
  const image = await screen.findByAltText("Vorschau des Bildausschnitts");
  Object.defineProperties(image, {
    naturalWidth: { configurable: true, value: 1000 },
    naturalHeight: { configurable: true, value: 800 },
  });
  fireEvent.load(image);
  await userEvent.click(await screen.findByRole("button", { name: "Ausschnitt verwenden" }));
  expect(await screen.findByText(croppedName)).toBeInTheDocument();
}

function OpenTaskProbe() {
  const { openTaskId } = useTaskDetail();
  return <output data-testid="open-task-id">{openTaskId ?? "none"}</output>;
}

describe("QuickAdd", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.setItem("machbar:identity-member-id", "1");
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1, name: "Mira" })]);
    mockedApi.getTags.mockResolvedValue([]);
    mockedApi.getProjects.mockResolvedValue([]);
    mockedApi.getHomeAssistantStatus.mockResolvedValue({
      connected: false,
      instanceId: null,
      protocolVersion: null,
      connectedAt: null,
      lastUpdateAt: null,
      stale: false,
      supportedProtocolVersion: 2,
      protocolOutdated: false,
      lastRequestPollAt: null,
      workerOnline: false,
      intake: null,
      intakeReady: false,
      people: [],
      contexts: [],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (originalCreateObjectUrl) {
      Object.defineProperty(URL, "createObjectURL", originalCreateObjectUrl);
    } else {
      Reflect.deleteProperty(URL, "createObjectURL");
    }
    if (originalRevokeObjectUrl) {
      Object.defineProperty(URL, "revokeObjectURL", originalRevokeObjectUrl);
    } else {
      Reflect.deleteProperty(URL, "revokeObjectURL");
    }
  });

  it("erfasst Enter als später zu klärende Aufgabe ohne generisches Speichern", async () => {
    mockedApi.createTask.mockResolvedValue(makeTask({ id: 11, title: "Milch kaufen" }));
    renderWithProviders(<QuickAdd />);
    await openCapture();

    await userEvent.type(screen.getByPlaceholderText("Was ist zu tun?"), "Milch kaufen{enter}");

    await waitFor(() =>
      expect(mockedApi.createTask).toHaveBeenCalledWith({
        title: "Milch kaufen",
        projectId: null,
        parentTaskId: null,
        createdByMemberId: 1,
        status: "captured",
        dueDate: null,
        scheduledDate: null,
        ownerMemberId: 1,
        ownerInheritanceMode: "explicit",
      }),
    );
    expect(screen.queryByText("In Eingang abgelegt")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Machbar" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Projekt" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Später klären" })).not.toBeInTheDocument();
    expect(screen.queryByText("In Heute hinzugefügt")).not.toBeInTheDocument();
  });

  it("bewahrt den Projektkontext für schnelle Aufgaben", async () => {
    mockedApi.createTask.mockResolvedValue(makeTask({ title: "Angebot senden", projectId: 7 }));
    renderQuickAddInStory(7);
    await openCapture();

    await userEvent.type(screen.getByPlaceholderText("Was ist zu tun?"), "Angebot senden");
    await userEvent.click(screen.getByRole("button", { name: "Erstellen" }));

    await waitFor(() =>
      expect(mockedApi.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 7,
          status: "actionable",
        }),
      ),
    );
  });

  it("resolves selected short-syntax entities and strips resolved tokens from capture title", async () => {
    const hanna = makeMember({ id: 2, name: "Hanna" });
    const tag = { id: 9, name: "Haushalt", color: "#64748b", kind: "area" as const, groupingMode: "auto" as const, sortPosition: null };
    const context = {
      id: 10,
      source: "home_assistant" as const,
      externalId: "zone.home",
      name: "Zuhause",
      active: true,
      updatedAt: "2026-09-07T10:00:00.000Z",
    };
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1, name: "Mira" }), hanna]);
    mockedApi.getTags.mockResolvedValue([tag]);
    mockedApi.getProjects.mockResolvedValue([makeProject({ id: 7, title: "Urlaub" })]);
    mockedApi.getHomeAssistantStatus.mockResolvedValue({
      connected: true,
      instanceId: "ha",
      protocolVersion: 1,
      connectedAt: "2026-09-07T09:00:00.000Z",
      lastUpdateAt: "2026-09-07T10:00:00.000Z",
      stale: false,
      supportedProtocolVersion: 2,
      protocolOutdated: false,
      lastRequestPollAt: null,
      workerOnline: false,
      intake: null,
      intakeReady: false,
      people: [],
      contexts: [context],
    });
    mockedApi.createTask.mockResolvedValue(makeTask({ id: 90, title: "Tickets buchen" }));
    // Pin only `Date` (not timers) so the "!15.9" short-syntax due date
    // deterministically resolves to the current year regardless of the
    // real-world date userEvent's internal delays keep using real timers.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 7, 12, 0, 0));
    renderWithProviders(<QuickAdd />);
    await openCapture();

    const input = screen.getByPlaceholderText("Was ist zu tun?");
    await userEvent.type(input, "Tickets buchen >Ur");
    await userEvent.click(await screen.findByRole("button", { name: "Urlaub active" }));
    await userEvent.type(input, " @Han");
    await userEvent.click(await screen.findByRole("button", { name: "Hanna" }));
    await userEvent.type(input, " #Haus");
    await userEvent.click(await screen.findByRole("button", { name: "Haushalt area" }));
    await userEvent.type(input, " %Zu");
    await userEvent.click(await screen.findByRole("button", { name: "Zuhause" }));
    await userEvent.type(input, " !15.9 :S");
    await userEvent.click(screen.getByRole("button", { name: "Erstellen" }));

    try {
      await waitFor(() =>
        expect(mockedApi.createTask).toHaveBeenCalledWith(
          expect.objectContaining({
            title: "Tickets buchen",
            projectId: 7,
            ownerMemberId: 2,
            ownerInheritanceMode: "explicit",
            dueDate: "2026-09-15",
            size: "S",
            tagIds: [9],
            contextIds: [10],
            contextInheritanceMode: "explicit",
          }),
        ),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("behält Titel und Fehler nach einem fehlgeschlagenen Erfassen", async () => {
    mockedApi.createTask.mockRejectedValue(new Error("Netzwerkfehler"));
    renderWithProviders(<QuickAdd />);
    await openCapture();

    const input = screen.getByPlaceholderText("Was ist zu tun?");
    await userEvent.type(input, "Nicht verlieren");
    await userEvent.click(screen.getByRole("button", { name: "Erstellen" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Netzwerkfehler");
    expect(input).toHaveValue("Nicht verlieren");
  });

  it("keeps selected material local until capture and reuses a completed upload on retry", async () => {
    mockedApi.uploadPaperlessDocument.mockResolvedValue({
      id: 88,
      title: "receipt",
      originalFileName: "receipt.jpg",
      mimeType: "image/jpeg",
    });

    mockedApi.createTask
      .mockRejectedValueOnce(new Error("Create failed"))
      .mockResolvedValueOnce(makeTask({ id: 88, title: "Receipt" }));
    renderWithProviders(<QuickAdd />);

    await userEvent.click(screen.getByRole("button", { name: "Schnell hinzufügen" }));
    await userEvent.upload(
      screen.getByLabelText("Foto aufnehmen"),
      new File(["image"], "receipt.jpg", { type: "image/jpeg" }),
    );

    expect(screen.getByText("receipt.jpg")).toBeInTheDocument();
    expect(mockedApi.uploadPaperlessDocument).not.toHaveBeenCalled();
    await userEvent.type(screen.getByPlaceholderText("Was ist zu tun?"), "Receipt");
    await userEvent.click(screen.getByRole("button", { name: "Erstellen" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Create failed");
    await userEvent.click(screen.getByRole("button", { name: "Erstellen" }));

    await waitFor(() => expect(mockedApi.createTask).toHaveBeenCalledTimes(2));
    expect(mockedApi.uploadPaperlessDocument).toHaveBeenCalledTimes(1);
    expect(mockedApi.createTask).toHaveBeenLastCalledWith(
      expect.objectContaining({
        notes: "![receipt.jpg](paperless:88)",
      }),
    );
  });

  it("crops a captured photo before its deferred upload", async () => {
    Object.defineProperties(URL, {
      createObjectURL: {
        configurable: true,
        value: vi.fn(() => "blob:prepared"),
      },
      revokeObjectURL: { configurable: true, value: vi.fn() },
    });

    mockedApi.preparePaperlessImageForCrop.mockResolvedValue(
      new Blob(["prepared"], { type: "image/jpeg" }),
    );
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
      (callback) => callback(new Blob(["cropped"], { type: "image/jpeg" })),
    );
    mockedApi.uploadPaperlessDocument.mockResolvedValue({
      id: 89,
      title: "photo-cropped",
      originalFileName: "photo-cropped.jpg",
      mimeType: "image/jpeg",
    });
    mockedApi.createTask.mockResolvedValue(makeTask({ id: 89, title: "Photo" }));
    renderWithProviders(<QuickAdd />);

    await userEvent.click(screen.getByRole("button", { name: "Schnell hinzufügen" }));
    await userEvent.upload(
      screen.getByLabelText("Foto aufnehmen"),
      new File(
        [
          new Uint8Array([
            0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x20, 0x03, 0xe8,
          ]),
        ],
        "photo.jpg",
        { type: "image/jpeg" },
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: "Foto zuschneiden" }));
    expect(
      await screen.findByRole("dialog", { name: "Foto zuschneiden" }),
    ).toBeInTheDocument();
    const image = await screen.findByAltText("Vorschau des Bildausschnitts");
    Object.defineProperties(image, {
      naturalWidth: { configurable: true, value: 1000 },
      naturalHeight: { configurable: true, value: 800 },
    });
    fireEvent.load(image);
    expect(mockedApi.preparePaperlessImageForCrop).toHaveBeenCalledWith(
      expect.objectContaining({ name: "photo.jpg" }),
      expect.any(AbortSignal),
    );
    await userEvent.click(screen.getByRole("button", { name: "Ausschnitt verwenden" }));
    expect(await screen.findByText("photo-cropped.jpg")).toBeInTheDocument();

    await userEvent.type(screen.getByPlaceholderText("Was ist zu tun?"), "Photo");
    await userEvent.click(screen.getByRole("button", { name: "Erstellen" }));
    await waitFor(() => expect(mockedApi.uploadPaperlessDocument).toHaveBeenCalled());
    const uploadedFile = mockedApi.uploadPaperlessDocument.mock.calls[0]?.[0];
    expect(uploadedFile).toBeInstanceOf(File);
    expect(uploadedFile?.name).toBe("photo-cropped.jpg");
  });

  it("submits the cropped current file when cropping after switching to AI processing", async () => {
    mockedApi.createIntake.mockResolvedValue({ id: "intake-1" } as never);
    const original = new File(["photo"], "photo.jpg", { type: "image/jpeg" });
    renderWithProviders(<QuickAdd />);
    await userEvent.click(screen.getByRole("button", { name: "Schnell hinzufügen" }));
    await userEvent.upload(
      screen.getByLabelText("Datei auswählen"),
      original,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Verarbeiten" }));
    await cropCapturedPhoto();
    await userEvent.click(screen.getByRole("button", { name: "Verarbeiten" }));

    await waitFor(() => expect(mockedApi.createIntake).toHaveBeenCalledTimes(1));
    const submittedFiles = mockedApi.createIntake.mock.calls[0]?.[0].files;
    expect(submittedFiles).toHaveLength(1);
    const submitted = submittedFiles?.[0];
    expect(submitted).toBeInstanceOf(File);
    expect(submitted?.name).toBe("photo-cropped.jpg");
    expect(submitted).not.toBe(original);
  });

  it("keeps a crop from the normal capture form when switching to AI processing", async () => {
    mockedApi.createIntake.mockResolvedValue({ id: "intake-2" } as never);
    const original = new File(["photo"], "photo.jpg", { type: "image/jpeg" });
    renderWithProviders(<QuickAdd />);
    await userEvent.click(screen.getByRole("button", { name: "Schnell hinzufügen" }));
    await userEvent.upload(
      screen.getByLabelText("Datei auswählen"),
      original,
    );
    await cropCapturedPhoto();
    await userEvent.click(await screen.findByRole("button", { name: "Verarbeiten" }));
    expect(await screen.findByText("photo-cropped.jpg")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Verarbeiten" }));

    await waitFor(() => expect(mockedApi.createIntake).toHaveBeenCalledTimes(1));
    const submittedFiles = mockedApi.createIntake.mock.calls[0]?.[0].files;
    expect(submittedFiles).toHaveLength(1);
    expect(submittedFiles?.[0]?.name).toBe("photo-cropped.jpg");
    expect(submittedFiles?.[0]).not.toBe(original);
  });

  it("crops a locally added intake file without replacing the seeded capture or other files", async () => {
    mockedApi.createIntake.mockResolvedValue({ id: "intake-3" } as never);
    const seeded = new File(["seed"], "photo.jpg", { type: "image/jpeg" });
    const local = new File(["extra"], "extra.jpg", { type: "image/jpeg" });
    const other = new File(["notes"], "notes.pdf", { type: "application/pdf" });
    renderWithProviders(<QuickAdd />);
    await userEvent.click(screen.getByRole("button", { name: "Schnell hinzufügen" }));
    await userEvent.upload(screen.getByLabelText("Datei auswählen"), seeded);
    await userEvent.click(await screen.findByRole("button", { name: "Verarbeiten" }));
    await userEvent.upload(screen.getByLabelText("Datei auswählen"), [local, other]);
    await cropCapturedPhoto(1, "extra-cropped.jpg");
    await userEvent.click(screen.getByRole("button", { name: "Verarbeiten" }));
    await waitFor(() => expect(mockedApi.createIntake).toHaveBeenCalledTimes(1));
    const files = mockedApi.createIntake.mock.calls[0]?.[0].files;
    expect(files?.map((file) => file.name)).toEqual(["photo.jpg", "extra-cropped.jpg", "notes.pdf"]);
    expect(files?.[0]).toBe(seeded);
    expect(files?.[1]).not.toBe(local);
    expect(files?.[2]).toBe(other);
  });

  it("replaces the seeded crop in place while retaining locally selected files", async () => {
    mockedApi.createIntake.mockResolvedValue({ id: "intake-5" } as never);
    const seeded = new File(["seed"], "photo.jpg", { type: "image/jpeg" });
    const extra = new File(["extra"], "extra.jpg", { type: "image/jpeg" });
    renderWithProviders(<QuickAdd />);
    await userEvent.click(screen.getByRole("button", { name: "Schnell hinzufügen" }));
    await userEvent.upload(screen.getByLabelText("Datei auswählen"), seeded);
    await userEvent.click(await screen.findByRole("button", { name: "Verarbeiten" }));
    await userEvent.upload(screen.getByLabelText("Datei auswählen"), extra);
    await cropCapturedPhoto();
    await userEvent.click(screen.getByRole("button", { name: "Verarbeiten" }));
    await waitFor(() => expect(mockedApi.createIntake).toHaveBeenCalledTimes(1));
    const files = mockedApi.createIntake.mock.calls[0]?.[0].files;
    expect(files?.map((file) => file.name)).toEqual(["photo-cropped.jpg", "extra.jpg"]);
    expect(files?.[0]).not.toBe(seeded);
    expect(files?.[1]).toBe(extra);
  });

  it("crops a chosen local intake file with no seeded capture without creating a parent pending file", async () => {
    mockedApi.createIntake.mockResolvedValue({ id: "intake-4" } as never);
    const first = new File(["first"], "first.jpg", { type: "image/jpeg" });
    const second = new File(["second"], "photo.jpg", { type: "image/jpeg" });
    renderWithProviders(<QuickAdd />);
    await userEvent.click(screen.getByRole("button", { name: "Schnell hinzufügen" }));
    await userEvent.click(screen.getByRole("button", { name: "Verarbeiten" }));
    await userEvent.upload(screen.getByLabelText("Datei auswählen"), [first, second]);
    await cropCapturedPhoto(1);
    await userEvent.click(screen.getByRole("button", { name: "Verarbeiten" }));
    await waitFor(() => expect(mockedApi.createIntake).toHaveBeenCalledTimes(1));
    const files = mockedApi.createIntake.mock.calls[0]?.[0].files;
    expect(files?.map((file) => file.name)).toEqual(["first.jpg", "photo-cropped.jpg"]);
    expect(files?.[0]).toBe(first);
    expect(files?.[1]).not.toBe(second);
  });

  it("opens the bounded in-app camera instead of the file capture intent", async () => {
    renderWithProviders(<QuickAdd />);

    await userEvent.click(
      screen.getByRole("button", { name: "Schnell hinzufügen" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Foto erfassen" }),
    );

    expect(
      await screen.findByRole("dialog", { name: "Foto aufnehmen" }),
    ).toBeInTheDocument();
  });

  it("öffnet die Details der neu angelegten Machbar-Aufgabe", async () => {
    mockedApi.createTask.mockResolvedValue(makeTask({ id: 67, title: "Details" }));
    renderWithProviders(
      <>
        <QuickAdd />
        <OpenTaskProbe />
      </>,
    );
    await openCapture();

    await userEvent.type(screen.getByPlaceholderText("Was ist zu tun?"), "Details");
    await userEvent.click(screen.getByRole("button", { name: "Erstellen" }));
    expect(screen.queryByText("In Heute hinzugefügt")).not.toBeInTheDocument();
    expect(screen.getByTestId("open-task-id")).toHaveTextContent("none");
  });

  it("öffnet die Erfassung per 'c'-Tastenkürzel im aktuellen Projektkontext", async () => {
    mockedApi.createTask.mockResolvedValue(makeTask({ title: "Angebot senden", projectId: 7 }));
    renderQuickAddInStory(7);

    await userEvent.keyboard("c");
    await userEvent.click(screen.getByRole("button", { name: "Aufgabe erfassen" }));
    await userEvent.type(screen.getByPlaceholderText("Was ist zu tun?"), "Angebot senden");
    await userEvent.click(screen.getByRole("button", { name: "Erstellen" }));

    await waitFor(() =>
      expect(mockedApi.createTask).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 7 }),
      ),
    );
  });

  it("ignoriert das 'c'-Tastenkürzel, während ein Textfeld fokussiert ist", async () => {
    renderWithProviders(
      <>
        <input aria-label="Anderes Feld" />
        <InteractionScopeProvider>
          <WorkItemKeyboardNavMount />
          <QuickAdd />
        </InteractionScopeProvider>
      </>,
    );

    await userEvent.click(screen.getByLabelText("Anderes Feld"));
    await userEvent.keyboard("c");

    expect(screen.queryByText("Nur Titel reicht")).not.toBeInTheDocument();
  });
});
