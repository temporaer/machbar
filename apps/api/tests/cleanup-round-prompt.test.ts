import { describe, expect, it } from "vitest";
import type { CleanupItemContext, CleanupProposalKind } from "@machbar/shared";
import { cleanupProposalKinds, cleanupResolutionSurfaces } from "@machbar/shared";
import { buildCleanupRoundInstructions } from "../src/cleanupRound/prompt.js";
import { validateCleanupRoundResponse } from "../src/cleanupRound/validate.js";

function fixture(targetId: number, title: string, targetType: "task" | "project" = "task"): CleanupItemContext {
  return {
    targetType,
    targetId,
    targetRevision: 1,
    item: { title, notes: null, status: targetType === "task" ? "actionable" : "backlog", ...(targetType === "task" ? { kind: "action" as const } : { acceptanceCriteria: [] }) },
    hierarchy: { projectTitle: null, parentTitle: null, childTitles: [], siblingTitles: [] },
    mechanicalFacts: {
      hasOwner: false,
      hasDueDate: false,
      hasScheduledDate: false,
      hasExternalWait: false,
      hasRevisitDate: false,
      isBlocked: false,
      isExecutable: true,
      graphNextActionTitle: null,
      stuckReason: null,
      childCount: 0,
      notesLength: 0,
      reviewedAt: null,
    },
  };
}

/**
 * Doctrine fixtures: the expected coaching direction for typical items.
 * The canned answers stand in for a provider response; the assertions
 * cover enum shape and resolution surface, not wording.
 */
const fixtures: Array<{
  item: CleanupItemContext;
  expected: CleanupProposalKind[];
  answer: { proposal: CleanupProposalKind; resolutionSurface: string; inferredWorkType: string };
}> = [
  { item: fixture(1, "Keller"), expected: ["identify_first_slice", "wrong_shape"], answer: { proposal: "identify_first_slice", resolutionSurface: "create_first_slice", inferredWorkType: "debt" } },
  { item: fixture(2, "Backup"), expected: ["define_check_or_rhythm", "rename_for_actionability"], answer: { proposal: "define_check_or_rhythm", resolutionSurface: "define_rhythm_or_revisit", inferredWorkType: "ops" } },
  { item: fixture(3, "Drucker geht nicht"), expected: ["clarify_next_decision"], answer: { proposal: "clarify_next_decision", resolutionSurface: "create_decision_task", inferredWorkType: "problem" } },
  { item: fixture(4, "Rohrbruch"), expected: ["add_followup_after_incident"], answer: { proposal: "add_followup_after_incident", resolutionSurface: "create_followup", inferredWorkType: "incident" } },
  {
    item: {
      ...fixture(5, "Haustür", "project"),
      planningContext: {
        currentNextAction: { id: 51, title: "Angebote einholen" },
        openChildren: [{ id: 51, title: "Angebote einholen" }],
        doneChildren: [{ id: 52, title: "Alte Tür entsorgt", status: "completed" }],
        existingAcceptanceCriteria: ["Tür ist montiert, dicht und bezahlt"],
      },
    },
    expected: ["clarify_goal"],
    answer: { proposal: "clarify_goal", resolutionSurface: "edit_done_when", inferredWorkType: "normal" },
  },
  { item: fixture(6, "Öffnungszeiten Bürgerbüro"), expected: ["convert_to_reference", "leave_alone"], answer: { proposal: "convert_to_reference", resolutionSurface: "convert_to_reference", inferredWorkType: "reference" } },
];

describe("cleanup round prompt", () => {
  const items = fixtures.map((entry) => entry.item);
  const instructions = buildCleanupRoundInstructions({ items });

  it("states the doctrine, the non-goals, and the closed vocabulary", () => {
    expect(instructions).toContain("Would a tired human understand the intent, decision, outcome, and next useful thought");
    expect(instructions).toContain("planning-quality coach");
    expect(instructions).toContain("not a workflow mechanic");
    expect(instructions).toContain("Do not duplicate those checks");
    expect(instructions).toContain("If the only problem is mechanical, return `leave_alone`");
    expect(instructions).toContain("Do not choose `create_first_slice` merely because Machbar says there is no graph next action");
    expect(instructions).toContain("Mechanical facts are supplied");
    expect(instructions).toContain("not, by themselves, reasons for a finding");
    expect(instructions).toContain("Do not invent long task lists");
    expect(instructions).toContain("Use planningContext before suggesting changes");
    expect(instructions).toContain("Do not suggest a first slice that already exists");
    expect(instructions).toContain("Use `doneChildren` as evidence of what has already been handled");
    expect(instructions).toContain("Missing fields usually mean “not relevant or not filled”");
    for (const kind of cleanupProposalKinds) expect(instructions).toContain(kind);
    for (const surface of cleanupResolutionSurfaces) expect(instructions).toContain(surface);
  });

  it("includes semantic few-shot examples instead of mechanical findings", () => {
    expect(instructions).toContain("Steuerbescheid einreichen");
    expect(instructions).toContain('"proposal":"leave_alone"');
    expect(instructions).toContain("Backup Konzept");
    expect(instructions).toContain("Which uncertainty should be reduced first");
    expect(instructions).toContain("Never report \"This has no next action.\"");
    expect(instructions).toContain("Antwort Versicherung Rohrbruch");
    expect(instructions).toContain("Never report \"This is blocked.\"");
    expect(instructions).toContain("Öffnungszeiten Bürgerbüro");
    expect(instructions).toContain("Kur-Nachweis");
  });

  it("embeds the sampled items as data", () => {
    for (const item of items) expect(instructions).toContain(JSON.stringify(item.item.title));
    expect(instructions).toContain("Angebote einholen");
    expect(instructions).toContain("Tür ist montiert, dicht und bezahlt");
    expect(instructions.indexOf("=== SAMPLED ITEMS")).toBeGreaterThan(instructions.indexOf("Output contract"));
  });

  it("feeds validation issues back on retry", () => {
    const retry = buildCleanupRoundInstructions({
      items,
      validationIssues: [{ path: ["results", 0, "targetId"], code: "unknown_target", message: "Target task 9 was not part of this round." }],
    });
    expect(retry).toContain("results.0.targetId | unknown_target");
  });

  it.each(fixtures)("accepts a doctrine-shaped answer for $item.item.title", ({ item, expected, answer }) => {
    expect(expected).toContain(answer.proposal);
    const outcome = validateCleanupRoundResponse({
      summary: "Runde",
      results: [{
        targetType: item.targetType,
        targetId: item.targetId,
        ...answer,
        inferredFlow: "uphill",
        confidence: "medium",
        reason: "Begründung",
        question: "Frage?",
        suggestedDefault: null,
        suggestedTitle: null,
        suggestedShape: null,
      }],
      warnings: [],
    }, [item]);
    expect(outcome.issues).toEqual([]);
    const [result] = outcome.response!.results;
    expect(cleanupProposalKinds).toContain(result!.proposal);
    expect(cleanupResolutionSurfaces).toContain(result!.resolutionSurface);
  });

  it("accepts a semantically clear item with missing mechanical metadata as leave_alone", () => {
    const item = fixture(7, "Steuerbescheid einreichen");
    item.item.notes = "ELSTER-Bescheid hochladen, sobald Brief da ist.";
    const outcome = validateCleanupRoundResponse({
      summary: "Runde",
      results: [{
        targetType: item.targetType,
        targetId: item.targetId,
        proposal: "leave_alone",
        resolutionSurface: "mark_reviewed",
        inferredWorkType: "admin",
        inferredFlow: "downhill",
        confidence: "high",
        reason: "Der Eintrag ist semantisch klar; offen sind nur mechanische Workflow-Metadaten.",
        question: "Keine Planungsfrage nötig.",
        suggestedDefault: null,
        suggestedTitle: null,
        suggestedShape: null,
      }],
      warnings: [],
    }, [item]);
    expect(outcome.issues).toEqual([]);
    expect(outcome.response!.results[0]!.proposal).toBe("leave_alone");
  });

  it("keeps no-next-action and blocking facts out of the semantic finding", () => {
    const firstSlice = fixture(8, "Backup Konzept");
    firstSlice.item.notes = "PBS läuft, aber Restore-Test und Retention sind noch unklar.";
    firstSlice.mechanicalFacts.graphNextActionTitle = null;
    firstSlice.mechanicalFacts.stuckReason = "no_next_action";
    const firstSliceOutcome = validateCleanupRoundResponse({
      summary: "Runde",
      results: [{
        targetType: firstSlice.targetType,
        targetId: firstSlice.targetId,
        proposal: "identify_first_slice",
        resolutionSurface: "create_first_slice",
        inferredWorkType: "ops",
        inferredFlow: "uphill",
        confidence: "high",
        reason: "Die kleinste sinnvolle Scheibe sollte die Unsicherheit über Restore-Vertrauen oder Aufbewahrung reduzieren.",
        question: "Welche Unsicherheit soll zuerst sinken: Restore-Test, Aufbewahrung oder Überwachung?",
        suggestedDefault: "Restore-Test mit einer konkreten Sicherung durchführen",
        suggestedTitle: null,
        suggestedShape: null,
      }],
      warnings: [],
    }, [firstSlice]);
    expect(firstSliceOutcome.issues).toEqual([]);

    const waiting = fixture(9, "Antwort Versicherung Rohrbruch");
    waiting.item.notes = "Warten auf Rückmeldung.";
    waiting.mechanicalFacts.hasExternalWait = true;
    waiting.mechanicalFacts.isBlocked = true;
    const waitingOutcome = validateCleanupRoundResponse({
      summary: "Runde",
      results: [{
        targetType: waiting.targetType,
        targetId: waiting.targetId,
        proposal: "add_followup_after_incident",
        resolutionSurface: "create_followup",
        inferredWorkType: "incident",
        inferredFlow: "uphill",
        confidence: "high",
        reason: "Der Eintrag nennt das Warten, bewahrt aber nicht, welche Antwort oder Nacharbeit den Vorfall abschließen würde.",
        question: "Welche Antwort der Versicherung würde die nächste Entscheidung ermöglichen?",
        suggestedDefault: "Versicherungsantwort prüfen und Reparaturfreigabe klären",
        suggestedTitle: null,
        suggestedShape: null,
      }],
      warnings: [],
    }, [waiting]);
    expect(waitingOutcome.issues).toEqual([]);
  });
});
