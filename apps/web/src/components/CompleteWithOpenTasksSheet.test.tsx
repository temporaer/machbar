import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Task } from "@machbar/shared";
import type { ProjectDetail } from "../lib/api";
import { makeProject, makeTask } from "../test/fixtures";
import { LocaleProvider } from "../lib/locale";
import { CompleteWithOpenTasksSheet } from "./CompleteWithOpenTasksSheet";

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
    expect(screen.queryByRole("button", { name: "In Eingang verschieben" })).not.toBeInTheDocument();
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

    expect(screen.getAllByRole("button", { name: "In Eingang verschieben" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Verwerfen" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Unterkunft/ })).not.toBeInTheDocument();
  });

  it("does not persist task choices until project completion is submitted", async () => {
    const onComplete = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    const task = makeTask({ id: 2, title: "Hotel buchen" });
    const story: ProjectDetail = { ...makeProject({ id: 1, title: "Reise" }), tasks: [task] };
    render(<LocaleProvider initialLocale="de"><CompleteWithOpenTasksSheet story={story} onClose={onClose} onComplete={onComplete} /></LocaleProvider>);
    await userEvent.click(screen.getByRole("button", { name: "Verwerfen" }));
    expect(onComplete).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Projekt abschließen" }));
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
      expectedRevision: story.revision,
      expectedTaskRevisions: [{ taskId: task.id, revision: task.revision }],
      descendantResolutions: [{ taskId: task.id, action: "cancel", expectedRevision: task.revision }],
    }));
  });

  it("cancelling after a choice leaves completion unapplied", async () => {
    const onComplete = vi.fn();
    const onClose = vi.fn();
    const story: ProjectDetail = { ...makeProject({ id: 2, title: "Umzug" }), tasks: [makeTask({ id: 22, title: "Kisten packen" })] };
    render(<LocaleProvider initialLocale="de"><CompleteWithOpenTasksSheet story={story} onClose={onClose} onComplete={onComplete} /></LocaleProvider>);
    await userEvent.click(screen.getByRole("button", { name: "In Eingang verschieben" }));
    await userEvent.click(screen.getAllByRole("button", { name: "Schließen" }).at(-1)!);
    expect(onComplete).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
