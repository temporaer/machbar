import { describe, expect, it } from "vitest";
import { cleanupResolutionSurfaces } from "@machbar/shared";
import {
  cleanupAnswerSurface,
  cleanupDefaultAnswer,
  cleanupSurfaceAction,
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

  it("gives every surface a real destination, an honest label, or no extra button", () => {
    for (const target of [task, project, { ...project, itemStatus: "backlog" }]) {
      for (const surface of cleanupResolutionSurfaces) {
        const action = cleanupSurfaceAction(target, { resolutionSurface: surface, suggestedShape: null }, "Antwort");
        if (surface === "mark_reviewed") {
          expect(action).toEqual({ kind: "markReviewed" });
          continue;
        }
        if (action.kind === "markReviewed") throw new Error("unexpected");
        // Text surfaces always get their own labelled destination.
        if (cleanupAnswerSurface(surface)) expect(action.label).not.toBeNull();
        // A null label is only ever a plain open (covered by the card's Öffnen).
        if (action.label === null) {
          expect(action).toMatchObject({ kind: "command", command: { type: "workItem.open" } });
          expect(action.kind === "command" && "focusField" in action.command).toBe(false);
        }
      }
    }
  });

  it("carries the edited answer into task destinations as an unsaved draft", () => {
    const at = (surface: (typeof cleanupResolutionSurfaces)[number], answer: string) =>
      cleanupSurfaceAction(task, { resolutionSurface: surface, suggestedShape: null }, answer);
    expect(at("create_decision_task", " Entscheiden: Modell ")).toEqual({
      kind: "command",
      label: "decision",
      command: { type: "task.split", taskId: 7, initialTitles: ["Entscheiden: Modell"] },
    });
    expect(at("create_followup", "Nachhalten: Versicherung")).toMatchObject({
      label: "followup",
      command: { type: "task.split", initialTitles: ["Nachhalten: Versicherung"] },
    });
    expect(at("rename_item", "Backup-Status prüfen")).toEqual({
      kind: "command",
      label: "rename",
      command: { type: "task.open", taskId: 7, focusField: "title", draft: "Backup-Status prüfen" },
    });
    expect(at("edit_done_when", "Erledigt, wenn: Tür dicht")).toEqual({
      kind: "command",
      label: "doneWhenNotes",
      command: { type: "task.open", taskId: 7, focusField: "notes", draft: "Erledigt, wenn: Tür dicht" },
    });
    expect(at("clarify_admin_target", "An die Kita")).toEqual({
      kind: "command",
      label: "adminNotes",
      command: { type: "task.open", taskId: 7, focusField: "notes", draft: "An die Kita" },
    });
    // Empty answers open the editor without a draft.
    expect(at("rename_item", "  ")).toMatchObject({ command: { type: "task.open", focusField: "title" } });
    expect(at("rename_item", "  ")).not.toHaveProperty("command.draft");
    // No conversion exists: reference is an honest check without a draft.
    expect(at("convert_to_reference", "ignored")).toEqual({
      kind: "command",
      label: "checkReference",
      command: { type: "task.open", taskId: 7, focusField: "notes" },
    });
    expect(at("define_rhythm_or_revisit", "monatlich")).toEqual({
      kind: "command", label: "planTask", command: { type: "task.plan", taskId: 7 },
    });
    expect(at("split_clarify_execute", "")).toMatchObject({ label: "structure", command: { type: "task.structure" } });
  });

  it("only offers a real shape change where one exists", () => {
    const shape = (
      suggestedShape: "task" | "project" | "reference" | null,
      target: typeof task | typeof project = task,
    ) =>
      cleanupSurfaceAction(target, { resolutionSurface: "choose_shape", suggestedShape });
    expect(shape("project")).toMatchObject({ label: "convertToProject", command: { type: "task.convertToProject" } });
    expect(shape(null)).toMatchObject({ label: "convertToProject" });
    expect(shape("reference")).toMatchObject({ label: "checkReference", command: { focusField: "notes" } });
    expect(shape("task")).toMatchObject({ label: null, command: { type: "workItem.open" } });
    expect(shape("task", project)).toMatchObject({ label: null });
    expect(shape("reference", project)).toMatchObject({ label: "checkReference" });
  });

  it("routes project surfaces to project workflows with the answer as draft", () => {
    const at = (surface: (typeof cleanupResolutionSurfaces)[number], answer = "", target = project) =>
      cleanupSurfaceAction(target, { resolutionSurface: surface, suggestedShape: null }, answer);
    expect(at("edit_done_when", "Tür ist montiert")).toEqual({
      kind: "story", command: "story.editOutcome", projectId: 3, label: "doneWhenCriterion", draft: "Tür ist montiert",
    });
    expect(at("create_first_slice", "Angebote vergleichen")).toEqual({
      kind: "story", command: "story.planWork", projectId: 3, label: "firstSlice", draft: "Angebote vergleichen",
    });
    expect(at("create_followup", "Nachhalten: Rechnung")).toMatchObject({
      command: "story.planWork", label: "followup", draft: "Nachhalten: Rechnung",
    });
    expect(at("create_decision_task", "Entscheiden: Material")).toMatchObject({
      command: "story.planWork", label: "decision", draft: "Entscheiden: Material",
    });
    expect(at("rename_item", "Neue Haustür montieren")).toEqual({
      kind: "command",
      label: "rename",
      command: { type: "workItem.open", workItem: { id: 3, role: "story" }, focusField: "title", draft: "Neue Haustür montieren" },
    });
    expect(at("clarify_admin_target", "Empfänger: Vermieter")).toMatchObject({
      label: "adminNotes", command: { focusField: "notes", draft: "Empfänger: Vermieter" },
    });
    // Wiedervorlage is backlog-only; active projects only open their page.
    expect(at("define_rhythm_or_revisit")).toMatchObject({ label: null, command: { type: "workItem.open" } });
    expect(at("define_rhythm_or_revisit", "", { ...project, itemStatus: "backlog" }))
      .toEqual({ kind: "story", command: "story.defer", projectId: 3, label: "deferProject" });
    expect(at("convert_to_reference")).toMatchObject({ label: "checkReference" });
  });
});
