import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "../test/testUtils";
import { ProjectCard } from "./ProjectCard";
import { api } from "../lib/api";
import { makeCriterion, makeMember, makeProject } from "../test/fixtures";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

describe("ProjectCard", () => {
  it("zeigt keine Beschreibung mehr an, sondern den Fortschritt der Akzeptanzkriterien getrennt von den Aufgaben", async () => {
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1, name: "Mira" })]);
    const project = makeProject({
      title: "Umzug organisieren",
      openCount: 2,
      doneCount: 2,
      acceptanceCriteria: [
        makeCriterion({ checked: true }),
        makeCriterion({ checked: false }),
        makeCriterion({ checked: false }),
      ],
    });
    renderWithProviders(<ProjectCard project={project} />);

    expect(await screen.findByText("Umzug organisieren")).toBeInTheDocument();
    expect(screen.getByText("Akzeptanzkriterien: 1/3")).toBeInTheDocument();
    expect(screen.queryByText(/^Beispielprojekt$/)).not.toBeInTheDocument();
  });

  it("zeigt keinen Kriterien-Fortschritt an, wenn das Projekt keine Akzeptanzkriterien hat", async () => {
    mockedApi.getMembers.mockResolvedValue([]);
    const project = makeProject({ title: "Ohne Kriterien", acceptanceCriteria: [] });
    renderWithProviders(<ProjectCard project={project} />);

    expect(await screen.findByText("Ohne Kriterien")).toBeInTheDocument();
    expect(screen.queryByText(/Akzeptanzkriterien:/)).not.toBeInTheDocument();
  });
});
