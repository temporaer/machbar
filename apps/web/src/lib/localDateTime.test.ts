import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localDateForInstant, localDateTimeToIso } from "./localDateTime";

describe("localDateTime", () => {
  const originalTimezone = process.env.TZ;

  beforeAll(() => {
    process.env.TZ = "Europe/Berlin";
  });

  afterAll(() => {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  });

  it("preserves the local calendar date when midnight falls on the prior UTC date", () => {
    const instant = localDateTimeToIso("2026-09-20", "00:30");

    expect(instant).toBe("2026-09-19T22:30:00.000Z");
    expect(localDateForInstant(instant!)).toBe("2026-09-20");
  });

  it("rejects a wall-clock time skipped by daylight-saving time", () => {
    expect(localDateTimeToIso("2026-03-29", "02:30")).toBeNull();
  });
});
