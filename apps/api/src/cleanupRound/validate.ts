import type {
  CleanupRoundAiResponse,
  CleanupTargetType,
  CleanupTriageResult,
  CleanupValidationIssue,
} from "@machbar/shared";
import { CLEANUP_MAX_WARNINGS, CLEANUP_TEXT_LIMITS } from "@machbar/shared";
import { cleanupTriageResultSchema } from "../schemas.js";

export interface CleanupSampledTarget {
  targetType: CleanupTargetType;
  targetId: number;
}

export interface CleanupValidationOutcome {
  /** `null` when the response did not have the top-level contract shape. */
  response: CleanupRoundAiResponse | null;
  /** Machine-readable reasons for ignored entries (fed back on retry). */
  issues: CleanupValidationIssue[];
  /** Sampled targets without an accepted result. */
  missingTargets: CleanupSampledTarget[];
}

const TEXT_FIELDS = [
  ["reason", CLEANUP_TEXT_LIMITS.reason],
  ["question", CLEANUP_TEXT_LIMITS.question],
  ["suggestedDefault", CLEANUP_TEXT_LIMITS.suggestedDefault],
  ["suggestedTitle", CLEANUP_TEXT_LIMITS.suggestedTitle],
] as const;
const NULLABLE_TEXT_FIELDS = new Set(["suggestedDefault", "suggestedTitle"]);
const ENUM_FIELDS = [
  "targetType",
  "proposal",
  "resolutionSurface",
  "inferredWorkType",
  "inferredFlow",
  "confidence",
  "suggestedShape",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function truncate(value: string, max: number): { value: string; truncated: boolean } {
  const trimmed = value.trim();
  if (trimmed.length <= max) return { value: trimmed, truncated: false };
  return { value: `${trimmed.slice(0, max - 1).trimEnd()}…`, truncated: true };
}

function isAbsentText(value: string): boolean {
  const lowered = value.trim().toLowerCase();
  return lowered === "" || lowered === "null" || lowered === "none";
}

function targetKey(target: CleanupSampledTarget): string {
  return `${target.targetType}:${target.targetId}`;
}

/**
 * Boundary normalization for one provider entry: trims strings, folds
 * textual nulls into `null`, lower-cases enum spellings, coerces numeric
 * target IDs, and truncates excessive prose. Enum/contract validity is
 * left to the Zod schema.
 */
function normalizeEntry(raw: Record<string, unknown>): {
  entry: Record<string, unknown>;
  truncatedFields: string[];
} {
  const entry: Record<string, unknown> = { ...raw };
  const truncatedFields: string[] = [];
  if (typeof entry.targetId === "string" && /^\d+$/.test(entry.targetId.trim())) {
    entry.targetId = Number(entry.targetId.trim());
  }
  for (const field of ENUM_FIELDS) {
    const value = entry[field];
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      entry[field] = field === "suggestedShape" && isAbsentText(normalized) ? null : normalized;
    }
  }
  if (entry.suggestedShape === undefined) entry.suggestedShape = null;
  for (const [field, max] of TEXT_FIELDS) {
    const value = entry[field];
    if (value === undefined && NULLABLE_TEXT_FIELDS.has(field)) {
      entry[field] = null;
      continue;
    }
    if (typeof value !== "string") continue;
    if (NULLABLE_TEXT_FIELDS.has(field) && isAbsentText(value)) {
      entry[field] = null;
      continue;
    }
    const result = truncate(value, max);
    entry[field] = result.value;
    if (result.truncated) truncatedFields.push(field);
  }
  return { entry, truncatedFields };
}

/**
 * Validates an AI Task response against the sampled targets. Only entries
 * that pass the structural schema *and* refer to exactly one sampled
 * target survive; everything else becomes an issue plus a visible warning.
 * The outcome is advisory data only — nothing here mutates work items.
 */
export function validateCleanupRoundResponse(
  raw: unknown,
  sampled: readonly CleanupSampledTarget[],
): CleanupValidationOutcome {
  const issues: CleanupValidationIssue[] = [];
  if (!isRecord(raw) || !Array.isArray(raw.results)) {
    issues.push({
      path: isRecord(raw) ? ["results"] : [],
      code: "schema_invalid",
      message: isRecord(raw)
        ? "The response must contain a results array."
        : "The response must be an object.",
    });
    return { response: null, issues, missingTargets: [...sampled] };
  }

  const sampledKeys = new Set(sampled.map(targetKey));
  const sampledById = new Map(sampled.map((target) => [target.targetId, target]));
  const accepted = new Map<string, CleanupTriageResult>();
  const notices: Array<{ message: string }> = [];

  raw.results.forEach((value, index) => {
    const path = ["results", index];
    if (!isRecord(value)) {
      issues.push({ path, code: "schema_invalid", message: "Result entries must be objects." });
      return;
    }
    const { entry, truncatedFields } = normalizeEntry(value);
    const parsed = cleanupTriageResultSchema.safeParse(entry);
    if (!parsed.success) {
      for (const issue of parsed.error.issues.slice(0, 5)) {
        issues.push({
          path: [...path, ...issue.path],
          code: "schema_invalid",
          message: issue.message.slice(0, 300),
        });
      }
      return;
    }
    const result = parsed.data as CleanupTriageResult;
    const key = targetKey(result);
    if (!sampledKeys.has(key)) {
      const sameId = sampledById.get(result.targetId);
      issues.push(sameId
        ? {
            path: [...path, "targetType"],
            code: "target_type_mismatch",
            message: `Target ${result.targetId} is a ${sameId.targetType}, not a ${result.targetType}.`,
          }
        : {
            path: [...path, "targetId"],
            code: "unknown_target",
            message: `Target ${result.targetType} ${result.targetId} was not part of this round.`,
          });
      return;
    }
    if (accepted.has(key)) {
      issues.push({
        path: [...path, "targetId"],
        code: "duplicate_target",
        message: `Target ${result.targetType} ${result.targetId} has more than one result; only the first is used.`,
      });
      return;
    }
    for (const field of truncatedFields) {
      notices.push({ message: `Shortened ${field} for ${result.targetType} ${result.targetId}.` });
    }
    accepted.set(key, result);
  });

  const missingTargets = sampled.filter((target) => !accepted.has(targetKey(target)));
  for (const target of missingTargets) {
    issues.push({
      path: ["results"],
      code: "missing_target",
      message: `No valid result for ${target.targetType} ${target.targetId}.`,
    });
  }

  const warnings: Array<{ message: string }> = [];
  if (Array.isArray(raw.warnings)) {
    for (const warning of raw.warnings) {
      const message = isRecord(warning) && typeof warning.message === "string"
        ? warning.message
        : typeof warning === "string" ? warning : null;
      if (message && message.trim()) {
        warnings.push({ message: truncate(message, CLEANUP_TEXT_LIMITS.warning).value });
      }
    }
  }
  warnings.push(...notices);
  for (const issue of issues) {
    const location = issue.path.join(".") || "response";
    warnings.push({
      message: truncate(`Ignored ${location}: ${issue.message}`, CLEANUP_TEXT_LIMITS.warning).value,
    });
  }

  return {
    response: {
      summary: typeof raw.summary === "string"
        ? truncate(raw.summary, CLEANUP_TEXT_LIMITS.summary).value
        : "",
      // Keep the sampled order so the UI stays stable across retries.
      results: sampled
        .map((target) => accepted.get(targetKey(target)))
        .filter((result): result is CleanupTriageResult => result !== undefined),
      warnings: warnings.slice(0, CLEANUP_MAX_WARNINGS),
    },
    issues,
    missingTargets,
  };
}
