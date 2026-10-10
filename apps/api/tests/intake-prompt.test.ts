import { describe, expect, it } from "vitest";
import type { IntakePlan } from "@machbar/shared";
import { buildIntakeInstructions } from "../src/intake/prompt.js";

describe("intake AI instructions", () => {
  it("lets breakdown run without instructions and return no unnecessary children", () => {
    const prompt = buildIntakeInstructions({
      today: "2026-10-10", memberNames: [], hasText: true, attachmentCount: 0,
      breakdownInstruction: "",
    });
    expect(prompt).toContain("zero or a small number");
    expect(prompt).toContain("No additional instructions were supplied");
    expect(prompt).toContain("Do not repeat open or completed work");
  });
  it("uses semantic refinement guidance for tasks and existing project outlines", () => {
    const prompt = buildIntakeInstructions({ today: "2026-10-10", memberNames: [], hasText: true, attachmentCount: 0,
      refinement: { targetType: "project", intent: "structure", context: '{"status":"active","tasks":[{"status":"done"}]}' } });
    expect(prompt).toContain("existing outline is authoritative");
    expect(prompt).toContain("completed");
    expect(prompt).toContain("clarification disposition");
    expect(prompt).toContain("leave_alone");
    expect(prompt).toContain("structure");
    const next = buildIntakeInstructions({ today: "2026-10-10", memberNames: [], hasText: true, attachmentCount: 0,
      refinement: { targetType: "task", intent: "next_action", context: '{"title":"Backup-Konzept"}' } });
    expect(next).toContain("identify one executable action");
    expect(next).toContain("one create_child recommendation at most");
  });
  it("regenerates refinement from current context, original focus, previous choices and latest answer", () => {
    const instructions = buildIntakeInstructions({
      today: "2026-10-10", memberNames: [], hasText: true, attachmentCount: 0,
      refinement: {
        targetType: "task", intent: "improve", instruction: "Clarify the handoff",
        context: '{"title":"Current graph"}',
        previousProposal: '{"summary":"Earlier idea","changes":[{"title":"First suggestion","accepted":false}]}',
        feedback: "Keep the first suggestion but replace the third",
        validationFeedback: [{ path: ["changes", 0], code: "schema_invalid", message: "Use a valid target." }],
        validationMessage: "A captured task needs an accepted project conversion before adding children.",
      },
    });
    expect(instructions).toContain("complete replacement proposal, never a patch");
    expect(instructions).toContain("Current graph");
    expect(instructions).toContain("Clarify the handoff");
    expect(instructions).toContain("First suggestion");
    expect(instructions).toContain("Keep the first suggestion but replace the third");
    expect(instructions).toContain("changes[0] | schema_invalid | Use a valid target.");
    expect(instructions).toContain("A captured task needs an accepted project conversion");
  });
  it("shares quality guidance and adds bounded editing semantics for task breakdown", () => {
    const input = { today: "2026-10-10", memberNames: ["Alex"], hasText: true, attachmentCount: 0,
      aiContext: { householdDescription: "", longTermDirection: "", suggestionGuidance: "Prefer 20-minute steps" } };
    const intake = buildIntakeInstructions(input);
    const breakdown = buildIntakeInstructions({ ...input, breakdownInstruction: "Make this a project" });
    for (const prompt of [intake, breakdown]) {
      expect(prompt).toContain("A good task describes a concrete action");
      expect(prompt).toContain("do not split appropriately sized work");
      expect(prompt).toContain("distinguishing diagnosis, research, decision, execution, and follow-up");
      expect(prompt).toContain("no web research capability");
      expect(prompt).toContain("Prefer 20-minute steps");
    }
    expect(breakdown).toContain('key "existing-task"');
    expect(breakdown).toContain("must not be emitted as new items");
    expect(breakdown).toContain("Make this a project");
    expect(intake).not.toContain("EDIT AN EXISTING TASK");
  });
  it("keeps interpretation guidance concise", () => {
    const instructions = buildIntakeInstructions({
      today: "2026-09-28",
      timezone: "Europe/Berlin",
      currentLocalDateTime: "2026-09-28T20:00:00",
      memberNames: ["Alex"],
      hasText: true,
      attachmentCount: 0,
    });

    expect(instructions).toContain("tasks, projects, references, and calendar events");
    expect(instructions).toContain("Preserve explicit dates, times, relationships, and reminder intent");
    expect(instructions).toContain("revisitAt means “Wieder ansehen”");
    expect(instructions).toContain("current household-local datetime is 2026-09-28T20:00:00");
    expect(instructions).toContain("explicit dayparts");
    expect(instructions).toContain("use 06:00 local time");
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

  it("includes all configured household AI context in refinement as background", () => {
    const instructions = buildIntakeInstructions({
      today: "2026-09-28",
      memberNames: [],
      hasText: true,
      attachmentCount: 0,
      aiContext: {
        householdDescription: "We coordinate school and daycare routines.",
        longTermDirection: "Make family logistics calmer.",
        suggestionGuidance: "Prefer small, practical next steps.",
      },
      refinement: {
        targetType: "task",
        intent: "improve",
        instruction: "Clarify who hands over the form.",
        context: '{"title":"Kita-Formular"}',
        previousProposal: '{"summary":"Earlier proposal"}',
        feedback: "Keep the title suggestion and adjust the rest.",
      },
    });
    expect(instructions).toContain("## Household context from the user");
    expect(instructions).toContain("### Household description\n\n\"\"\"\nWe coordinate school and daycare routines.");
    expect(instructions).toContain("### Long-term direction\n\n\"\"\"\nMake family logistics calmer.");
    expect(instructions).toContain("### AI suggestion preferences\n\n\"\"\"\nPrefer small, practical next steps.");
    expect(instructions).toContain("Treat household context as background only");
    expect(instructions).toContain("explicit user instructions, and domain rules take precedence");
    expect(instructions).toContain("Clarify who hands over the form.");
    expect(instructions).toContain("Keep the title suggestion and adjust the rest.");
  });

  it("omits the household context section from refinement when all configured fields are empty", () => {
    const instructions = buildIntakeInstructions({
      today: "2026-09-28",
      memberNames: [],
      hasText: true,
      attachmentCount: 0,
      aiContext: { householdDescription: "  ", longTermDirection: "", suggestionGuidance: null },
      refinement: { targetType: "task", intent: "improve", context: '{"title":"Kita-Formular"}' },
    });
    expect(instructions).not.toContain("## Household context from the user");
    expect(instructions).not.toContain("Treat household context as background only");
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
