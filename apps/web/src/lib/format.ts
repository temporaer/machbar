import type { Locale } from "../i18n/catalog";

export function localeTag(locale: Locale): string {
  return locale === "en" ? "en-US" : "de-DE";
}

export function formatDate(
  iso: string | null | undefined,
  locale: Locale = "de",
): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat(localeTag(locale), {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(d);
}

export function formatDateTime(
  iso: string | null | undefined,
  locale: Locale = "de",
): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat(localeTag(locale), {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

export function isOverdue(dueDate: string | null | undefined, status: string): boolean {
  if (!dueDate || status === "done" || status === "cancelled") return false;
  const due = new Date(dueDate);
  if (Number.isNaN(due.getTime())) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return due.getTime() < today.getTime();
}

/** Deterministic pastel-ish color fallback for members without a stored color. */
export function fallbackColor(seed: number): string {
  const palette = ["#146356", "#8a4f7d", "#2b5a8f", "#9a6700", "#b3261e", "#3b6b3f"];
  return palette[Math.abs(seed) % palette.length] ?? "#146356";
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}
