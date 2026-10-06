import type { WorkItemScope } from "./index.js";

/**
 * Klärungsrunde: an on-demand AI coaching pass over a small sample of
 * existing work items. The AI judges semantic usefulness only; every field
 * below is advisory and never mutates a task or project by itself.
 */

export const CLEANUP_ROUND_SAMPLE_LIMIT = 5;

export const cleanupProposalKinds = [
  "leave_alone",
  "rename_for_actionability",
  "clarify_goal",
  "clarify_next_decision",
  "wrong_shape",
  "split_thinking_from_execution",
  "identify_first_slice",
  "add_followup_after_incident",
  "define_check_or_rhythm",
  "clarify_recipient_or_document",
  "convert_to_reference",
] as const;

export type CleanupProposalKind = (typeof cleanupProposalKinds)[number];

export const cleanupResolutionSurfaces = [
  "mark_reviewed",
  "rename_item",
  "edit_done_when",
  "create_decision_task",
  "create_first_slice",
  "create_followup",
  "define_rhythm_or_revisit",
  "clarify_admin_target",
  "choose_shape",
  "split_clarify_execute",
  "convert_to_reference",
  "open_item",
] as const;

export type CleanupResolutionSurface =
  (typeof cleanupResolutionSurfaces)[number];

export const cleanupInferredWorkTypes = [
  "normal",
  "problem",
  "incident",
  "debt",
  "ops",
  "admin",
  "reference",
  "unknown",
] as const;

export type CleanupInferredWorkType =
  (typeof cleanupInferredWorkTypes)[number];

export const cleanupInferredFlows = [
  "uphill",
  "downhill",
  "mixed",
  "unclear",
] as const;

export type CleanupInferredFlow = (typeof cleanupInferredFlows)[number];

export const cleanupConfidences = ["low", "medium", "high"] as const;

export type CleanupConfidence = (typeof cleanupConfidences)[number];

export const cleanupSuggestedShapes = ["task", "project", "reference"] as const;

export type CleanupSuggestedShape = (typeof cleanupSuggestedShapes)[number];

export type CleanupTargetType = "task" | "project";

/** Upper bounds for AI-authored text; longer values are truncated. */
export const CLEANUP_TEXT_LIMITS = {
  summary: 500,
  reason: 500,
  question: 300,
  suggestedDefault: 200,
  suggestedTitle: 200,
  warning: 300,
} as const;

export const CLEANUP_MAX_WARNINGS = 20;

export interface CleanupItemContext {
  targetType: CleanupTargetType;
  targetId: number;
  targetRevision: number;

  item: {
    title: string;
    notes: string | null;
    status: string;
    kind?: "action" | "reference";
    /** Project "done when" criteria, when the target is a project. */
    acceptanceCriteria?: string[];
  };

  hierarchy: {
    projectTitle?: string | null;
    parentTitle?: string | null;
    childTitles: string[];
    siblingTitles: string[];
  };

  /**
   * Facts Machbar already derives. They are context for the AI, not
   * findings it should report.
   */
  mechanicalFacts: {
    hasOwner: boolean;
    hasDueDate: boolean;
    hasScheduledDate: boolean;
    hasExternalWait: boolean;
    hasRevisitDate: boolean;
    isBlocked: boolean;
    isExecutable: boolean;
    graphNextActionTitle: string | null;
    stuckReason: string | null;
    childCount: number;
    notesLength: number;
    reviewedAt: string | null;
  };
}

export interface CleanupTriageResult {
  targetType: CleanupTargetType;
  targetId: number;

  proposal: CleanupProposalKind;
  resolutionSurface: CleanupResolutionSurface;

  inferredWorkType: CleanupInferredWorkType;
  inferredFlow: CleanupInferredFlow;

  confidence: CleanupConfidence;

  reason: string;
  question: string;

  suggestedDefault: string | null;
  suggestedTitle: string | null;
  suggestedShape: CleanupSuggestedShape | null;
}

export interface CleanupRoundAiResponse {
  summary: string;
  results: CleanupTriageResult[];
  warnings: Array<{ message: string }>;
}

export const cleanupRoundStatuses = [
  "queued",
  "analyzing",
  "ready",
  "partial",
  "failed",
  "dismissed",
  "completed",
] as const;

export type CleanupRoundStatus = (typeof cleanupRoundStatuses)[number];

export const cleanupRoundItemStatuses = [
  "pending",
  "ready",
  "failed",
  "dismissed",
  "reviewed",
] as const;

export type CleanupRoundItemStatus = (typeof cleanupRoundItemStatuses)[number];

export type CleanupValidationIssueCode =
  | "schema_invalid"
  | "unknown_target"
  | "target_type_mismatch"
  | "duplicate_target"
  | "missing_target";

export interface CleanupValidationIssue {
  path: (string | number)[];
  code: CleanupValidationIssueCode;
  message: string;
}

export interface CleanupRoundErrorInfo {
  code: string;
  message: string;
  retryable: boolean;
  details?: {
    issues?: CleanupValidationIssue[];
    path?: (string | number)[];
    expectedType?: string;
    actualType?: string;
    valuePreview?: string;
  };
}

export interface CleanupRoundItemRecord {
  id: string;
  targetType: CleanupTargetType;
  targetId: number;
  targetRevision: number;
  status: CleanupRoundItemStatus;
  /** Current title when the item still exists, otherwise the sampled one. */
  title: string;
  /** Whether the target task/project still exists. */
  exists: boolean;
  projectTitle: string | null;
  parentTitle: string | null;
  itemStatus: string;
  result: CleanupTriageResult | null;
}

export interface CleanupRoundRecord {
  id: string;
  status: CleanupRoundStatus;
  revision: number;
  scope: WorkItemScope;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  summary: string | null;
  items: CleanupRoundItemRecord[];
  warnings: Array<{ message: string }>;
  error: CleanupRoundErrorInfo | null;
  homeAssistant: { workerOnline: boolean };
}

export interface CleanupRoundAnalyzePayload {
  cleanupRoundId: string;
  taskName: "Machbar Klärungsrunde";
  instructions: string;
  items: CleanupItemContext[];
}
