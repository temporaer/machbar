import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/testUtils";
import { api } from "../lib/api";
import { AiContextPage } from "./AiContextPage";

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

describe("AiContextPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getHouseholdAiContext).mockResolvedValue({
      householdDescription: "Bestehender Kontext",
      longTermDirection: null,
      suggestionGuidance: null,
    });
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
});
