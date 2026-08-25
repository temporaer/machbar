import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProjectStuckNotice } from "./ProjectStuckNotice";

describe("ProjectStuckNotice", () => {
  it("puts the stuck reason and a concrete Machbar repair step above the task list", () => {
    render(<ProjectStuckNotice reason="no_next_action" />);

    expect(
      screen.getByRole("heading", { name: "Dieses Projekt ist festgefahren" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Kein nächster Schritt")).toBeInTheDocument();
    expect(
      screen.getByText(/Wische eine Aufgabe im Eingang nach rechts, um sie als Machbar zu markieren/),
    ).toBeInTheDocument();
  });

  it("gives process-specific guidance for waiting projects", () => {
    render(<ProjectStuckNotice reason="only_waiting" />);

    expect(screen.getByText("Nur wartende Aufgaben")).toBeInTheDocument();
    expect(screen.getByText(/Hake bei einer wartenden Aufgabe nach/)).toBeInTheDocument();
  });
});
