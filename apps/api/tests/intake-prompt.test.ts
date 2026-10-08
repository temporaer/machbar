import { describe, expect, it } from "vitest";
import type { IntakePlan } from "@machbar/shared";
import { buildIntakeInstructions } from "../src/intake/prompt.js";

describe("intake AI instructions", () => {
  it("keeps interpretation guidance concise", () => {
    const instructions = buildIntakeInstructions({
      today: "2026-09-28",
      timezone: "Europe/Berlin",
      memberNames: ["Alex"],
      hasText: true,
      attachmentCount: 0,
    });

    expect(instructions).toContain("tasks, projects, references, and calendar events");
    expect(instructions).toContain("Preserve explicit dates, times, relationships, and reminder intent");
    expect(instructions).toContain("revisitAt means “Wieder ansehen”");
    expect(instructions).toContain("Moving into or out of waiting is a lifecycle decision");
    expect(instructions).toContain("Do not activate a backlog project");
    expect(instructions).toContain("mentioning someone who cannot perform it is not an ownership assignment");
    expect(instructions).not.toContain("JSON null");
  });

  it("includes validation feedback and the user's retry hint", () => {
    const instructions = buildIntakeInstructions({
      today: "2026-09-28",
      memberNames: [],
      hasText: true,
      attachmentCount: 0,
      validationIssues: [{
        path: ["workItems", 0, "dueDate"],
        code: "invalid_date",
        message: "Invalid date.",
      }],
      userInstruction: "Please use the date from the letter.",
    });

    expect(instructions).toContain("complete new plan");
    expect(instructions).toContain("workItems[0].dueDate | invalid_date | Invalid date.");
    expect(instructions).toContain("Please use the date from the letter.");
  });

  it("adds only non-empty household context before proposal data", () => {
    const instructions = buildIntakeInstructions({
      today: "2026-09-28",
      memberNames: [],
      hasText: true,
      attachmentCount: 0,
      aiContext: {
        householdDescription: "SKiBB und Kita sind wiederkehrende Kontexte.",
        longTermDirection: "Familienlogistik soll leichter werden.",
        suggestionGuidance: "",
      },
    });
    expect(instructions).toContain("## Household context from the user");
    expect(instructions).toContain("### Household description");
    expect(instructions).toContain("### Long-term direction");
    expect(instructions).not.toContain("### AI suggestion preferences");
    expect(instructions).toContain("required JSON schemas");
  });

  it("does not add a household context section when no context is supplied", () => {
    const instructions = buildIntakeInstructions({
      today: "2026-09-28",
      memberNames: [],
      hasText: true,
      attachmentCount: 0,
    });
    expect(instructions).not.toContain("## Household context from the user");
  });

  it("includes the ordered current proposal and treats requested changes as edits", () => {
    const instructions = buildIntakeInstructions({
      today: "2026-09-28",
      memberNames: [],
      hasText: true,
      attachmentCount: 1,
      currentProposal: {
        summary: "Current proposal",
        calendarEvents: [],
        workItems: [
          {
            key: "first",
            kind: "action",
            title: "First task",
            notes: null,
            parentKey: null,
            ownerName: null,
            dueDate: null,
            scheduledDate: null,
            notBeforeDate: null,
            notBeforeAt: null,
            reminders: [],
            needsClarification: false,
            relatedCalendarKeys: [],
          },
          {
            key: "second",
            kind: "action",
            title: "Second task",
            notes: null,
            parentKey: null,
            ownerName: null,
            dueDate: null,
            scheduledDate: null,
            notBeforeDate: null,
            notBeforeAt: null,
            reminders: [],
            needsClarification: false,
            relatedCalendarKeys: [],
          },
        ],
        warnings: [],
      } satisfies IntakePlan,
      userInstruction: "Combine the first two tasks.",
    });

    expect(instructions).toContain("=== CURRENT PROPOSAL CONTEXT (ordered; not a patch) ===");
    expect(instructions).toContain("=== END CURRENT PROPOSAL CONTEXT ===");
    expect(instructions.indexOf('"title": "First task"'))
      .toBeLessThan(instructions.indexOf('"title": "Second task"'));
    expect(instructions).toContain("Apply these changes to the current proposal while preserving unaffected intent.");
    expect(instructions).toContain("complete replacement plan");
    expect(instructions).toContain("Combine the first two tasks.");
  });
});
