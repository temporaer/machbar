import { describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { render, screen } from "@testing-library/react";
import { StuckProjectList } from "./StuckProjectList";
import { makeStuckProject } from "../test/fixtures";

describe("StuckProjectList", () => {
  it("zeigt Festgefahren-Gründe und Reparaturvorschläge auf Deutsch", () => {
    const project = makeStuckProject({
      title: "Umzug organisieren",
      stuckReason: "blocked_dependencies",
    });
    render(
      <MemoryRouter>
        <StuckProjectList projects={[project]} />
      </MemoryRouter>,
    );

    expect(screen.getByText("Umzug organisieren")).toBeInTheDocument();
    expect(screen.getByText("Durch Abhängigkeiten blockiert")).toBeInTheDocument();
    expect(
      screen.getByText(/Prüfe die konkret blockierenden Voraussetzungen/),
    ).toBeInTheDocument();
  });

  it("zeigt einen leeren Zustand ohne festgefahrene Projekte", () => {
    render(
      <MemoryRouter>
        <StuckProjectList projects={[]} />
      </MemoryRouter>,
    );
    expect(screen.getByText("Keine Projekte vorhanden.")).toBeInTheDocument();
  });
});
