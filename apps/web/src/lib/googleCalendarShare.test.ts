import { describe, expect, it } from "vitest";
import { parseGoogleCalendarShare } from "./googleCalendarShare";

const referenceDate = new Date(2026, 7, 29, 12);

describe("parseGoogleCalendarShare", () => {
  it.each([
    [
      "German timed share",
      {
        title: "Elternabend",
        text:
          "15. Sept. • 19:00–21:00 • Details ansehen und antworten\nhttps://calendar.app.google/abc123",
        url: "",
      },
      "de" as const,
      "2026-09-15",
    ],
    [
      "English timed share",
      {
        title: "Parent evening",
        text:
          "Oct 3 • 10:30–11:30 AM • View details & RSVP\nhttps://calendar.app.google/def456",
        url: "",
      },
      "en" as const,
      "2026-10-03",
    ],
    [
      "all-day share",
      {
        title: "School holiday",
        text: "October 12, 2026\nAll day",
        url: "https://calendar.app.google/all-day",
      },
      "en" as const,
      "2026-10-12",
    ],
    [
      "explicit German year",
      {
        title: "Geburtstag",
        text: "21. September 2027 • Ganztägig",
        url: "https://calendar.app.google/birthday",
      },
      "de" as const,
      "2027-09-21",
    ],
  ])("parses a %s", (_name, target, locale, expected) => {
    expect(
      parseGoogleCalendarShare(target, { locale, referenceDate }),
    ).toEqual({
      source: "google-calendar",
      dueDate: expected,
    });
  });

  it("uses the start date and never the event end date", () => {
    expect(
      parseGoogleCalendarShare(
        {
          title: "Conference",
          text: "Dec 31, 2026 – Jan 2, 2027 • All day",
          url: "https://calendar.app.google/conference",
        },
        { locale: "en", referenceDate },
      ),
    ).toEqual({
      source: "google-calendar",
      dueDate: "2026-12-31",
    });
  });

  it("detects the Calendar URL in either text or the dedicated URL field", () => {
    expect(
      parseGoogleCalendarShare(
        {
          title: "Dinner",
          text: "Sep 20 • 7:00 PM\ncalendar.app.google/in-text",
          url: "",
        },
        { locale: "en", referenceDate },
      )?.dueDate,
    ).toBe("2026-09-20");

    expect(
      parseGoogleCalendarShare(
        {
          title: "Dinner",
          text: "Sep 21 • 7:00 PM",
          url: "https://calendar.app.google/in-url",
        },
        { locale: "en", referenceDate },
      )?.dueDate,
    ).toBe("2026-09-21");
  });

  it("returns recognized metadata without inventing an unparseable deadline", () => {
    expect(
      parseGoogleCalendarShare({
        title: "Undated event",
        text: "Details ansehen\nhttps://calendar.app.google/no-date",
        url: "",
      }),
    ).toEqual({
      source: "google-calendar",
      dueDate: null,
    });
  });

  it("does not mistake a date-like event title for Calendar metadata", () => {
    expect(
      parseGoogleCalendarShare(
        {
          title: "Friday",
          text: "Details\nhttps://calendar.app.google/no-date",
          url: "",
        },
        { locale: "en", referenceDate },
      ),
    ).toEqual({
      source: "google-calendar",
      dueDate: null,
    });
  });

  it("does not classify an ordinary generic share as Calendar content", () => {
    expect(
      parseGoogleCalendarShare({
        title: "Article",
        text: "Oct 3",
        url: "https://example.test/article",
      }),
    ).toBeNull();
  });
});
