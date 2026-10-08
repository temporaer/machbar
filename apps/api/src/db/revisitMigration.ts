import type Database from "better-sqlite3";
import {
  DEFAULT_HOUSEHOLD_TIMEZONE,
  householdCalendarDateToRevisitAt,
  normalizeRevisitInput,
} from "@machbar/shared";

export interface RevisitMigrationRow {
  id: number;
  title: string;
  role: "task" | "story";
  status: string;
  scheduledDate: string | null;
  notBeforeAt: string | null;
  notBeforeDate: string | null;
  repeatAfterDays: number | null;
  externalWaitRevisitDate: string | null;
  existingRevisitAt: string | null;
  proposedScheduledDate: string | null;
  proposedRevisitAt: string | null;
  clearScheduledDate: boolean;
  clearNotBefore: boolean;
  clearExternalWaitRevisit: boolean;
  conflicts: string[];
  warnings: string[];
}

export interface RevisitMigrationReport {
  timezone: string;
  rows: RevisitMigrationRow[];
  changedCount: number;
  conflictCount: number;
  outcomeCounts: Record<string, number>;
  alreadyApplied: boolean;
}

function normalizeLegacyInstant(value: string | null, timezone: string): string | null {
  if (value === null) return null;
  const normalized = normalizeRevisitInput(value, timezone);
  return normalized.status === "invalid" ||
    normalized.status === "ambiguous" ||
    normalized.status === "nonexistent"
    ? null
    : normalized.value;
}

function propose(row: {
  id: number;
  title: string;
  role: "task" | "story";
  status: string;
  scheduled_date: string | null;
  not_before_at: string | null;
  not_before_date: string | null;
  repeat_after_days: number | null;
  revisit_at: string | null;
  external_revisit_date: string | null;
}, timezone: string): RevisitMigrationRow {
  const terminal =
    row.status === "done" ||
    row.status === "cancelled" ||
    (row.role === "story" && row.status === "archived");
  const conflicts: string[] = [];
  const warnings: string[] = [];
  let proposedRevisitAt = row.revisit_at;
  let proposedScheduledDate = row.scheduled_date;
  let clearScheduledDate = false;
  let clearNotBefore = false;
  let clearExternalWaitRevisit = false;

  const externalRevisitAt = row.external_revisit_date
    ? householdCalendarDateToRevisitAt(row.external_revisit_date, timezone)
    : null;
  const legacyRevisitAt =
    row.not_before_at !== null
      ? normalizeLegacyInstant(row.not_before_at, timezone)
      : row.not_before_date
        ? householdCalendarDateToRevisitAt(row.not_before_date, timezone)
        : null;

  if (terminal) {
    if (row.revisit_at !== null || legacyRevisitAt !== null || externalRevisitAt !== null) {
      warnings.push("terminal_item_revisit_cleared");
    }
    proposedRevisitAt = null;
    clearNotBefore = true;
    clearExternalWaitRevisit = externalRevisitAt !== null;
  } else if (row.revisit_at === null) {
    if (externalRevisitAt !== null) {
      proposedRevisitAt = externalRevisitAt;
      clearExternalWaitRevisit = true;
      clearNotBefore = row.not_before_at !== null || row.not_before_date !== null;
      if (legacyRevisitAt !== null) {
        conflicts.push("external_wait_revisit_preferred_over_not_before");
      }
    } else if (legacyRevisitAt !== null) {
      if (
        row.scheduled_date !== null &&
        row.role === "task" &&
        row.repeat_after_days === null
      ) {
        conflicts.push("scheduled_date_preserved_over_not_before");
      } else {
        proposedRevisitAt = legacyRevisitAt;
      }
      clearNotBefore = true;
    }
  } else {
    warnings.push("existing_revisit_at_preserved");
  }

  if (row.role === "story" && row.status === "backlog" && row.scheduled_date !== null) {
    if (proposedRevisitAt === null) {
      const projectRevisit = householdCalendarDateToRevisitAt(row.scheduled_date, timezone);
      if (projectRevisit !== null) proposedRevisitAt = projectRevisit;
    }
    clearScheduledDate = true;
    proposedScheduledDate = null;
    warnings.push("backlog_project_schedule_mapped_to_revisit");
  }

  if (
    row.not_before_at !== null &&
    normalizeLegacyInstant(row.not_before_at, timezone) === null
  ) {
    conflicts.push("invalid_not_before_at");
  }
  if (
    row.not_before_date !== null &&
    householdCalendarDateToRevisitAt(row.not_before_date, timezone) === null
  ) {
    conflicts.push("invalid_not_before_date");
  }
  if (
    row.external_revisit_date !== null &&
    externalRevisitAt === null
  ) {
    conflicts.push("invalid_external_wait_revisit_date");
  }

  const changed =
    proposedRevisitAt !== row.revisit_at ||
    clearScheduledDate ||
    clearNotBefore ||
    clearExternalWaitRevisit;
  return {
    id: row.id,
    title: row.title,
    role: row.role,
    status: row.status,
    scheduledDate: row.scheduled_date,
    notBeforeAt: row.not_before_at,
    notBeforeDate: row.not_before_date,
    repeatAfterDays: row.repeat_after_days,
    externalWaitRevisitDate: row.external_revisit_date,
    existingRevisitAt: row.revisit_at,
    proposedScheduledDate,
    proposedRevisitAt,
    clearScheduledDate,
    clearNotBefore,
    clearExternalWaitRevisit,
    conflicts,
    warnings: changed ? warnings : [],
  };
}

export function inspectRevisitMigration(
  sqlite: Database.Database,
  timezone = configuredHouseholdTimezone(sqlite),
): RevisitMigrationReport {
  const alreadyApplied = Boolean(
    sqlite
      .prepare(
        `SELECT 1 FROM data_migrations WHERE name = 'revisit_at_backfill'`,
      )
      .get(),
  );
  const rows = sqlite
    .prepare(
      `SELECT
         w.id,
         w.title,
         w.role,
         w.status,
         w.scheduled_date,
         w.not_before_at,
         w.not_before_date,
         w.repeat_after_days,
         w.revisit_at,
         ew.revisit_date AS external_revisit_date
       FROM work_items w
       LEFT JOIN task_external_waits ew ON ew.task_id = w.id
       ORDER BY w.id`,
    )
    .all() as Array<{
    id: number;
    title: string;
    role: "task" | "story";
    status: string;
    scheduled_date: string | null;
    not_before_at: string | null;
    not_before_date: string | null;
    repeat_after_days: number | null;
    revisit_at: string | null;
    external_revisit_date: string | null;
  }>;
  const proposed = rows.map((row) => propose(row, timezone));
  const outcomeCounts = proposed.reduce<Record<string, number>>((counts, row) => {
    const outcome =
      row.conflicts.length > 0
        ? row.conflicts[0]!
        : row.proposedRevisitAt !== row.existingRevisitAt
          ? "revisit_created"
          : row.clearScheduledDate
            ? "schedule_moved_to_revisit"
            : "unchanged";
    counts[outcome] = (counts[outcome] ?? 0) + 1;
    return counts;
  }, {});
  return {
    timezone,
    rows: proposed,
    changedCount: proposed.filter(
      (row) =>
        row.proposedRevisitAt !== row.existingRevisitAt ||
        row.proposedScheduledDate !== row.scheduledDate ||
        row.clearNotBefore ||
        row.clearExternalWaitRevisit,
    ).length,
    conflictCount: proposed.filter((row) => row.conflicts.length > 0).length,
    outcomeCounts,
    alreadyApplied,
  };
}

export function configuredHouseholdTimezone(sqlite: Database.Database): string {
  const hasSettings = sqlite
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'household_settings'`,
    )
    .get();
  if (!hasSettings) return DEFAULT_HOUSEHOLD_TIMEZONE;
  const row = sqlite
    .prepare(
      `SELECT value FROM household_settings WHERE key = 'timezone'`,
    )
    .get() as { value?: string } | undefined;
  const timezone = row?.value ?? DEFAULT_HOUSEHOLD_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
    return timezone;
  } catch {
    return DEFAULT_HOUSEHOLD_TIMEZONE;
  }
}

export function applyRevisitMigration(
  sqlite: Database.Database,
  options: { allowConflicts?: boolean } = {},
): RevisitMigrationReport {
  const report = inspectRevisitMigration(sqlite);
  if (report.alreadyApplied) return report;
  if (report.conflictCount > 0 && options.allowConflicts !== true) {
    throw new Error(
      `Revisit migration has ${report.conflictCount} conflict rows. ` +
      "Review the dry-run report and rerun with allowConflicts=true.",
    );
  }
  const update = sqlite.prepare(
    `UPDATE work_items
       SET revisit_at = @revisitAt,
           scheduled_date = CASE WHEN @clearScheduledDate = 1 THEN NULL ELSE scheduled_date END,
           not_before_at = CASE WHEN @clearNotBefore = 1 THEN NULL ELSE not_before_at END,
           not_before_date = CASE WHEN @clearNotBefore = 1 THEN NULL ELSE not_before_date END
     WHERE id = @id`,
  );
  const clearWait = sqlite.prepare(
    `UPDATE task_external_waits SET revisit_date = NULL WHERE task_id = ?`,
  );
  const apply = sqlite.transaction(() => {
    for (const row of report.rows) {
      if (
        row.proposedRevisitAt === row.existingRevisitAt &&
        !row.clearScheduledDate &&
        !row.clearNotBefore &&
        !row.clearExternalWaitRevisit
      ) {
        continue;
      }
      update.run({
        id: row.id,
        revisitAt: row.proposedRevisitAt,
        clearScheduledDate: row.clearScheduledDate ? 1 : 0,
        clearNotBefore: row.clearNotBefore ? 1 : 0,
      });
      if (row.clearExternalWaitRevisit) clearWait.run(row.id);
    }
    sqlite
      .prepare(
        `INSERT INTO data_migrations (name, completed_at)
         VALUES ('revisit_at_backfill', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      )
      .run();
  });
  apply();
  return report;
}
