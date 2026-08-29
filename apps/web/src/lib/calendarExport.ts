import { buildProjectShareUrl, buildTaskShareUrl } from "./shareUrls";

export type CalendarExportKind = "task" | "project";

export interface CalendarExportItem {
  kind: CalendarExportKind;
  id: number;
  title: string;
  notes: string;
  dueDate: string;
}

export interface CalendarExportOptions {
  baseUrl?: string;
  now?: Date;
}

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function parseCalendarDate(value: string): {
  year: number;
  month: number;
  day: number;
} {
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) throw new Error(`Invalid calendar date: ${value}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new Error(`Invalid calendar date: ${value}`);
  }
  return { year, month, day };
}

function formatCalendarDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}${String(month).padStart(2, "0")}${String(day).padStart(2, "0")}`;
}

function nextCalendarDate(value: string): string {
  const { year, month, day } = parseCalendarDate(value);
  if (day < daysInMonth(year, month)) {
    return formatCalendarDate(year, month, day + 1);
  }
  if (month < 12) return formatCalendarDate(year, month + 1, 1);
  return formatCalendarDate(year + 1, 1, 1);
}

function formatUtcTimestamp(value: Date): string {
  if (Number.isNaN(value.getTime())) throw new Error("Invalid calendar timestamp");
  return value.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r\n?|\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function itemUrl(item: CalendarExportItem, baseUrl?: string): string {
  return item.kind === "task"
    ? buildTaskShareUrl(item.id, baseUrl)
    : buildProjectShareUrl(item.id, baseUrl);
}

function uidOrigin(url: string): string {
  try {
    return new URL(url).origin.replace(/^https?:\/\//, "");
  } catch {
    return "machbar";
  }
}

export function serializeCalendarExport(
  item: CalendarExportItem,
  options: CalendarExportOptions = {},
): string {
  const { year, month, day } = parseCalendarDate(item.dueDate);
  const url = itemUrl(item, options.baseUrl);
  const description = [item.notes.trim(), url].filter(Boolean).join("\n\n");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Machbar//Calendar Export//EN",
    "BEGIN:VEVENT",
    `UID:${item.kind}-${item.id}@${uidOrigin(url)}`,
    `DTSTAMP:${formatUtcTimestamp(options.now ?? new Date())}`,
    `DTSTART;VALUE=DATE:${formatCalendarDate(year, month, day)}`,
    `DTEND;VALUE=DATE:${nextCalendarDate(item.dueDate)}`,
    `SUMMARY:${escapeIcsText(item.title)}`,
    `DESCRIPTION:${escapeIcsText(description)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.join("\r\n")}\r\n`;
}

function safeFilename(value: string): string {
  const base = value
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${base || "machbar"}.ics`;
}

export function createCalendarExportFile(
  item: CalendarExportItem,
  options: CalendarExportOptions = {},
): File {
  return new File([serializeCalendarExport(item, options)], safeFilename(item.title), {
    type: "text/calendar",
  });
}
