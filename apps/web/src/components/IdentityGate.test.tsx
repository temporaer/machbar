import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../test/testUtils";
import { api } from "../lib/api";
import { makeMember } from "../test/fixtures";
import { IdentityGate } from "./IdentityGate";

vi.mock("../lib/api", () => ({
  api: {
    getAuthStatus: vi.fn(),
    getMembers: vi.fn(),
    logout: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

describe("IdentityGate with Pocket ID", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
    vi.clearAllMocks();
  });

  it("shows a Pocket ID sign-in action without loading household data", async () => {
    mockedApi.getAuthStatus.mockResolvedValue({
      enabled: true,
      authenticated: false,
      member: null,
    });

    renderWithProviders(
      <IdentityGate>
        <div>Privater Inhalt</div>
      </IdentityGate>,
    );

    expect(
      await screen.findByRole("button", { name: "Mit Pocket ID anmelden" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Privater Inhalt")).not.toBeInTheDocument();
    expect(mockedApi.getMembers).not.toHaveBeenCalled();
  });

  it("uses the server-bound member and renders the app after authentication", async () => {
    const member = makeMember({
      id: 7,
      name: "Hannes",
      managedByOidc: true,
    });
    mockedApi.getAuthStatus.mockResolvedValue({
      enabled: true,
      authenticated: true,
      member,
    });
    mockedApi.getMembers.mockResolvedValue([member]);

    renderWithProviders(
      <IdentityGate>
        <div>Privater Inhalt</div>
      </IdentityGate>,
    );

    expect(await screen.findByText("Privater Inhalt")).toBeInTheDocument();
    expect(window.localStorage.getItem("machbar:identity-member-id")).toBeNull();
  });

  it("shows a callback error beside the sign-in action and removes it from the URL", async () => {
    window.history.replaceState(
      null,
      "",
      "/?authError=Name%20bereits%20verkn%C3%BCpft#/heute",
    );
    mockedApi.getAuthStatus.mockResolvedValue({
      enabled: true,
      authenticated: false,
      member: null,
    });

    renderWithProviders(
      <IdentityGate>
        <div>Privater Inhalt</div>
      </IdentityGate>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Name bereits verknüpft",
    );
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("#/heute");
  });

  it("returns to sign-in when an API call reports an expired session", async () => {
    const member = makeMember({ id: 8, managedByOidc: true });
    mockedApi.getAuthStatus.mockResolvedValue({
      enabled: true,
      authenticated: true,
      member,
    });
    mockedApi.getMembers.mockResolvedValue([member]);
    renderWithProviders(
      <IdentityGate>
        <div>Privater Inhalt</div>
      </IdentityGate>,
    );
    await screen.findByText("Privater Inhalt");

    act(() => {
      window.dispatchEvent(new Event("machbar:authentication-required"));
    });

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Mit Pocket ID anmelden" }),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText("Privater Inhalt")).not.toBeInTheDocument();
  });
});
