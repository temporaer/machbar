import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/testUtils";
import { IdentitySelector } from "./IdentitySelector";
import { api } from "../lib/api";
import { makeMember } from "../test/fixtures";
import {
  readRequestActorMemberId,
  SELECTED_MEMBER_STORAGE_KEY,
  setRequestActorMemberId,
} from "../lib/identityStorage";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    createMember: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

describe("IdentitySelector", () => {
  beforeEach(() => {
    window.localStorage.clear();
    setRequestActorMemberId(null);
    vi.clearAllMocks();
  });

  it("zeigt alle Personen zur Auswahl (Wer bist du?)", async () => {
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1, name: "Mira" }), makeMember({ id: 2, name: "Jonas" })]);
    renderWithProviders(<IdentitySelector />);

    expect(await screen.findByText("Mira")).toBeInTheDocument();
    expect(screen.getByText("Jonas")).toBeInTheDocument();
  });

  it("wählt eine Person per Klick aus", async () => {
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1, name: "Mira" })]);
    renderWithProviders(<IdentitySelector />);

    const option = await screen.findByRole("option", { name: /Mira/ });
    await userEvent.click(option);

    await waitFor(() => expect(option).toHaveAttribute("aria-selected", "true"));
    expect(window.localStorage.getItem("machbar:identity-member-id")).toBe("1");
  });

  it("legt auf einer leeren Installation die erste Person an und wählt sie sofort aus", async () => {
    const hannes = makeMember({ id: 7, name: "Hannes" });
    mockedApi.getMembers.mockResolvedValueOnce([]).mockResolvedValueOnce([hannes]);
    mockedApi.createMember.mockResolvedValue(hannes);
    renderWithProviders(<IdentitySelector />);

    expect(await screen.findByText("Noch ist niemand angelegt. Erstelle die erste Person, um Machbar zu starten."))
      .toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: "Name" }), "Hannes");
    await userEvent.click(screen.getByRole("button", { name: "Person hinzufügen" }));

    await waitFor(() => expect(mockedApi.createMember).toHaveBeenCalledWith({ name: "Hannes" }));
    await waitFor(() => expect(window.localStorage.getItem("machbar:identity-member-id")).toBe("7"));
    expect(await screen.findByRole("option", { name: /Hannes/ })).toHaveAttribute("aria-selected", "true");
  });

  it("zeigt einen Fehler und behält den Namen, wenn das Bootstrap-Anlegen fehlschlägt", async () => {
    mockedApi.getMembers.mockResolvedValue([]);
    mockedApi.createMember.mockRejectedValue(new Error("Name bereits vergeben"));
    renderWithProviders(<IdentitySelector />);

    const input = await screen.findByRole("textbox", { name: "Name" });
    await userEvent.type(input, "Hannes");
    await userEvent.click(screen.getByRole("button", { name: "Person hinzufügen" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Name bereits vergeben");
    expect(input).toHaveValue("Hannes");
  });

  it("verwirft eine ausgewählte Person, die nach einer Löschung nicht mehr in der Liste ist", async () => {
    window.localStorage.setItem("machbar:identity-member-id", "1");
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 2, name: "Jonas" })]);
    renderWithProviders(<IdentitySelector />);

    const option = await screen.findByRole("option", { name: /Jonas/ });
    await waitFor(() => expect(option).toHaveAttribute("aria-selected", "false"));
    await waitFor(() => expect(window.localStorage.getItem("machbar:identity-member-id")).toBeNull());
  });

  it("synchronisiert sichtbare Identität und Mutation-Attribution zwischen Tabs", async () => {
    const mira = makeMember({ id: 1, name: "Mira" });
    const jonas = makeMember({ id: 2, name: "Jonas" });
    window.localStorage.setItem(SELECTED_MEMBER_STORAGE_KEY, "1");
    mockedApi.getMembers.mockResolvedValue([mira, jonas]);
    renderWithProviders(<IdentitySelector />);

    const miraOption = await screen.findByRole("option", { name: /Mira/ });
    const jonasOption = screen.getByRole("option", { name: /Jonas/ });
    await waitFor(() => {
      expect(miraOption).toHaveAttribute("aria-selected", "true");
      expect(readRequestActorMemberId()).toBe(1);
    });

    window.localStorage.setItem(SELECTED_MEMBER_STORAGE_KEY, "2");
    expect(readRequestActorMemberId()).toBe(1);
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: SELECTED_MEMBER_STORAGE_KEY,
          oldValue: "1",
          newValue: "2",
          storageArea: window.localStorage,
        }),
      );
    });

    await waitFor(() => {
      expect(miraOption).toHaveAttribute("aria-selected", "false");
      expect(jonasOption).toHaveAttribute("aria-selected", "true");
      expect(readRequestActorMemberId()).toBe(2);
    });

    window.localStorage.clear();
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: null,
          oldValue: null,
          newValue: null,
          storageArea: window.localStorage,
        }),
      );
    });

    await waitFor(() => {
      expect(jonasOption).toHaveAttribute("aria-selected", "false");
      expect(readRequestActorMemberId()).toBeNull();
    });
  });
});
