import { describe, expect, it } from "vitest";
import { cleanupResolutionSurfaces } from "@machbar/shared";
import {
  cleanupAnswerSurface,
  cleanupDefaultAnswer,
  cleanupSurfaceAction,
  cleanupSurfaceIsPlainOpen,
} from "./cleanupRound";

const prefixes = { decision: "Entscheiden", followup: "Nachhalten", doneWhen: "Erledigt, wenn" };
const task = { targetType: "task" as const, targetId: 7, itemStatus: "actionable" };
const project = { targetType: "project" as const, targetId: 3, itemStatus: "active" };

function result(
  resolutionSurface: (typeof cleanupResolutionSurfaces)[number],
  suggestedDefault: string | null = "Modell",
  suggestedTitle: string | null = null,
) {
  return { resolutionSurface, suggestedDefault, suggestedTitle };
}

describe("cleanup round surfaces", () => {
  it("derives an editable default answer for text-shaped surfaces", () => {
    expect(cleanupDefaultAnswer(task, result("create_decision_task"), prefixes)).toBe("Entscheiden: Modell");
    expect(cleanupDefaultAnswer(task, result("create_followup"), prefixes)).toBe("Nachhalten: Modell");
    expect(cleanupDefaultAnswer(task, result("create_first_slice"), prefixes)).toBe("Modell");
    expect(cleanupDefaultAnswer(task, result("create_decision_task", null), prefixes)).toBe("");
    expect(cleanupDefaultAnswer(task, result("rename_item", "x", "Backup-Status prüfen"), prefixes))
      .toBe("Backup-Status prüfen");
    expect(cleanupDefaultAnswer(task, result("edit_done_when"), prefixes)).toBe("Erledigt, wenn: Modell");
    expect(cleanupDefaultAnswer(project, result("edit_done_when"), prefixes)).toBe("Modell");
    expect(cleanupDefaultAnswer(task, result("clarify_admin_target"), prefixes)).toBe("Modell");
    expect(cleanupAnswerSurface("convert_to_reference")).toBe(false);
    expect(cleanupAnswerSurface("clarify_admin_target")).toBe(true);
  });

  it("maps every task surface to review acknowledgement or an existing command", () => {
    for (const surface of cleanupResolutionSurfaces) {
      const action = cleanupSurfaceAction(task, surface, "Antwort");
      if (surface === "mark_reviewed") expect(action).toEqual({ kind: "markReviewed" });
      else expect(action.kind).toBe("command");
    }
  });

  it("carries the edited answer into task destinations as an unsaved draft", () => {
    expect(cleanupSurfaceAction(task, "create_decision_task", " Entscheiden: Modell ")).toEqual({
      kind: "command",
      command: { type: "task.split", taskId: 7, initialTitles: ["Entscheiden: Modell"] },
    });
    expect(cleanupSurfaceAction(task, "rename_item", "Backup-Status prüfen")).toEqual({
      kind: "command",
      command: { type: "task.open", taskId: 7, focusField: "title", draft: "Backup-Status prüfen" },
    });
    expect(cleanupSurfaceAction(task, "clarify_admin_target", "An die Kita")).toEqual({
      kind: "command",
      command: { type: "task.open", taskId: 7, focusField: "notes", draft: "An die Kita" },
    });
    // Empty answers open the editor without a draft.
    expect(cleanupSurfaceAction(task, "rename_item", "  ")).toEqual({
      kind: "command",
      command: { type: "task.open", taskId: 7, focusField: "title" },
    });
    expect(cleanupSurfaceAction(task, "convert_to_reference", "ignored")).toEqual({
      kind: "command",
      command: { type: "task.open", taskId: 7, focusField: "notes" },
    });
  });

  it("routes project surfaces to project workflows with the answer as draft", () => {
    expect(cleanupSurfaceAction(project, "edit_done_when", "Tür ist montiert")).toEqual({
      kind: "story", command: "story.editOutcome", projectId: 3, draft: "Tür ist montiert",
    });
    expect(cleanupSurfaceAction(project, "create_first_slice", "Angebote vergleichen")).toEqual({
      kind: "story", command: "story.planWork", projectId: 3, draft: "Angebote vergleichen",
    });
    expect(cleanupSurfaceAction(project, "rename_item", "Neue Haustür montieren")).toEqual({
      kind: "command",
      command: {
        type: "workItem.open",
        workItem: { id: 3, role: "story" },
        focusField: "title",
        draft: "Neue Haustür montieren",
      },
    });
    // Wiedervorlage is backlog-only; active projects only open their page.
    const open = cleanupSurfaceAction(project, "define_rhythm_or_revisit");
    expect(open).toEqual({ kind: "command", command: { type: "workItem.open", workItem: { id: 3, role: "story" } } });
    expect(cleanupSurfaceIsPlainOpen(open)).toBe(true);
    expect(cleanupSurfaceAction({ ...project, itemStatus: "backlog" }, "define_rhythm_or_revisit"))
      .toEqual({ kind: "story", command: "story.defer", projectId: 3 });
    expect(cleanupSurfaceIsPlainOpen(cleanupSurfaceAction(project, "convert_to_reference"))).toBe(false);
  });
});
