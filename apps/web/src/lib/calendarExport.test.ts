import { describe, expect, it } from "vitest";
import {
  createCalendarExportFile,
  serializeCalendarExport,
  type CalendarExportItem,
} from "./calendarExport";

const now = new Date("2026-08-29T14:00:00.000Z");
const baseUrl = "https://machbar.test/app/";

function task(overrides: Partial<CalendarExportItem> = {}): CalendarExportItem {
  return {
    kind: "task",
    id: 42,
    title: "Elternabend",
    notes: "Raum 3",
    dueDate: "2026-09-15",
    ...overrides,
  };
}

describe("calendar export", () => {
  it("serializes a Task as an all-day event with a stable deep link and UID", () => {
    expect(serializeCalendarExport(task(), { now, baseUrl })).toBe(
      [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Machbar//Calendar Export//EN",
        "BEGIN:VEVENT",
        "UID:task-42@machbar.test",
        "DTSTAMP:20260829T140000Z",
        "DTSTART;VALUE=DATE:20260915",
        "DTEND;VALUE=DATE:20260916",
        "SUMMARY:Elternabend",
        "DESCRIPTION:Raum 3\\n\\nhttps://machbar.test/app/#/tasks/42",
        "END:VEVENT",
        "END:VCALENDAR",
        "",
      ].join("\r\n"),
    );
  });

  it("serializes a Project with its project deep link", () => {
    const calendar = serializeCalendarExport(
      task({ kind: "project", id: 7, title: "Sommerfest" }),
      { now, baseUrl },
    );
    expect(calendar).toContain("UID:project-7@machbar.test\r\n");
    expect(calendar).toContain(
      "DESCRIPTION:Raum 3\\n\\nhttps://machbar.test/app/#/projects/7\r\n",
    );
  });

  it.each([
    ["2026-12-31", "20270101"],
    ["2028-02-29", "20280301"],
    ["2026-01-31", "20260201"],
  ])("uses an exclusive next-day DTEND for %s", (dueDate, expectedEnd) => {
    expect(
      serializeCalendarExport(task({ dueDate }), { now, baseUrl }),
    ).toContain(`DTEND;VALUE=DATE:${expectedEnd}`);
  });

  it("escapes reserved characters and multiline notes", () => {
    const calendar = serializeCalendarExport(
      task({
        title: "Plan; Einkauf, Teil \\ 1",
        notes: "Erste Zeile\nZweite; Zeile, mit \\ Pfad",
      }),
      { now, baseUrl },
    );
    expect(calendar).toContain(
      "SUMMARY:Plan\\; Einkauf\\, Teil \\\\ 1\r\n",
    );
    expect(calendar).toContain(
      "DESCRIPTION:Erste Zeile\\nZweite\\; Zeile\\, mit \\\\ Pfad\\n\\nhttps://machbar.test/app/#/tasks/42\r\n",
    );
  });

  it("creates a text/calendar file with a safe title-based name", () => {
    const file = createCalendarExportFile(
      task({ title: "Elternabend / Raum 3" }),
      { now, baseUrl },
    );
    expect(file.name).toBe("Elternabend-Raum-3.ics");
    expect(file.type).toBe("text/calendar");
    expect(file.size).toBeGreaterThan(0);
  });
});
