import { describe, expect, it } from "vitest";
import { makeTask } from "../test/fixtures";
import { buildProjectAiPromptText } from "./projectAiPrompt";

describe("buildProjectAiPromptText", () => {
  it("starts with the prompt and preserves only selected material Markdown", () => {
    const selected = makeTask({
      id: 8,
      title: "Versicherungsbedingungen",
      kind: "reference",
      notes: "[Quelle][policy]\n\n**Fristen beachten.**\n\n[policy]: https://example.test/policy",
    });
    const unselected = makeTask({
      id: 9,
      title: "Nicht ausgewählt",
      kind: "reference",
      notes: "Nicht in den Export übernehmen.",
    });

    const result = buildProjectAiPromptText("Fasse die Fristen zusammen.", [
      { task: selected, parentTitles: ["Versicherung prüfen"] },
    ]);

    expect(result).toBe(
      [
        "Fasse die Fristen zusammen.",
        "---",
        "## Versicherungsbedingungen",
        "Versicherung prüfen",
        "[Quelle](<https://example.test/policy>)\n\n**Fristen beachten.**",
      ].join("\n\n"),
    );
    expect(result).toContain("**Fristen beachten.**");
    expect(result).toContain("[Quelle](<https://example.test/policy>)");
    expect(result).not.toContain(unselected.title);
    expect(result).not.toContain(unselected.notes);
  });

  it("supports a prompt without selected material", () => {
    expect(buildProjectAiPromptText("Bitte brainstormen.", [])).toBe(
      "Bitte brainstormen.",
    );
  });
});
