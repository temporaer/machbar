import { describe, expect, it } from "vitest";
import { buildIntakeInstructions } from "../src/intake/prompt.js";

describe("intake AI instructions", () => {
  it("requests Markdown notes and tel links for phone numbers", () => {
    const instructions = buildIntakeInstructions({
      today: "2026-09-28",
      memberNames: [],
      hasText: true,
      attachmentCount: 0,
    });

    expect(instructions).toContain("Format every notes value as Markdown");
    expect(instructions).toContain("[0772123456](tel:0772123456)");
    expect(instructions).toContain("remove only visual separators from the URI");
  });
});
