import { describe, expect, it } from "vitest";
import { parseNaturalDate, toIsoCalendarDate } from "./naturalDate";

const reference = new Date(2026, 7, 27, 12);

describe("parseNaturalDate", () => {
  it.each([
    ["heute", "2026-08-27"],
    ["morgen", "2026-08-28"],
    ["übermorgen", "2026-08-29"],
    ["Freitag", "2026-08-28"],
    ["nächsten Freitag", "2026-09-04"],
    ["in 3 Tagen", "2026-08-30"],
    ["in zwei Wochen", "2026-09-10"],
    ["28.08.2026", "2026-08-28"],
    ["28. August 2026", "2026-08-28"],
  ])("parses German %s", (input, expected) => {
    expect(parseNaturalDate(input, reference)).toBe(expected);
  });

  it.each([
    ["today", "2026-08-27"],
    ["tomorrow", "2026-08-28"],
    ["next Friday", "2026-09-04"],
    ["in 3 days", "2026-08-30"],
    ["two weeks from now", "2026-09-10"],
  ])("parses English %s", (input, expected) => {
    expect(parseNaturalDate(input, reference)).toBe(expected);
  });

  it.each([
    ["1d", "2026-08-28"],
    ["2w", "2026-09-10"],
    ["3m", "2026-11-27"],
    ["1y", "2027-08-27"],
    ["0d", "2026-08-27"],
  ])("parses compact relative input %s", (input, expected) => {
    expect(parseNaturalDate(input, reference)).toBe(expected);
  });

  it("keeps date arithmetic on the local calendar across daylight-saving changes", () => {
    const beforeDstChange = new Date(2026, 2, 28, 12);
    expect(parseNaturalDate("1d", beforeDstChange)).toBe("2026-03-29");
  });

  it("accepts valid ISO dates and rejects invalid or empty input", () => {
    expect(parseNaturalDate("2028-02-29", reference)).toBe("2028-02-29");
    expect(parseNaturalDate("2026-02-30", reference)).toBeNull();
    expect(parseNaturalDate("29.02.2028", reference)).toBe("2028-02-29");
    expect(parseNaturalDate("29.02.2026", reference)).toBeNull();
    expect(parseNaturalDate("31.02.2026", reference)).toBeNull();
    expect(parseNaturalDate("Kartoffeln", reference)).toBeNull();
    expect(parseNaturalDate("", reference)).toBeNull();
  });
});

describe("toIsoCalendarDate", () => {
  it("uses local calendar parts rather than UTC slicing", () => {
    expect(toIsoCalendarDate(new Date(2026, 7, 28, 0, 15))).toBe("2026-08-28");
  });
});
