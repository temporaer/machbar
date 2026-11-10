import { describe, expect, it } from "vitest";
import {
  addIsoCalendarDays,
  parseNaturalDate,
  parseNaturalDateIntent,
  toIsoCalendarDate,
} from "./naturalDate";

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
    expect(parseNaturalDate(input, reference, "en")).toBe(expected);
  });

  it.each([
    ["08/28/2026", "2026-08-28"],
    ["week 36", "2026-08-31"],
    ["wk 1/2027", "2027-01-04"],
  ])("parses English locale-specific input %s", (input, expected) => {
    expect(parseNaturalDate(input, reference, "en")).toBe(expected);
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

  it.each([
    ["KW 35", "2026-08-24"],
    ["Kalenderwoche 36", "2026-08-31"],
    ["KW 1/2027", "2027-01-04"],
    ["Kalenderwoche 53, 2026", "2026-12-28"],
  ])("parses ISO calendar week input %s as its Monday", (input, expected) => {
    expect(parseNaturalDate(input, reference)).toBe(expected);
  });

  it.each([
    ["oct 11", "en", "2026-10-11"],
    ["11 oct", "en", "2026-10-11"],
    ["oktober 11", "de", "2026-10-11"],
    ["11 oktober", "de", "2026-10-11"],
    ["11. oktober", "de", "2026-10-11"],
  ] as const)(
    "parses yearless month-name-plus-day %s (%s locale) without the year-2001 bug",
    (input, locale, expected) => {
      expect(parseNaturalDate(input, reference, locale)).toBe(expected);
    },
  );

  it.each([
    ["jan 5", "en", "2027-01-05"],
    ["januar 5", "de", "2027-01-05"],
  ] as const)(
    "rolls a yearless month-name-plus-day %s over to next year once it has passed",
    (input, locale, expected) => {
      expect(parseNaturalDate(input, reference, locale)).toBe(expected);
    },
  );

  it("keeps an explicit year unaffected by yearless month-name inference", () => {
    expect(parseNaturalDate("2026-10-11", reference)).toBe("2026-10-11");
    expect(parseNaturalDate("11.10.2026", reference)).toBe("2026-10-11");
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
    expect(parseNaturalDate("KW 54", reference)).toBeNull();
    expect(parseNaturalDate("KW 53/2027", reference)).toBeNull();
    expect(parseNaturalDate("Kartoffeln", reference)).toBeNull();
    expect(parseNaturalDate("", reference)).toBeNull();
  });

  it.each([
    ["Feb 29", "en", new Date(2024, 2, 1, 12)],
    ["Feb 30", "en", new Date(2024, 2, 1, 12)],
    ["31. April", "de", new Date(2024, 2, 1, 12)],
    ["29. Februar", "de", new Date(2024, 2, 1, 12)],
    ["04/31/2024", "en", new Date(2024, 2, 1, 12)],
    ["31.04.2024", "de", new Date(2024, 2, 1, 12)],
    ["31 April, 2024", "en", new Date(2024, 2, 1, 12)],
    ["April 31st 2024", "en", new Date(2024, 2, 1, 12)],
    ["Feb 30th", "en", new Date(2024, 2, 1, 12)],
  ] as const)("rejects recognized invalid date %s", (input, locale, date) => {
    expect(parseNaturalDate(input, date, locale)).toBeNull();
  });

  it.each([
    ["Feb 29", new Date(2024, 1, 28, 12), "2024-02-29"],
    ["Feb 29", new Date(2024, 1, 29, 12), "2024-02-29"],
    ["Feb 29", new Date(2024, 2, 1, 12), null],
    ["Feb 28", new Date(2024, 2, 1, 12), "2025-02-28"],
    ["Feb 29", new Date(2023, 1, 28, 12), null],
    ["Feb 29", new Date(2023, 2, 1, 12), "2024-02-29"],
  ] as const)(
    "validates the inferred year for %s around a leap-day boundary",
    (input, date, expected) => {
      expect(parseNaturalDate(input, date, "en")).toBe(expected);
    },
  );

  it("validates explicit word dates without changing the existing valid syntax", () => {
    expect(parseNaturalDate("28. August 2026", reference)).toBe("2026-08-28");
    expect(parseNaturalDate("Feb 29, 2028", reference, "en")).toBe(
      "2028-02-29",
    );
    expect(parseNaturalDate("April 30th 2024", reference, "en")).toBe(
      "2024-04-30",
    );
    expect(parseNaturalDate("30th April, 2024", reference, "en")).toBe(
      "2024-04-30",
    );
    expect(parseNaturalDate("Feb 29, 2026", reference, "en")).toBeNull();
  });
});

describe("toIsoCalendarDate", () => {
  it("uses local calendar parts rather than UTC slicing", () => {
    expect(toIsoCalendarDate(new Date(2026, 7, 28, 0, 15))).toBe("2026-08-28");
  });
});

describe("addIsoCalendarDays", () => {
  it("uses calendar arithmetic across month and leap-day boundaries", () => {
    expect(addIsoCalendarDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addIsoCalendarDays("2028-02-29", 1)).toBe("2028-03-01");
  });

  describe("parseNaturalDateIntent", () => {
    it.each([
      ["morgen", "2026-08-28", null, null],
      ["morgen früh", "2026-08-28", null, "morning"],
      ["morgen Abend", "2026-08-28", null, "evening"],
      ["heute Morgen", "2026-08-27", null, "morning"],
      ["am Morgen", "2026-08-27", null, "morning"],
      ["heute Abend", "2026-08-27", null, "evening"],
      ["tomorrow evening", "2026-08-28", null, "evening"],
      ["tomorrow", "2026-08-28", null, null],
      ["tomorrow morning", "2026-08-28", null, "morning"],
      ["Dienstag um 14:30", "2026-09-01", "14:30", null],
      ["Tuesday at 2:15 pm", "2026-09-01", "14:15", null],
    ] as const)("retains time intent for %s", (input, date, time, daypart) => {
      expect(
        parseNaturalDateIntent(
          input,
          reference,
          input.includes("Tuesday") ? "en" : "de",
        ),
      ).toEqual({
        date,
        time,
        daypart,
        timeExplicit: time !== null,
      });
    });

    it("keeps the existing date-only parser contract", () => {
      expect(parseNaturalDate("heute Abend", reference)).toBeNull();
    });
  });
});
