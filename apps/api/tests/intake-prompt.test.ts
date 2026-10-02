import { describe, expect, it } from "vitest";
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
});
