import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { makeMember, makeProject, makeTask } from "../test/fixtures";
import { ProjectAgendaCard } from "./ProjectAgendaCard";

describe("ProjectAgendaCard", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("combines review and due prompts and opens the project as its primary navigation", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 25, 12));

    render(
      <MemoryRouter>
        <ProjectAgendaCard
          entry={{
            project: makeProject({
              id: 42,
              title: "Sommerfest vorbereiten",
              scheduledDate: "2026-08-25",
              dueDate: "2026-08-28",
            }),
            qualification: "both",
            nextAction: makeTask({ title: "Catering anrufen" }),
            stuck: {
              reason: "blocked_without_clear_path",
            },
          }}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("Projekt prüfen & fällig")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sommerfest vorbereiten" })).toHaveAttribute(
      "href",
      "/projects/42",
    );
    expect(screen.getByText(/Catering anrufen/)).toBeInTheDocument();
    expect(
      screen.getByText(/Prüfe die konkret blockierenden Voraussetzungen/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Prüfen: heute (25.08.2026)")).toBeInTheDocument();
    expect(screen.getByLabelText("Fällig: in 3 Tagen (28.08.2026)")).toBeInTheDocument();
  });

  it("labels a schedule-only prompt as project review", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 25, 12));
    render(
      <MemoryRouter>
        <ProjectAgendaCard
          entry={{
            project: makeProject({ scheduledDate: "2026-08-22" }),
            qualification: "scheduled",
            nextAction: null,
            stuck: null,
          }}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("Projekt prüfen")).toBeInTheDocument();
    expect(screen.getByText("Prüfen: seit 3 Tagen")).toBeInTheDocument();
    expect(screen.queryByText(/^Fällig:/)).not.toBeInTheDocument();
  });

  it("shows a compact owner cue only when the household view supplies one", () => {
    const owner = makeMember({ id: 7, name: "Mira" });
    const entry = {
      project: makeProject({ ownerMemberId: owner.id }),
      qualification: "due" as const,
      nextAction: null,
      stuck: null,
    };
    const { rerender } = render(
      <MemoryRouter>
        <ProjectAgendaCard entry={entry} />
      </MemoryRouter>,
    );

    expect(screen.queryByLabelText("Zuständig: Mira")).not.toBeInTheDocument();

    rerender(
      <MemoryRouter>
        <ProjectAgendaCard entry={entry} owner={owner} />
      </MemoryRouter>,
    );
    expect(screen.getByLabelText("Zuständig: Mira")).toContainElement(
      document.querySelector(".project-agenda-owner .avatar"),
    );
  });
});
