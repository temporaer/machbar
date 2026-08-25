import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/testUtils";
import { MemberManager } from "./MemberManager";
import { api } from "../lib/api";
import { makeMember } from "../test/fixtures";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    createMember: vi.fn(),
    updateMember: vi.fn(),
    deleteMember: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

describe("MemberManager", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("zeigt einen leeren Zustand ohne Personen", async () => {
    mockedApi.getMembers.mockResolvedValue([]);
    renderWithProviders(<MemberManager />);

    expect(await screen.findByText("Noch keine Personen angelegt.")).toBeInTheDocument();
  });

  it("legt eine neue Person per Namensfeld an und lädt die Liste neu", async () => {
    mockedApi.getMembers.mockResolvedValueOnce([]).mockResolvedValueOnce([makeMember({ id: 5, name: "Jonas" })]);
    mockedApi.createMember.mockResolvedValue(makeMember({ id: 5, name: "Jonas" }));
    renderWithProviders(<MemberManager />);

    await screen.findByText("Noch keine Personen angelegt.");
    await userEvent.type(screen.getByPlaceholderText("z. B. Mira"), "Jonas");
    await userEvent.click(screen.getByRole("button", { name: "Person hinzufügen" }));

    await waitFor(() => expect(mockedApi.createMember).toHaveBeenCalledWith({ name: "Jonas" }));
    await waitFor(() => expect(mockedApi.getMembers).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Jonas")).toBeInTheDocument();
  });

  it("zeigt einen Fehler, wenn das Anlegen fehlschlägt", async () => {
    mockedApi.getMembers.mockResolvedValue([]);
    mockedApi.createMember.mockRejectedValue(new Error("Name bereits vergeben"));
    renderWithProviders(<MemberManager />);

    await screen.findByText("Noch keine Personen angelegt.");
    await userEvent.type(screen.getByPlaceholderText("z. B. Mira"), "Mira");
    await userEvent.click(screen.getByRole("button", { name: "Person hinzufügen" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Name bereits vergeben");
  });

  it("benennt eine Person über das Namensfeld um", async () => {
    const member = makeMember({ id: 7, name: "Mira" });
    mockedApi.getMembers
      .mockResolvedValueOnce([member])
      .mockResolvedValueOnce([{ ...member, name: "Miriam" }]);
    mockedApi.updateMember.mockResolvedValue({ ...member, name: "Miriam" });
    renderWithProviders(<MemberManager />);

    await screen.findByText("Mira");
    await userEvent.click(screen.getByRole("button", { name: "Umbenennen" }));
    const input = screen.getByLabelText("Name bearbeiten");
    await userEvent.clear(input);
    await userEvent.type(input, "Miriam");
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));

    await waitFor(() => expect(mockedApi.updateMember).toHaveBeenCalledWith(7, { name: "Miriam" }));
    expect(await screen.findByText("Miriam")).toBeInTheDocument();
  });

  it("löscht eine Person nach Bestätigung und aktualisiert die Liste", async () => {
    const member = makeMember({ id: 9, name: "Jonas" });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mockedApi.getMembers.mockResolvedValueOnce([member]).mockResolvedValueOnce([]);
    mockedApi.deleteMember.mockResolvedValue(undefined);
    renderWithProviders(<MemberManager />);

    await screen.findByText("Jonas");
    await userEvent.click(screen.getByRole("button", { name: "Löschen" }));

    expect(window.confirm).toHaveBeenCalledWith("Person endgültig löschen?");
    await waitFor(() => expect(mockedApi.deleteMember).toHaveBeenCalledWith(9));
    expect(await screen.findByText("Noch keine Personen angelegt.")).toBeInTheDocument();
  });

  it("löscht keine Person, wenn die Bestätigung abgelehnt wird", async () => {
    const member = makeMember({ id: 11, name: "Alex" });
    vi.spyOn(window, "confirm").mockReturnValue(false);
    mockedApi.getMembers.mockResolvedValue([member]);
    renderWithProviders(<MemberManager />);

    await screen.findByText("Alex");
    await userEvent.click(within(screen.getByText("Alex").closest("li")!).getByRole("button", { name: "Löschen" }));

    expect(mockedApi.deleteMember).not.toHaveBeenCalled();
    expect(screen.getByText("Alex")).toBeInTheDocument();
  });
});
