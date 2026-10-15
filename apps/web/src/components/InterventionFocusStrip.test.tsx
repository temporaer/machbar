import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import type { AgendaIntervention, AgendaInterventionFocus } from "@machbar/shared";
import { renderWithProviders } from "../test/testUtils";
import { InterventionFocusStrip } from "./InterventionFocusStrip";

function makeIntervention(
  overrides: Partial<AgendaIntervention> = {},
): AgendaIntervention {
  return {
    goalId: 1,
    goalTitle: "Run a half marathon",
    goalArea: "work",
    interventionId: 10,
    revision: 1,
    type: "frequency_habit",
    commitment: "Run three times a week",
    startDate: "2026-01-01",
    revisitDate: "2026-01-15",
    periodDay: 6,
    periodLength: 14,
    derivedState: "running",
    withinReviewWindow: false,
    backing: null,
    ...overrides,
  };
}

function makeFocus(
  overrides: Partial<AgendaInterventionFocus> = {},
): AgendaInterventionFocus {
  return { running: [], review: [], ...overrides };
}

describe("InterventionFocusStrip", () => {
  it("renders nothing when there are no interventions", () => {
    const { container } = renderWithProviders(
      <InterventionFocusStrip focus={makeFocus()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a running experiment with its commitment and period progress", () => {
    renderWithProviders(
      <InterventionFocusStrip focus={makeFocus({ running: [makeIntervention()] })} />,
    );
    const strip = screen.getByTestId("intervention-focus");
    const running = within(strip).getByTestId("intervention-focus-running");
    expect(within(running).getByText("Run a half marathon")).toBeInTheDocument();
    expect(within(running).getByText("Run three times a week")).toBeInTheDocument();
    expect(within(running).getByText("Tag 6 von 14")).toBeInTheDocument();
    // It is a sibling section, never a task candidate.
    expect(running.closest(".task-row")).toBeNull();
  });

  it("shows no backing tally for an unbacked running experiment", () => {
    renderWithProviders(
      <InterventionFocusStrip focus={makeFocus({ running: [makeIntervention()] })} />,
    );
    expect(screen.queryByTestId("intervention-focus-backing")).toBeNull();
  });

  it("shows the hit/miss tally when the running experiment is backed", () => {
    renderWithProviders(
      <InterventionFocusStrip
        focus={makeFocus({
          running: [
            makeIntervention({ backing: { taskId: 77, hits: 4, misses: 1 } }),
          ],
        })}
      />,
    );
    const running = screen.getByTestId("intervention-focus-running");
    expect(
      within(running).getByTestId("intervention-focus-backing"),
    ).toHaveTextContent("Treffer 4 · Verpasst 1");
  });

  it("shows a review call-to-action linking to the Goals page for a finished experiment", () => {
    renderWithProviders(
      <InterventionFocusStrip
        focus={makeFocus({
          review: [
            makeIntervention({
              interventionId: 11,
              derivedState: "finished",
              withinReviewWindow: true,
            }),
          ],
        })}
      />,
    );
    const review = screen.getByTestId("intervention-focus-review");
    const cta = within(review).getByRole("link", {
      name: "Rückblick auf dein Experiment",
    });
    expect(cta).toHaveAttribute("href", "/more/goals");
    expect(screen.queryByTestId("intervention-focus-running")).toBeNull();
  });
});
