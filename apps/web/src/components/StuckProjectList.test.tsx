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
      repairAction: "Löse die blockierende Abhängigkeit auf.",
    });
    render(
      <MemoryRouter>
        <StuckProjectList projects={[project]} />
      </MemoryRouter>,
    );

    expect(screen.getByText("Umzug organisieren")).toBeInTheDocument();
    expect(screen.getByText("Durch Abhängigkeiten blockiert")).toBeInTheDocument();
    expect(screen.getByText(/Löse die blockierende Abhängigkeit auf\./)).toBeInTheDocument();
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
