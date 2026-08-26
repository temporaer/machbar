import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../lib/api";
import { makeMember, makeProject, makeTask } from "../test/fixtures";
import { renderWithProviders } from "../test/testUtils";
import { CaptureProjectBreakdownSheet } from "./CaptureProjectBreakdownSheet";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    createTask: vi.fn(),
    addCriterion: vi.fn(),
    updateProject: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

describe("CaptureProjectBreakdownSheet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.setItem("machbar:identity-member-id", "1");
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1, name: "Mira" })]);
    mockedApi.createTask.mockResolvedValue(makeTask({ projectId: 42 }) as never);
    mockedApi.addCriterion.mockResolvedValue(makeProject({ id: 42 }) as never);
    mockedApi.updateProject.mockResolvedValue(makeProject({ id: 42 }) as never);
  });

  it("fügt Aufgaben, Wartepunkt, Kriterium und Notizen ohne Voll-Editor hinzu", async () => {
    const onClose = vi.fn();
    renderWithProviders(
      <CaptureProjectBreakdownSheet project={makeProject({ id: 42, title: "Küche" })} onClose={onClose} />,
    );

    await userEvent.type(screen.getByLabelText("Was ist der nächste Schritt?"), "Angebote einholen");
    await userEvent.click(screen.getByRole("button", { name: "Nächsten Schritt hinzufügen" }));
    await waitFor(() =>
      expect(mockedApi.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Angebote einholen",
          projectId: 42,
          parentTaskId: null,
          status: "actionable",
          needsClarification: false,
        }),
      ),
    );

    await userEvent.type(screen.getByLabelText("Teilaufgabe hinzufügen"), "Fliesen auswählen");
    await userEvent.click(screen.getByRole("button", { name: "Teilaufgabe hinzufügen" }));
    await waitFor(() =>
      expect(mockedApi.createTask).toHaveBeenLastCalledWith(
        expect.objectContaining({
          title: "Fliesen auswählen",
          projectId: 42,
          parentTaskId: null,
          status: "actionable",
          needsClarification: false,
        }),
      ),
    );

    await userEvent.type(screen.getByLabelText("Wartepunkt"), "Auf Angebot warten");
    await userEvent.type(screen.getByLabelText("Wartet auf"), "Fliesenleger");
    await userEvent.click(screen.getByRole("button", { name: "Wartepunkt hinzufügen" }));
    await waitFor(() =>
      expect(mockedApi.createTask).toHaveBeenLastCalledWith(
        expect.objectContaining({
          title: "Auf Angebot warten",
          projectId: 42,
          parentTaskId: null,
          status: "waiting",
          waitingFor: "Fliesenleger",
        }),
      ),
    );

    await userEvent.type(screen.getByLabelText("Erledigt, wenn …"), "Auftrag vergeben");
    await userEvent.click(screen.getByRole("button", { name: "Punkt hinzufügen" }));
    await waitFor(() => expect(mockedApi.addCriterion).toHaveBeenCalledWith(42, "Auftrag vergeben"));

    await userEvent.type(screen.getByLabelText("Notizen"), "Budget prüfen");
    await userEvent.click(screen.getByRole("button", { name: "Notizen speichern" }));
    await waitFor(() => expect(mockedApi.updateProject).toHaveBeenCalledWith(42, { notes: "Budget prüfen" }));

    await userEvent.click(screen.getByRole("button", { name: "Später fertig machen" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
