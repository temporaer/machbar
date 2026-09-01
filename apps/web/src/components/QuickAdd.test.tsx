import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/testUtils";
import { QuickAdd } from "./QuickAdd";
import { api } from "../lib/api";
import { makeMember, makeProject, makeTask } from "../test/fixtures";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    createTask: vi.fn(),
    createProject: vi.fn(),
    getProjects: vi.fn(),
    moveTask: vi.fn(),
    deleteTask: vi.fn(),
    updateTask: vi.fn(),
    addCriterion: vi.fn(),
    updateProject: vi.fn(),
    uploadPaperlessDocument: vi.fn(),
    preparePaperlessImageForCrop: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

async function openCapture() {
  await userEvent.click(screen.getByRole("button", { name: "Schnell hinzufügen" }));
  await userEvent.click(screen.getByRole("button", { name: "Aufgabe erfassen" }));
  expect(screen.getByText("Nur Titel reicht")).toBeInTheDocument();
}

describe("QuickAdd", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.setItem("machbar:identity-member-id", "1");
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1, name: "Mira" })]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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
    expect(screen.getByText("In Eingang abgelegt")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Speichern" })).not.toBeInTheDocument();
    expect(screen.queryByText("In Heute hinzugefügt")).not.toBeInTheDocument();
  });

  it("legt Machbar ohne Klärungsbedarf an und hält Korrekturen persistent bereit", async () => {
    mockedApi.getMembers.mockResolvedValue([
      makeMember({ id: 1, name: "Mira" }),
      makeMember({ id: 2, name: "Jonas" }),
    ]);
    mockedApi.createTask.mockResolvedValue(
      makeTask({ id: 12, title: "Angebot senden", ownerMemberId: 1, ownerInheritanceMode: "explicit" }),
    );
    mockedApi.getProjects.mockResolvedValue([makeProject({ id: 7, title: "Umzug" })]);
    mockedApi.moveTask.mockResolvedValue(makeTask({ id: 12, projectId: 7 }) as never);
    mockedApi.updateTask.mockResolvedValue(
      makeTask({ id: 12, ownerMemberId: 2, ownerInheritanceMode: "explicit" }) as never,
    );
    renderWithProviders(<QuickAdd />);
    await openCapture();
    expect(screen.getByText("Erscheint sofort in Heute")).toBeInTheDocument();
    expect(screen.getByText("In Schritte zerlegen")).toBeInTheDocument();

    await userEvent.type(screen.getByPlaceholderText("Was ist zu tun?"), "Angebot senden");
    await userEvent.click(screen.getByRole("button", { name: "Machbar" }));

    await waitFor(() =>
      expect(mockedApi.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Angebot senden",
          status: "actionable",
          projectId: null,
          dueDate: null,
          scheduledDate: null,
          ownerMemberId: 1,
          ownerInheritanceMode: "explicit",
        }),
      ),
    );
    expect(screen.getByText("In Heute hinzugefügt")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Zuständig ändern" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Projekt wählen" }));
    await waitFor(() => expect(mockedApi.getProjects).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: "Umzug" }));
    await userEvent.click(screen.getByRole("button", { name: "Hierher verschieben" }));
    await waitFor(() =>
      expect(mockedApi.moveTask).toHaveBeenCalledWith(12, {
        parentTaskId: null,
        projectId: 7,
        expectedRevision: 1,
      }),
    );
    expect(screen.getByText("In Heute hinzugefügt")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Zuständig ändern" }));
    await userEvent.click(screen.getByRole("button", { name: "Jonas" }));
    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(12, {
        ownerMemberId: 2,
        ownerInheritanceMode: "explicit",
        expectedRevision: 1,
      }),
    );
    expect(screen.queryByRole("group", { name: "Zuständig" })).not.toBeInTheDocument();
  });

  it("bewahrt den Projektkontext für schnelle Aufgaben", async () => {
    mockedApi.createTask.mockResolvedValue(makeTask({ title: "Angebot senden", projectId: 7 }));
    renderWithProviders(<QuickAdd projectId={7} />);
    await openCapture();

    await userEvent.type(screen.getByPlaceholderText("Was ist zu tun?"), "Angebot senden");
    await userEvent.click(screen.getByRole("button", { name: "Machbar" }));

    await waitFor(() =>
      expect(mockedApi.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 7,
          status: "actionable",
        }),
      ),
    );
  });

  it("übergibt ein neues Projekt an leichte nächste-Schritt-, Öffnen- und Fertig-Aktionen", async () => {
    const project = makeProject({ id: 55, title: "Küche renovieren", status: "backlog", ownerMemberId: 1 });
    mockedApi.createProject.mockResolvedValue(project);
    mockedApi.createTask.mockResolvedValue(makeTask({ projectId: 55 }) as never);
    renderWithProviders(<QuickAdd />);
    await openCapture();

    await userEvent.type(screen.getByPlaceholderText("Was ist zu tun?"), "Küche renovieren");
    await userEvent.click(screen.getByRole("button", { name: "Projekt" }));

    await waitFor(() =>
      expect(mockedApi.createProject).toHaveBeenCalledWith({
        title: "Küche renovieren",
        status: "backlog",
        ownerMemberId: 1,
      }),
    );
    expect(screen.getByRole("button", { name: "Nächsten Schritt hinzufügen" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Projekt öffnen" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Erledigt" })).toBeInTheDocument();
    expect(screen.queryByText("Erledigt, wenn …")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Nächsten Schritt hinzufügen" }));
    const nextAction = screen.getByPlaceholderText("Nächsten Schritt hinzufügen");
    expect(nextAction).toHaveFocus();
    await userEvent.type(nextAction, "Angebote vergleichen");
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() =>
      expect(mockedApi.createTask).toHaveBeenCalledWith(
        {
          title: "Angebote vergleichen",
          projectId: 55,
          status: "actionable",
          createdByMemberId: 1,
        },
      ),
    );
    expect(screen.getByRole("button", { name: "Erledigt" })).toBeInTheDocument();
  });

  it("legt Projekte ohne ausgewählte Identität ungeplant und unzugewiesen ab", async () => {
    window.localStorage.removeItem("machbar:identity-member-id");
    mockedApi.createProject.mockResolvedValue(makeProject({ id: 56, status: "backlog", ownerMemberId: null }));
    renderWithProviders(<QuickAdd />);
    await openCapture();

    await userEvent.type(screen.getByPlaceholderText("Was ist zu tun?"), "Idee sammeln");
    await userEvent.click(screen.getByRole("button", { name: "Projekt" }));

    await waitFor(() =>
      expect(mockedApi.createProject).toHaveBeenCalledWith({
        title: "Idee sammeln",
        status: "backlog",
        ownerMemberId: null,
      }),
    );
  });

  it("behält Titel und Fehler nach einem fehlgeschlagenen Erfassen", async () => {
    mockedApi.createTask.mockRejectedValue(new Error("Netzwerkfehler"));
    renderWithProviders(<QuickAdd />);
    await openCapture();

    const input = screen.getByPlaceholderText("Was ist zu tun?");
    await userEvent.type(input, "Nicht verlieren");
    await userEvent.click(screen.getByRole("button", { name: "Machbar" }));

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
    await userEvent.click(screen.getByRole("button", { name: "Machbar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Create failed");
    await userEvent.click(screen.getByRole("button", { name: "Machbar" }));

    await waitFor(() => expect(mockedApi.createTask).toHaveBeenCalledTimes(2));
    expect(mockedApi.uploadPaperlessDocument).toHaveBeenCalledTimes(1);
    expect(mockedApi.createTask).toHaveBeenLastCalledWith(
      expect.objectContaining({
        notes: "![receipt.jpg](paperless:88)",
      }),
    );
  });

  it("crops a captured photo before its deferred upload", async () => {
    const close = vi.fn();
    const createImageBitmap = vi
      .fn()
      .mockResolvedValue({ width: 1000, height: 800, close });
    vi.stubGlobal("createImageBitmap", createImageBitmap);
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
    expect(mockedApi.preparePaperlessImageForCrop).toHaveBeenCalledWith(
      expect.objectContaining({ name: "photo.jpg" }),
      expect.any(AbortSignal),
    );
    expect(createImageBitmap).toHaveBeenCalledWith(expect.any(Blob));

    await userEvent.click(screen.getByRole("button", { name: "Ausschnitt verwenden" }));
    expect(await screen.findByText("photo-cropped.jpg")).toBeInTheDocument();

    await userEvent.type(screen.getByPlaceholderText("Was ist zu tun?"), "Photo");
    await userEvent.click(screen.getByRole("button", { name: "Machbar" }));
    await waitFor(() => expect(mockedApi.uploadPaperlessDocument).toHaveBeenCalled());
    const uploadedFile = mockedApi.uploadPaperlessDocument.mock.calls[0]?.[0];
    expect(uploadedFile).toBeInstanceOf(File);
    expect(uploadedFile?.name).toBe("photo-cropped.jpg");
    expect(close).toHaveBeenCalled();
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

  it("macht eine neue Machbar-Aufgabe rückgängig", async () => {
    mockedApi.createTask.mockResolvedValue(makeTask({ id: 67, title: "Rückgängig" }));
    mockedApi.deleteTask.mockResolvedValue(undefined);
    renderWithProviders(<QuickAdd />);
    await openCapture();

    await userEvent.type(screen.getByPlaceholderText("Was ist zu tun?"), "Rückgängig");
    await userEvent.click(screen.getByRole("button", { name: "Machbar" }));
    await screen.findByText("In Heute hinzugefügt");
    await userEvent.click(screen.getByRole("button", { name: "Rückgängig" }));

    await waitFor(() => expect(mockedApi.deleteTask).toHaveBeenCalledWith(67));
    expect(screen.queryByText("In Heute hinzugefügt")).not.toBeInTheDocument();
  });
});
