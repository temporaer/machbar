import { describe, expect, it } from "vitest";
import { cleanupResolutionSurfaces } from "@machbar/shared";
import { cleanupChildTitle, cleanupSurfaceAction } from "./cleanupRound";

const prefixes = { decision: "Entscheiden", followup: "Nachhalten" };
const task = { targetType: "task" as const, targetId: 7, itemStatus: "actionable" };
const project = { targetType: "project" as const, targetId: 3, itemStatus: "active" };

function result(resolutionSurface: (typeof cleanupResolutionSurfaces)[number], suggestedDefault: string | null = "Modell") {
  return { resolutionSurface, suggestedDefault, suggestedTitle: null };
}

describe("cleanup round surfaces", () => {
  it("prefixes decision and follow-up child titles", () => {
    expect(cleanupChildTitle(result("create_decision_task"), prefixes)).toBe("Entscheiden: Modell");
    expect(cleanupChildTitle(result("create_followup"), prefixes)).toBe("Nachhalten: Modell");
    expect(cleanupChildTitle(result("create_first_slice"), prefixes)).toBe("Modell");
    expect(cleanupChildTitle(result("create_decision_task", null), prefixes)).toBeNull();
    expect(cleanupChildTitle(result("rename_item"), prefixes)).toBeNull();
  });

  it("maps every task surface to review acknowledgement or an existing command", () => {
    for (const surface of cleanupResolutionSurfaces) {
      const action = cleanupSurfaceAction(task, result(surface), prefixes);
      if (surface === "mark_reviewed") expect(action).toEqual({ kind: "markReviewed" });
      else expect(action.kind).toBe("command");
    }
    expect(cleanupSurfaceAction(task, result("create_decision_task"), prefixes)).toEqual({
      kind: "command",
      command: { type: "task.split", taskId: 7, initialTitles: ["Entscheiden: Modell"] },
    });
    expect(cleanupSurfaceAction(task, result("rename_item"), prefixes)).toEqual({
      kind: "command",
      command: { type: "task.open", taskId: 7, focusField: "title" },
    });
  });

  it("routes project surfaces to project workflows", () => {
    expect(cleanupSurfaceAction(project, result("edit_done_when"), prefixes)).toEqual({
      kind: "story", command: "story.editOutcome", projectId: 3,
    });
    expect(cleanupSurfaceAction(project, result("create_first_slice"), prefixes)).toEqual({
      kind: "story", command: "story.planWork", projectId: 3,
    });
    // Wiedervorlage is backlog-only; active projects open their detail page.
    expect(cleanupSurfaceAction(project, result("define_rhythm_or_revisit"), prefixes)).toEqual({
      kind: "command", command: { type: "workItem.open", workItem: { id: 3, role: "story" } },
    });
    expect(cleanupSurfaceAction({ ...project, itemStatus: "backlog" }, result("define_rhythm_or_revisit"), prefixes))
      .toEqual({ kind: "story", command: "story.defer", projectId: 3 });
  });
});
