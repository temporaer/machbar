import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@machbar/shared";
import type { ProjectDetail } from "../lib/api";
import { makeProject, makeTask } from "../test/fixtures";
import { LocaleProvider } from "../lib/locale";
import { CompleteWithOpenTasksSheet } from "./CompleteWithOpenTasksSheet";

const retained = new Map<number, Task>();
const dispatch = vi.fn();
const requestCancel = vi.fn();

vi.mock("../lib/useTaskActions", () => ({
  useTaskActions: () => ({
    retained,
    pendingTask: null,
    pendingAction: null,
    requestCancel,
    resolvePolicy: vi.fn(),
    cancelPrompt: vi.fn(),
  }),
}));

vi.mock("../lib/useWorkItemCommands", () => ({
  useWorkItemCommands: () => ({ dispatch }),
}));

function renderSheet(tasks: Task[]) {
  const story: ProjectDetail = { ...makeProject({ id: 1, title: "Reise" }), tasks };
  return render(
    <LocaleProvider initialLocale="de">
      <CompleteWithOpenTasksSheet
        story={story}
        onClose={vi.fn()}
        onComplete={vi.fn().mockResolvedValue(undefined)}
      />
    </LocaleProvider>,
  );
}

describe("CompleteWithOpenTasksSheet", () => {
  beforeEach(() => {
    retained.clear();
    dispatch.mockClear();
    requestCancel.mockClear();
  });

  it("does not leave reconciliation work for a project containing only References", () => {
    renderSheet([
      makeTask({
        id: 1,
        kind: "reference",
        title: "Unterkunft",
        children: [],
      }),
    ]);

    expect(
      screen.getByText("Keine offenen Aufgaben mehr — bereit zum Abschließen."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Verschieben" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Projekt abschließen" })).toBeEnabled();
  });

  it("shows an open Action inside a Reference, never the Reference itself", () => {
    renderSheet([
      makeTask({
        id: 1,
        kind: "reference",
        title: "Unterkunft",
        children: [makeTask({ id: 2, title: "Hotel buchen" })],
      }),
    ]);

    expect(screen.getByText("Hotel buchen")).toBeInTheDocument();
    expect(screen.queryByText("Unterkunft")).not.toBeInTheDocument();
  });

  it("preserves deterministic Action ordering through nested References", () => {
    renderSheet([
      makeTask({
        id: 1,
        kind: "reference",
        title: "Reise",
        children: [
          makeTask({ id: 2, title: "Flug prüfen" }),
          makeTask({
            id: 3,
            kind: "reference",
            title: "Unterkunft",
            children: [
              makeTask({ id: 4, title: "Hotel buchen" }),
              makeTask({ id: 5, kind: "reference", title: "Details", children: [
                makeTask({ id: 6, title: "Frühstück reservieren" }),
              ] }),
            ],
          }),
        ],
      }),
    ]);

    expect(
      screen.getAllByRole("listitem").map((item) => item.textContent),
    ).toEqual([
      expect.stringContaining("Flug prüfen"),
      expect.stringContaining("Hotel buchen"),
      expect.stringContaining("Frühstück reservieren"),
    ]);
  });

  it("only offers cancel and move controls for Actions", () => {
    renderSheet([
      makeTask({
        id: 1,
        kind: "reference",
        title: "Unterkunft",
        children: [makeTask({ id: 2, title: "Hotel buchen" })],
      }),
    ]);

    expect(screen.getAllByRole("button", { name: "Verschieben" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Verwerfen" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Unterkunft/ })).not.toBeInTheDocument();
  });

  it("prefers a retained optimistic Action over the fetched Action", () => {
    const fetched = makeTask({ id: 2, title: "Alter Titel" });
    retained.set(2, makeTask({ id: 2, title: "Optimistischer Titel" }));
    renderSheet([fetched]);

    expect(screen.getByText("Optimistischer Titel")).toBeInTheDocument();
    expect(screen.queryByText("Alter Titel")).not.toBeInTheDocument();
  });
});
