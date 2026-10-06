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
  { item: fixture(5, "Haustür", "project"), expected: ["clarify_goal"], answer: { proposal: "clarify_goal", resolutionSurface: "edit_done_when", inferredWorkType: "normal" } },
  { item: fixture(6, "Öffnungszeiten Bürgerbüro"), expected: ["convert_to_reference", "leave_alone"], answer: { proposal: "convert_to_reference", resolutionSurface: "convert_to_reference", inferredWorkType: "reference" } },
];

describe("cleanup round prompt", () => {
  const items = fixtures.map((entry) => entry.item);
  const instructions = buildCleanupRoundInstructions({ items });

  it("states the doctrine, the non-goals, and the closed vocabulary", () => {
    expect(instructions).toContain("Would a tired human know what to do next");
    expect(instructions).toContain("Do not report mechanical issues. Machbar already knows them");
    expect(instructions).toContain("Do not invent long task lists");
    expect(instructions).toContain("If no useful intervention is needed, return leave_alone");
    for (const kind of cleanupProposalKinds) expect(instructions).toContain(kind);
    for (const surface of cleanupResolutionSurfaces) expect(instructions).toContain(surface);
  });

  it("embeds the sampled items as data", () => {
    for (const item of items) expect(instructions).toContain(JSON.stringify(item.item.title));
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
});
