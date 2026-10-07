import { describe, expect, it } from "vitest";
import { cleanupResolutionSurfaces } from "@machbar/shared";
import {
  cleanupAnswerSurface,
  cleanupDefaultAnswer,
  cleanupSurfaceAction,
} from "./cleanupRound";

const prefixes = { decision: "Entscheiden", followup: "Nachhalten", doneWhen: "Erledigt, wenn" };
const task = { targetType: "task" as const, targetId: 7, itemStatus: "actionable", title: "Keller" };
const project = { targetType: "project" as const, targetId: 3, itemStatus: "active", title: "Haustür" };

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
    // The concrete admin wording goes to the title; the answer carries details only.
    expect(cleanupDefaultAnswer(task, result("clarify_admin_target", null, "Nachweis einreichen"), prefixes)).toBe("");
    expect(cleanupAnswerSurface("convert_to_reference")).toBe(false);
    expect(cleanupAnswerSurface("clarify_admin_target")).toBe(true);
  });

  it("gives every surface a real destination, an honest label, or no extra button", () => {
    for (const target of [task, project, { ...project, itemStatus: "backlog" }]) {
      for (const surface of cleanupResolutionSurfaces) {
        const action = cleanupSurfaceAction(target, { resolutionSurface: surface, suggestedShape: null, suggestedTitle: null }, "Antwort");
        if (surface === "mark_reviewed") {
          expect(action).toEqual({ kind: "markReviewed" });
          continue;
        }
        if (action.kind === "markReviewed") throw new Error("unexpected");
        // Text surfaces always become an explicit confirmation micro-flow.
        expect(action.kind === "confirm").toBe(cleanupAnswerSurface(surface));
        // A null label is only ever a plain open (covered by the card's Öffnen).
        if (action.label === null) {
          expect(action).toMatchObject({ kind: "command", command: { type: "workItem.open" } });
          expect(action.kind === "command" && "focusField" in action.command).toBe(false);
        }
      }
    }
  });

  it("turns text answers into explicit task micro-flows with the edited answer", () => {
    const at = (surface: (typeof cleanupResolutionSurfaces)[number], answer: string) =>
      cleanupSurfaceAction(task, { resolutionSurface: surface, suggestedShape: null, suggestedTitle: null }, answer);
    expect(at("create_decision_task", " Entscheiden: Modell ")).toEqual({
      kind: "confirm",
      label: "createChildTask",
      flow: { kind: "createTask", purpose: "decision", title: "Entscheiden: Modell" },
    });
    expect(at("create_first_slice", "Werkzeugecke sortieren")).toMatchObject({
      label: "createChildTask",
      flow: { kind: "createTask", purpose: "firstSlice", title: "Werkzeugecke sortieren" },
    });
    expect(at("create_followup", "Nachhalten: Versicherung")).toMatchObject({
      label: "createChildTask",
      flow: { kind: "createTask", purpose: "followup", title: "Nachhalten: Versicherung" },
    });
    expect(at("rename_item", "Backup-Status prüfen")).toEqual({
      kind: "confirm", label: "rename", flow: { kind: "rename", title: "Backup-Status prüfen" },
    });
    expect(at("edit_done_when", "Erledigt, wenn: Tür dicht")).toEqual({
      kind: "confirm", label: "doneWhenNotes", flow: { kind: "appendNotes", text: "Erledigt, wenn: Tür dicht" },
    });
    // Without a suggested title the admin flow keeps the current title.
    expect(at("clarify_admin_target", "Empfänger: Kita")).toEqual({
      kind: "confirm", label: "admin", flow: { kind: "clarifyAdmin", title: "Keller", notes: "Empfänger: Kita" },
    });
    expect(
      cleanupSurfaceAction(
        task,
        { resolutionSurface: "clarify_admin_target", suggestedShape: null, suggestedTitle: "Nachweis an Kita senden" },
        "",
      ),
    ).toMatchObject({ flow: { kind: "clarifyAdmin", title: "Nachweis an Kita senden", notes: "" } });
    // No action → reference conversion exists: an honest check, no mutation.
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
      cleanupSurfaceAction(target, { resolutionSurface: "choose_shape", suggestedShape, suggestedTitle: null });
    expect(shape("project")).toMatchObject({ label: "convertToProject", command: { type: "task.convertToProject" } });
    expect(shape(null)).toMatchObject({ label: "convertToProject" });
    expect(shape("reference")).toMatchObject({ label: "checkReference", command: { type: "task.open", focusField: "notes" } });
    expect(shape("task")).toMatchObject({ label: null, command: { type: "workItem.open" } });
    expect(shape("task", project)).toMatchObject({ label: null });
    expect(shape("reference", project)).toMatchObject({ label: "checkReference" });
  });

  it("uses the same micro-flows for projects and keeps other project surfaces honest", () => {
    const at = (surface: (typeof cleanupResolutionSurfaces)[number], answer = "", target = project) =>
      cleanupSurfaceAction(target, { resolutionSurface: surface, suggestedShape: null, suggestedTitle: null }, answer);
    expect(at("edit_done_when", "Tür ist montiert")).toEqual({
      kind: "confirm", label: "doneWhenCriterion", flow: { kind: "addCriterion", text: "Tür ist montiert" },
    });
    expect(at("create_first_slice", "Angebote vergleichen")).toMatchObject({
      label: "createProjectTask", flow: { kind: "createTask", purpose: "firstSlice", title: "Angebote vergleichen" },
    });
    expect(at("create_followup", "Nachhalten: Rechnung")).toMatchObject({
      label: "createProjectTask", flow: { kind: "createTask", title: "Nachhalten: Rechnung" },
    });
    expect(at("rename_item", "Neue Haustür montieren")).toMatchObject({
      label: "rename", flow: { kind: "rename", title: "Neue Haustür montieren" },
    });
    expect(at("clarify_admin_target", "Empfänger: Vermieter")).toMatchObject({
      label: "admin", flow: { kind: "clarifyAdmin", title: "Haustür", notes: "Empfänger: Vermieter" },
    });
    expect(at("split_clarify_execute")).toEqual({ kind: "story", command: "story.structure", projectId: 3, label: "structure" });
    // Wiedervorlage is backlog-only; active projects only open their page.
    expect(at("define_rhythm_or_revisit")).toMatchObject({ label: null, command: { type: "workItem.open" } });
    expect(at("define_rhythm_or_revisit", "", { ...project, itemStatus: "backlog" }))
      .toEqual({ kind: "story", command: "story.defer", projectId: 3, label: "deferProject" });
    expect(at("convert_to_reference")).toMatchObject({ label: "checkReference", command: { type: "workItem.open" } });
  });
});
