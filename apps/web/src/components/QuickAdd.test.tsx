import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/testUtils";
import { QuickAdd } from "./QuickAdd";
import { api } from "../lib/api";
import { makeMember, makeTask } from "../test/fixtures";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    createTask: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

describe("QuickAdd", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1 })]);
  });

  it("legt global eine machbare Aufgabe zur Klärung an", async () => {
    mockedApi.createTask.mockResolvedValue(makeTask({ title: "Milch kaufen" }));
    renderWithProviders(<QuickAdd />);

    await userEvent.click(screen.getByRole("button", { name: "Schnell hinzufügen" }));
    expect(screen.getByText("Nur Titel reicht")).toBeInTheDocument();

    await userEvent.type(screen.getByPlaceholderText("Was ist zu tun?"), "Milch kaufen");
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));

    await waitFor(() =>
      expect(mockedApi.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Milch kaufen",
          status: "actionable",
          needsClarification: true,
        }),
      ),
    );
  });

  it("legt in einem Projekt eine bereits geklärte machbare Aufgabe an", async () => {
    mockedApi.createTask.mockResolvedValue(makeTask({ title: "Angebot senden", projectId: 7 }));
    renderWithProviders(<QuickAdd projectId={7} />);

    await userEvent.click(screen.getByRole("button", { name: "Schnell hinzufügen" }));
    await userEvent.type(screen.getByPlaceholderText("Was ist zu tun?"), "Angebot senden");
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));

    await waitFor(() =>
      expect(mockedApi.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 7,
          status: "actionable",
          needsClarification: false,
        }),
      ),
    );
  });

  it("erlaubt Abbrechen ohne zu speichern", async () => {
    renderWithProviders(<QuickAdd />);
    await userEvent.click(screen.getByRole("button", { name: "Schnell hinzufügen" }));
    await userEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(screen.queryByText("Nur Titel reicht")).not.toBeInTheDocument();
    expect(mockedApi.createTask).not.toHaveBeenCalled();
  });
});
