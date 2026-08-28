import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "@machbar/shared";
import { ActivityFeed } from "./ActivityFeed";
import { LocaleProvider } from "../lib/locale";

function event(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: 1,
    createdAt: new Date(2026, 7, 27, 18, 0).toISOString(),
    kind: "task_created",
    actor: {
      id: 7,
      name: "Mira Muster",
      color: "#123456",
      pictureUrl: null,
    },
    entity: { type: "task", title: "Kisten packen", taskId: 42, projectId: 9 },
    metadata: {},
    ...overrides,
  };
}

describe("ActivityFeed", () => {
  it("groups newest-first events into Heute, Gestern, and calendar dates", () => {
    const now = new Date(2026, 7, 27, 20, 30);
    render(
      <MemoryRouter>
        <ActivityFeed
          now={now}
          events={[
            event(),
            event({ id: 2, createdAt: new Date(2026, 7, 26, 12, 0).toISOString() }),
            event({ id: 3, createdAt: new Date(2026, 7, 24, 12, 0).toISOString() }),
          ]}
        />
      </MemoryRouter>,
    );

    expect(screen.getAllByRole("heading").map((heading) => heading.textContent)).toEqual([
      "Heute",
      "Gestern",
      "24. August 2026",
    ]);
  });

  it("shows actor, formatted action, live task link, and accessible exact time", () => {
    const now = new Date(2026, 7, 27, 20, 0);
    render(
      <MemoryRouter>
        <ActivityFeed
          now={now}
          events={[
            event({
              kind: "task_status_changed",
              metadata: { previousStatus: "actionable", nextStatus: "done" },
            }),
          ]}
        />
      </MemoryRouter>,
    );

    const row = screen.getByRole("listitem");
    expect(within(row).getByText("Mira Muster")).toBeInTheDocument();
    expect(within(row).getByText(/Status von „Machbar“ auf „Erledigt“/)).toBeInTheDocument();
    expect(within(row).getByRole("link", { name: "Kisten packen" })).toHaveAttribute(
      "href",
      "/tasks/42",
    );
    expect(within(row).getByText("vor 2 Stunden")).toHaveAccessibleName(
      /vor 2 Stunden; 27\.08\.2026, 18:00/,
    );
  });

  it("formats grouping, status descriptions, and relative time in English", () => {
    const now = new Date(2026, 7, 27, 20, 0);
    render(
      <LocaleProvider initialLocale="en">
        <MemoryRouter>
          <ActivityFeed
            now={now}
            events={[
              event({
                kind: "task_status_changed",
                metadata: {
                  previousStatus: "actionable",
                  nextStatus: "done",
                },
              }),
            ]}
          />
        </MemoryRouter>
      </LocaleProvider>,
    );

    expect(screen.getByRole("heading", { name: "Today" })).toBeInTheDocument();
    expect(
      screen.getByText(/changed the status from “Ready” to “Done”/),
    ).toBeInTheDocument();
    expect(screen.getByText("2 hours ago")).toBeInTheDocument();
  });

  it("keeps deleted entities readable and uses the unknown actor fallback", () => {
    render(
      <MemoryRouter>
        <ActivityFeed
          now={new Date(2026, 7, 27, 20, 0)}
          events={[
            event({
              kind: "project_deleted",
              actor: null,
              entity: {
                type: "project",
                title: "Altes Projekt",
                taskId: null,
                projectId: null,
              },
            }),
          ]}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("Unbekannt")).toBeInTheDocument();
    expect(screen.getByText("Altes Projekt")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Altes Projekt" })).toBeNull();
    expect(screen.getByText(/Projekt gelöscht/)).toBeInTheDocument();
  });

  it("links live projects to their project page", () => {
    render(
      <MemoryRouter>
        <ActivityFeed
          events={[
            event({
              kind: "project_updated",
              entity: {
                type: "project",
                title: "Umzug",
                taskId: null,
                projectId: 9,
              },
              metadata: { changedFields: ["notes"] },
            }),
          ]}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "Umzug" })).toHaveAttribute(
      "href",
      "/projects/9",
    );
    expect(screen.getByText(/aktualisiert: Notizen/)).toBeInTheDocument();
  });

  it("describes same-project parent moves using the destination parent", () => {
    render(
      <MemoryRouter>
        <ActivityFeed
          events={[
            event({
              kind: "task_moved",
              metadata: {
                relatedTaskIds: [81],
                relatedTaskTitles: ["Neuer Parent"],
              },
            }),
          ]}
        />
      </MemoryRouter>,
    );

    expect(
      screen.getByText(/Aufgabe nach „Neuer Parent“ verschoben/),
    ).toBeInTheDocument();
  });

  it("describes a single descendant-only completion without a root transition", () => {
    render(
      <MemoryRouter>
        <ActivityFeed
          events={[
            event({
              kind: "task_descendants_status_changed",
              metadata: { nextStatus: "done", affectedCount: 1 },
            }),
          ]}
        />
      </MemoryRouter>,
    );

    expect(
      screen.getByText(/eine Teilaufgabe auf „Erledigt“ gesetzt/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Status von/)).toBeNull();
  });

  it.each([
    { checked: true, description: /Ergebniskriterium abgehakt/ },
    { checked: false, description: /Ergebniskriterium wieder geöffnet/ },
  ])(
    "describes acceptance criterion checked=$checked accurately",
    ({ checked, description }) => {
      render(
        <MemoryRouter>
          <ActivityFeed
            events={[
              event({
                kind: "project_acceptance_criterion_checked",
                entity: {
                  type: "project",
                  title: "Umzug",
                  taskId: null,
                  projectId: 9,
                },
                metadata: { checked },
              }),
            ]}
          />
        </MemoryRouter>,
      );

      expect(screen.getByText(description)).toBeInTheDocument();
    },
  );
});
