import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/testUtils";
import { api } from "../lib/api";
import { useRefresh } from "../lib/refresh";
import { AiContextPage } from "./AiContextPage";
import type { HouseholdAiContext } from "@machbar/shared";

vi.mock("../lib/api", () => ({
  api: {
    getAuthStatus: vi.fn().mockResolvedValue({
      enabled: false,
      authenticated: false,
      member: null,
    }),
    getMembers: vi.fn().mockResolvedValue([]),
    getHouseholdAiContext: vi.fn(),
    updateHouseholdAiContext: vi.fn(),
  },
}));

function RefreshButton() {
  const { bump } = useRefresh();
  return <button onClick={bump}>Refresh</button>;
}

describe("AiContextPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getHouseholdAiContext).mockImplementation(async () => ({
      householdDescription: "Bestehender Kontext",
      longTermDirection: null,
      suggestionGuidance: null,
    }));
    vi.mocked(api.updateHouseholdAiContext).mockImplementation(async (input) => ({
      householdDescription: input.householdDescription?.trim() || null,
      longTermDirection: input.longTermDirection?.trim() || null,
      suggestionGuidance: input.suggestionGuidance?.trim() || null,
    }));
  });

  it("edits all context fields and saves the shared household context", async () => {
    const user = userEvent.setup();
    renderWithProviders(<AiContextPage />);

    const household = await screen.findByLabelText("Haushaltsbeschreibung");
    const direction = screen.getByLabelText("Langfristige Ausrichtung");
    const guidance = screen.getByLabelText("Hinweise für KI-Vorschläge");

    await waitFor(() => expect(household).toHaveValue("Bestehender Kontext"));
    await user.clear(household);
    await user.type(household, "  Lea und Jonas  ");
    await user.type(direction, "Familienlogistik");
    await user.type(guidance, "Kleine Schritte");
    await user.click(screen.getByRole("button", { name: "Speichern" }));

    expect(api.updateHouseholdAiContext).toHaveBeenCalledWith({
      householdDescription: "  Lea und Jonas  ",
      longTermDirection: "Familienlogistik",
      suggestionGuidance: "Kleine Schritte",
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Gespeichert.");
  });

  it("clears the local draft without calling the API", async () => {
    const user = userEvent.setup();
    renderWithProviders(<AiContextPage />);
    const household = await screen.findByLabelText("Haushaltsbeschreibung");

    await user.click(screen.getByRole("button", { name: "Entwurf leeren" }));

    expect(household).toHaveValue("");
    expect(api.updateHouseholdAiContext).not.toHaveBeenCalled();
  });

  it("preserves edits in every field while a background refetch is pending and after it finishes", async () => {
    const user = userEvent.setup();
    renderWithProviders(<><AiContextPage /><RefreshButton /></>);
    const household = screen.getByLabelText("Haushaltsbeschreibung");
    const direction = screen.getByLabelText("Langfristige Ausrichtung");
    const guidance = screen.getByLabelText("Hinweise für KI-Vorschläge");
    await waitFor(() => expect(household).toHaveValue("Bestehender Kontext"));

    await user.clear(household);
    await user.type(household, "Mein Entwurf");
    await user.type(direction, "Meine Richtung");
    await user.type(guidance, "Meine Hinweise");
    let resolveRefresh!: (context: HouseholdAiContext) => void;
    vi.mocked(api.getHouseholdAiContext).mockReturnValueOnce(new Promise((resolve) => {
      resolveRefresh = resolve;
    }));
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(household).toBeEnabled();
    await user.type(household, " bleibt");

    await act(async () => resolveRefresh({
      householdDescription: "Anderer Serverkontext",
      longTermDirection: "Andere Richtung",
      suggestionGuidance: "Andere Hinweise",
    }));

    expect(household).toHaveValue("Mein Entwurf bleibt");
    expect(direction).toHaveValue("Meine Richtung");
    expect(guidance).toHaveValue("Meine Hinweise");
  });

  it("preserves a cleared draft across a background refetch", async () => {
    const user = userEvent.setup();
    renderWithProviders(<><AiContextPage /><RefreshButton /></>);
    const household = screen.getByLabelText("Haushaltsbeschreibung");
    await waitFor(() => expect(household).toHaveValue("Bestehender Kontext"));

    await user.click(screen.getByRole("button", { name: "Entwurf leeren" }));
    await user.click(screen.getByRole("button", { name: "Refresh" }));

    expect(api.getHouseholdAiContext).toHaveBeenCalledTimes(2);
    for (const field of screen.getAllByRole("textbox")) {
      expect(field).toHaveValue("");
    }
    expect(api.updateHouseholdAiContext).not.toHaveBeenCalled();
  });

  it("preserves an unsaved draft after a failed save and background refetch", async () => {
    const user = userEvent.setup();
    vi.mocked(api.updateHouseholdAiContext).mockRejectedValueOnce(new Error("Save failed"));
    renderWithProviders(<><AiContextPage /><RefreshButton /></>);
    const household = screen.getByLabelText("Haushaltsbeschreibung");
    await waitFor(() => expect(household).toHaveValue("Bestehender Kontext"));

    await user.clear(household);
    await user.type(household, "Ungespeicherter Entwurf");
    await user.click(screen.getByRole("button", { name: "Speichern" }));
    expect(await screen.findByRole("alert")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Refresh" }));

    expect(api.getHouseholdAiContext).toHaveBeenCalledTimes(2);
    expect(household).toHaveValue("Ungespeicherter Entwurf");
  });

  it("applies the save response without letting an older refetch overwrite it or subsequent edits", async () => {
    const user = userEvent.setup();
    renderWithProviders(<><AiContextPage /><RefreshButton /></>);
    const household = screen.getByLabelText("Haushaltsbeschreibung");
    await waitFor(() => expect(household).toHaveValue("Bestehender Kontext"));

    await user.clear(household);
    await user.type(household, "  Neuer Kontext  ");
    let resolveRefresh!: (context: HouseholdAiContext) => void;
    vi.mocked(api.getHouseholdAiContext).mockReturnValueOnce(new Promise((resolve) => {
      resolveRefresh = resolve;
    }));
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await user.click(screen.getByRole("button", { name: "Speichern" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Gespeichert.");
    expect(household).toHaveValue("Neuer Kontext");

    await act(async () => resolveRefresh({
      householdDescription: "Bestehender Kontext",
      longTermDirection: null,
      suggestionGuidance: null,
    }));
    expect(household).toHaveValue("Neuer Kontext");

    await user.type(household, " mit weiteren Änderungen");
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(api.getHouseholdAiContext).toHaveBeenCalledTimes(3);
    expect(household).toHaveValue("Neuer Kontext mit weiteren Änderungen");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
