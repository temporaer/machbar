function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Converts a local wall-clock date and time into an absolute ISO instant. */
export function localDateTimeToIso(date: string, time: string): string | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(time);
  if (!dateMatch || !timeMatch) return null;

  const [, year, month, day] = dateMatch.map(Number);
  const [, hours, minutes] = timeMatch.map(Number);
  const value = new Date(year!, month! - 1, day, hours, minutes, 0, 0);
  if (
    value.getFullYear() !== year ||
    value.getMonth() !== month! - 1 ||
    value.getDate() !== day ||
    value.getHours() !== hours ||
    value.getMinutes() !== minutes
  ) {
    return null;
  }
  return value.toISOString();
}

/** Returns the browser-local calendar date containing an absolute instant. */
export function localDateForInstant(instant: string): string | null {
  const value = new Date(instant);
  if (Number.isNaN(value.getTime())) return null;
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}
