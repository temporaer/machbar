import { beforeEach, describe, expect, it, vi } from "vitest";
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
    moveSubtree: vi.fn(),
    deleteTask: vi.fn(),
    updateTask: vi.fn(),
    addCriterion: vi.fn(),
    updateProject: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

async function openCapture() {
  await userEvent.click(screen.getByRole("button", { name: "Schnell hinzufügen" }));
  expect(screen.getByText("Nur Titel reicht")).toBeInTheDocument();
}

describe("QuickAdd", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.setItem("machbar:identity-member-id", "1");
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1, name: "Mira" })]);
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
    mockedApi.createTask.mockResolvedValue(
      makeTask({ id: 12, title: "Angebot senden", ownerMemberId: 1, ownerInheritanceMode: "explicit" }),
    );
    mockedApi.getProjects.mockResolvedValue([makeProject({ id: 7, title: "Umzug" })]);
    mockedApi.moveSubtree.mockResolvedValue(makeTask({ id: 12, projectId: 7 }) as never);
    mockedApi.updateTask.mockResolvedValue(
      makeTask({ id: 12, ownerMemberId: 1, ownerInheritanceMode: "explicit" }) as never,
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
    await waitFor(() => expect(mockedApi.moveSubtree).toHaveBeenCalledWith(12, 7));
    expect(screen.getByText("In Heute hinzugefügt")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Zuständig ändern" }));
    await userEvent.click(screen.getByRole("button", { name: "Mira" }));
    await userEvent.click(screen.getByRole("button", { name: "Änderungen speichern" }));
    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(12, {
        ownerMemberId: 1,
        ownerInheritanceMode: "explicit",
      }),
    );
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

  it("legt ein Projekt passend zur gewählten Identität an und öffnet den kleinen Breakdown", async () => {
    const project = makeProject({ id: 55, title: "Küche renovieren", status: "active", ownerMemberId: 1 });
    mockedApi.createProject.mockResolvedValue(project);
    mockedApi.createTask.mockResolvedValue(makeTask({ projectId: 55 }) as never);
    renderWithProviders(<QuickAdd />);
    await openCapture();

    await userEvent.type(screen.getByPlaceholderText("Was ist zu tun?"), "Küche renovieren");
    await userEvent.click(screen.getByRole("button", { name: "Projekt" }));

    await waitFor(() =>
      expect(mockedApi.createProject).toHaveBeenCalledWith({
        title: "Küche renovieren",
        status: "active",
        ownerMemberId: 1,
      }),
    );
    expect(screen.getByLabelText("Was ist der nächste Schritt?")).toHaveFocus();

    await userEvent.type(screen.getByLabelText("Was ist der nächste Schritt?"), "Angebote vergleichen");
    await userEvent.click(screen.getByRole("button", { name: "Nächsten Schritt hinzufügen" }));
    await waitFor(() =>
      expect(mockedApi.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Angebote vergleichen",
          projectId: 55,
          parentTaskId: null,
          status: "actionable",
        }),
      ),
    );
    expect(screen.getByRole("button", { name: "Später fertig machen" })).toBeInTheDocument();
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
