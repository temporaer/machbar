import { describe, expect, it } from "vitest";
import {
  householdCalendarDateTimeToRevisitAt,
  newDateOnlyRevisitAt,
  resolveDateOnlyRevisitChange,
  resolveRevisitDaypart,
} from "@machbar/shared";
import { calendarDateForInstant, localTimeForInstant } from "@machbar/shared";

const timezone = "Europe/Berlin";

function instantAt(local: string): string {
  return householdCalendarDateTimeToRevisitAt(
    local.slice(0, 10),
    local.slice(11),
    timezone,
  )!;
}

describe("shared revisit time policy", () => {
  it("uses 06:00 for a new date-only revisit", () => {
    const value = newDateOnlyRevisitAt("2026-10-12", timezone)!;
    expect(localTimeForInstant(value, timezone)).toBe("06:00");
  });

  it("preserves the existing local clock when changing only the date", () => {
    const original = instantAt("2026-10-09T18:30");
    const moved = resolveDateOnlyRevisitChange(
      "2026-10-12",
      original,
      timezone,
    )!;
    expect(calendarDateForInstant(moved, timezone)).toBe("2026-10-12");
    expect(localTimeForInstant(moved, timezone)).toBe("18:30");
  });

  it("keeps an unchanged instant exact and accepts explicit midnight", () => {
    const original = instantAt("2026-10-09T18:30");
    expect(resolveDateOnlyRevisitChange("2026-10-09", original, timezone)).toBe(
      original,
    );
    expect(localTimeForInstant(instantAt("2026-10-12T00:00"), timezone)).toBe(
      "00:00",
    );
  });

  it.each([
    ["2026-10-08T17:00:00+02:00", "2026-10-08", "19:00"],
    ["2026-10-08T19:15:00+02:00", "2026-10-08", "20:00"],
    ["2026-10-08T20:00:00+02:00", "2026-10-08", "21:00"],
    ["2026-10-08T20:45:00+02:00", "2026-10-08", "22:00"],
  ])(
    "resolves today's evening without proposing the past (%s)",
    (now, date, expected) => {
      const value = resolveRevisitDaypart("evening", now, timezone, date);
      expect(value && localTimeForInstant(value, timezone)).toBe(expected);
    },
  );

  it("returns no same-day evening suggestion after the daypart", () => {
    expect(
      resolveRevisitDaypart(
        "evening",
        "2026-10-08T22:30:00+02:00",
        timezone,
        "2026-10-08",
      ),
    ).toBeNull();
    expect(
      resolveRevisitDaypart(
        "evening",
        "2026-10-08T23:30:00+02:00",
        timezone,
        "2026-10-08",
      ),
    ).toBeNull();
    expect(
      resolveRevisitDaypart(
        "evening",
        "2026-10-08T23:45:00+02:00",
        timezone,
        "2026-10-08",
      ),
    ).toBeNull();
    expect(
      resolveRevisitDaypart(
        "evening",
        "2026-10-08T23:59:00+02:00",
        timezone,
        "2026-10-08",
      ),
    ).toBeNull();
  });

  it("uses normal daypart defaults for a future date", () => {
    expect(
      localTimeForInstant(
        resolveRevisitDaypart(
          "evening",
          "2026-10-08T22:30:00+02:00",
          timezone,
          "2026-10-09",
        ),
        timezone,
      ),
    ).toBe("19:00");
    expect(
      localTimeForInstant(
        resolveRevisitDaypart(
          "morning",
          "2026-10-08T22:30:00+02:00",
          timezone,
          "2026-10-09",
        ),
        timezone,
      ),
    ).toBe("08:00");
  });

  it("rejects invalid local times across DST transitions", () => {
    expect(
      householdCalendarDateTimeToRevisitAt("2026-03-29", "02:30", timezone),
    ).toBeNull();
    expect(
      householdCalendarDateTimeToRevisitAt("2026-10-25", "02:30", timezone),
    ).toBeNull();
  });

  it("uses the household date rather than the host timezone", () => {
    const now = "2026-10-08T23:30:00Z";
    const value = newDateOnlyRevisitAt("2026-10-09", "America/Los_Angeles")!;
    expect(calendarDateForInstant(value, "America/Los_Angeles")).toBe(
      "2026-10-09",
    );
    expect(
      resolveRevisitDaypart(
        "morning",
        now,
        "America/Los_Angeles",
        "2026-10-09",
      ),
    ).not.toBeNull();
    expect(
      resolveRevisitDaypart(
        "evening",
        "2026-10-08T23:45:00-04:00",
        "America/New_York",
        "2026-10-08",
      ),
    ).toBeNull();
  });
});
