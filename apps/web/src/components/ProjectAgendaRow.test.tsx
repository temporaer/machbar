import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import {
  makeMember,
  makeProject,
  makeTask,
} from "../test/fixtures";
import { ProjectAgendaRow } from "./ProjectAgendaRow";

describe("ProjectAgendaRow", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders a single-line row with title link and the due date for a due-date bucket", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 25, 12));

    render(
      <MemoryRouter>
        <ProjectAgendaRow
          entry={{
            project: makeProject({
              id: 42,
              title: "Sommerfest vorbereiten",
              dueDate: "2026-08-28",
            }),
            qualification: "due",
            attentionBucket: "dueSoon",
            nextAction: makeTask({ title: "Catering anrufen" }),
            nextActionContextAvailability: null,
            additionalNextActions: [],
            stuck: null,
          }}
        />
      </MemoryRouter>,
    );

    const projectLink = screen.getByRole("link", {
      name: "Sommerfest vorbereiten",
    });
    expect(projectLink).toHaveAttribute("href", "/projects/42");
    expect(screen.getByLabelText("Fällig: in 3 Tagen (28.08.2026)")).toBeInTheDocument();
    // The Next Action must never be duplicated inside the row — it already
    // has its own Task row elsewhere in Today when it qualifies today.
    expect(screen.queryByText(/Catering anrufen/)).not.toBeInTheDocument();
    expect(document.querySelector(".card")).toBeNull();
  });

  it("shows the scheduled/revisit date, not the due date, for a planned-bucket entry", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 25, 12));
    render(
      <MemoryRouter>
        <ProjectAgendaRow
          entry={{
            project: makeProject({
              scheduledDate: "2026-08-22",
              dueDate: "2026-08-20",
            }),
            qualification: "both",
            attentionBucket: "planned",
            nextAction: null,
            nextActionContextAvailability: null,
            additionalNextActions: [],
            stuck: null,
          }}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("seit 3 Tagen")).toBeInTheDocument();
    expect(screen.queryByText(/^Fällig:/)).not.toBeInTheDocument();
  });

  it("shows a compact owner cue only when a caller supplies one", () => {
    const owner = makeMember({ id: 7, name: "Mira" });
    const entry = {
      project: makeProject({ ownerMemberId: owner.id, dueDate: "2026-08-20" }),
      qualification: "due" as const,
      attentionBucket: "overdue" as const,
      nextAction: null,
      nextActionContextAvailability: null,
      additionalNextActions: [],
      stuck: null,
    };
    const { rerender } = render(
      <MemoryRouter>
        <ProjectAgendaRow entry={entry} />
      </MemoryRouter>,
    );

    expect(screen.queryByLabelText("Zuständig: Mira")).not.toBeInTheDocument();

    rerender(
      <MemoryRouter>
        <ProjectAgendaRow entry={entry} owner={owner} />
      </MemoryRouter>,
    );
    expect(screen.getByLabelText("Zuständig: Mira")).toContainElement(
      document.querySelector(".project-agenda-row-owner .avatar"),
    );
  });

  it("exposes a compact stuck cue as the one allowed secondary line", () => {
    render(
      <MemoryRouter>
        <ProjectAgendaRow
          entry={{
            project: makeProject({ dueDate: "2026-08-20" }),
            qualification: "due",
            attentionBucket: "overdue",
            nextAction: null,
            nextActionContextAvailability: null,
            additionalNextActions: [],
            stuck: { reason: "blocked_without_clear_path" },
          }}
        />
      </MemoryRouter>,
    );

    expect(
      screen.getByText(/Prüfe die konkret blockierenden Voraussetzungen/),
    ).toBeInTheDocument();
  });

  it("renders no stuck cue when the project is not stuck", () => {
    render(
      <MemoryRouter>
        <ProjectAgendaRow
          entry={{
            project: makeProject({ dueDate: "2026-08-20" }),
            qualification: "due",
            attentionBucket: "overdue",
            nextAction: null,
            nextActionContextAvailability: null,
            additionalNextActions: [],
            stuck: null,
          }}
        />
      </MemoryRouter>,
    );

    expect(document.querySelector(".project-agenda-row-stuck")).toBeNull();
  });
});
