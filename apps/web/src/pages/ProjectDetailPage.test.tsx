import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../lib/api";
import { makeMember, makeProject, makeTask } from "../test/fixtures";
import { renderWithProviders } from "../test/testUtils";
import { ProjectDetailPage } from "./ProjectDetailPage";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    getProject: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

describe("ProjectDetailPage task explanations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1, name: "Mira" })]);
    mockedApi.getProject.mockResolvedValue({
      ...makeProject({ id: 42, title: "Sommerfest planen", ownerMemberId: 1 }),
      tasks: [makeTask({ id: 7, projectId: 42, title: "Ort reservieren" })],
    });
  });

  it("opens and closes the project task hints with the shared info control", async () => {
    renderWithProviders(<ProjectDetailPage />);

    expect(await screen.findByText("Ort reservieren")).toBeInTheDocument();
    const gestureHint =
      "Nach rechts wischen: „Erledigen / Wieder öffnen“. Nach links wischen öffnet weitere Aktionen wie Zuweisen, Planen und Notizen. Am Desktop geht das auch über ⋯.";
    const dragHint = "Griff ziehen oder lange drücken: Aufgabe verschieben";
    const button = screen.getByRole("button", {
      name: "Hinweise zu dieser Seite anzeigen",
    });

    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(gestureHint)).not.toBeInTheDocument();
    expect(screen.queryByText(dragHint)).not.toBeInTheDocument();

    await userEvent.click(button);

    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(button).toHaveAccessibleName("Hinweise zu dieser Seite ausblenden");
    expect(screen.getByText(gestureHint)).toBeInTheDocument();
    expect(screen.getByText(dragHint)).toBeInTheDocument();

    await userEvent.click(button);

    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(gestureHint)).not.toBeInTheDocument();
    expect(screen.queryByText(dragHint)).not.toBeInTheDocument();
  });
});
