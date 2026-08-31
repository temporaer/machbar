import { describe, expect, it } from "vitest";
import { nextSizeInCycle } from "./refinementHelpers";

describe("nextSizeInCycle", () => {
  it("cycles through every size and back to unestimated", () => {
    expect(nextSizeInCycle(null)).toBe("S");
    expect(nextSizeInCycle("S")).toBe("M");
    expect(nextSizeInCycle("M")).toBe("L");
    expect(nextSizeInCycle("L")).toBe("XL");
    expect(nextSizeInCycle("XL")).toBe(null);
  });
});
