import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, lte } from "drizzle-orm";
import type {
  CleanupItemContext,
  CleanupRoundErrorInfo,
  CleanupRoundItemStatus,
  CleanupRoundRecord,
  CleanupRoundStatus,
  CleanupTriageResult,
  CleanupValidationIssue,
  WorkItemScope,
} from "@machbar/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { AppError } from "../errors.js";
import { Graph } from "../domain/graph.js";
import { acknowledgeTaskReview } from "../domain/taskWorkflow.js";
import { acknowledgeProjectReview } from "../domain/storyWorkflow.js";
import { nowIso } from "../domain/workItemShared.js";
import { activeHomeAssistantIntegration } from "../integrations/homeAssistant.js";
import {
  enqueueHomeAssistantRequest,
  type HomeAssistantRequestSignal,
} from "../integrations/homeAssistantRequests.js";
import { buildCleanupRoundInstructions } from "./prompt.js";
import { sampleCleanupCandidates } from "./sampler.js";
import { validateCleanupRoundResponse } from "./validate.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const TASK_NAME = "Machbar Klärungsrunde" as const;
/** Rounds whose sampled items should not be sampled again. */
const ACTIVE_ROUND_STATUSES: CleanupRoundStatus[] = ["queued", "analyzing", "ready", "partial"];
const OPEN_ITEM_STATUSES: CleanupRoundItemStatus[] = ["pending", "ready", "failed"];

type RoundRow = typeof schema.cleanupRounds.$inferSelect;
type ItemRow = typeof schema.cleanupRoundItems.$inferSelect;

function parseJson<T>(value: string | null): T | null {
  return value === null ? null : JSON.parse(value) as T;
}

function errorInfo(
  code: string,
  message: string,
  details?: CleanupRoundErrorInfo["details"],
): CleanupRoundErrorInfo {
  return { code, message, retryable: true, ...(details ? { details } : {}) };
}

function readyIntegration(db: Db) {
  const integration = activeHomeAssistantIntegration(db);
  if (!integration) throw AppError.conflict("home_assistant_not_connected", "Home Assistant is not connected.");
  if (integration.protocolVersion !== 3) {
    throw AppError.conflict("home_assistant_protocol_outdated", "The Home Assistant integration must be updated.");
  }
  const capabilities = integration.capabilitiesJson
    ? JSON.parse(integration.capabilitiesJson) as { aiTask?: { state?: string } }
    : null;
  if (capabilities?.aiTask?.state && capabilities.aiTask.state !== "ok") {
    throw AppError.conflict("ai_task_not_configured", "No usable Home Assistant AI Task is configured.");
  }
  return integration;
}

function roundOrThrow(db: Db, id: string, viewerMemberId: number | null): RoundRow {
  const round = db.select().from(schema.cleanupRounds).where(eq(schema.cleanupRounds.id, id)).get();
  if (!round || round.createdByMemberId !== viewerMemberId) {
    throw AppError.notFound("cleanup_round_not_found", "The Klärungsrunde was not found.");
  }
  if (round.expiresAt <= nowIso()) {
    throw new AppError(410, "cleanup_round_expired", "The Klärungsrunde has expired.");
  }
  return round;
}

function roundItems(db: Db, roundId: string): ItemRow[] {
  return db.select().from(schema.cleanupRoundItems)
    .where(eq(schema.cleanupRoundItems.cleanupRoundId, roundId))
    .orderBy(asc(schema.cleanupRoundItems.position))
    .all();
}

function activeTargetKeys(db: Db, now: string): Set<string> {
  const rows = db.select({
    targetType: schema.cleanupRoundItems.targetType,
    targetId: schema.cleanupRoundItems.targetId,
  }).from(schema.cleanupRoundItems)
    .innerJoin(schema.cleanupRounds, eq(schema.cleanupRounds.id, schema.cleanupRoundItems.cleanupRoundId))
    .where(and(
      inArray(schema.cleanupRounds.status, ACTIVE_ROUND_STATUSES),
      gt(schema.cleanupRounds.expiresAt, now),
      inArray(schema.cleanupRoundItems.status, OPEN_ITEM_STATUSES),
    ))
    .all();
  return new Set(rows.map((row) => `${row.targetType}:${row.targetId}`));
}

function enqueueAnalysis(
  db: Db,
  integrationId: number,
  roundId: string,
  items: CleanupItemContext[],
  validationIssues: CleanupValidationIssue[],
  signal: HomeAssistantRequestSignal,
): void {
  enqueueHomeAssistantRequest(db, {
    integrationId,
    cleanupRoundId: roundId,
    kind: "cleanup_round_analyze",
    payload: {
      cleanupRoundId: roundId,
      taskName: TASK_NAME,
      instructions: buildCleanupRoundInstructions({ items, validationIssues }),
      items,
    },
  }, signal);
}

export function purgeExpiredCleanupRounds(db: Db, now = new Date()): void {
  db.delete(schema.cleanupRounds)
    .where(lte(schema.cleanupRounds.expiresAt, now.toISOString()))
    .run();
}

export function createCleanupRound(
  db: Db,
  signal: HomeAssistantRequestSignal,
  input: {
    scope: WorkItemScope;
    actorMemberId: number | null;
    createdByMemberId: number | null;
    random?: () => number;
  },
): string {
  const integration = readyIntegration(db);
  purgeExpiredCleanupRounds(db);
  const now = new Date();
  const createdAt = now.toISOString();
  // Viewer-restricted read: work-scope items are only sampled for their owner.
  const graph = Graph.load(db, undefined, input.createdByMemberId ?? undefined);
  const items = sampleCleanupCandidates(graph, {
    scope: input.scope,
    excludedKeys: activeTargetKeys(db, createdAt),
    now,
    random: input.random,
  });
  if (items.length === 0) {
    throw AppError.conflict("cleanup_round_no_candidates", "There is nothing to look at right now.");
  }
  const id = randomUUID();
  db.transaction((tx) => {
    tx.insert(schema.cleanupRounds).values({
      id,
      createdByMemberId: input.createdByMemberId,
      actorMemberId: input.actorMemberId,
      scope: input.scope,
      status: "queued",
      revision: 1,
      contextJson: JSON.stringify(items),
      createdAt,
      updatedAt: createdAt,
      expiresAt: new Date(now.getTime() + DAY_MS).toISOString(),
    }).run();
    items.forEach((item, position) => {
      tx.insert(schema.cleanupRoundItems).values({
        id: randomUUID(),
        cleanupRoundId: id,
        targetType: item.targetType,
        targetId: item.targetId,
        targetRevision: item.targetRevision,
        contextJson: JSON.stringify(item),
        status: "pending",
        position,
        createdAt,
        updatedAt: createdAt,
      }).run();
    });
    enqueueAnalysis(tx as unknown as Db, integration.id, id, items, [], signal);
  });
  return id;
}

export function getCleanupRound(db: Db, id: string, viewerMemberId: number | null): CleanupRoundRecord {
  const round = roundOrThrow(db, id, viewerMemberId);
  const items = roundItems(db, id);
  const request = db.select({ status: schema.homeAssistantRequests.status })
    .from(schema.homeAssistantRequests)
    .where(eq(schema.homeAssistantRequests.cleanupRoundId, id))
    .orderBy(desc(schema.homeAssistantRequests.createdAt))
    .get();
  const ids = items.map((item) => item.targetId);
  const current = new Map(
    (ids.length === 0 ? [] : db.select({
      id: schema.workItems.id,
      role: schema.workItems.role,
      title: schema.workItems.title,
    }).from(schema.workItems).where(inArray(schema.workItems.id, ids)).all())
      .map((row) => [row.id, row]),
  );
  const result = parseJson<{ summary: string; warnings: Array<{ message: string }> }>(round.resultJson);
  const integration = activeHomeAssistantIntegration(db);
  return {
    id: round.id,
    status: round.status === "queued" && request?.status === "leased" ? "analyzing" : round.status,
    revision: round.revision,
    scope: round.scope,
    createdAt: round.createdAt,
    updatedAt: round.updatedAt,
    expiresAt: round.expiresAt,
    summary: result?.summary || null,
    items: items.map((item) => {
      const context = JSON.parse(item.contextJson) as CleanupItemContext;
      const row = current.get(item.targetId);
      const exists = row !== undefined
        && (row.role === "task") === (item.targetType === "task");
      return {
        id: item.id,
        targetType: item.targetType,
        targetId: item.targetId,
        targetRevision: item.targetRevision,
        status: item.status,
        title: exists ? row.title : context.item.title,
        exists,
        projectTitle: context.hierarchy.projectTitle ?? null,
        parentTitle: context.hierarchy.parentTitle ?? null,
        itemStatus: context.item.status,
        result: parseJson<CleanupTriageResult>(item.resultJson),
      };
    }),
    warnings: result?.warnings ?? [],
    error: parseJson<CleanupRoundErrorInfo>(round.errorJson),
    homeAssistant: {
      workerOnline: Boolean(
        integration?.lastRequestPollAt
        && Date.now() - new Date(integration.lastRequestPollAt).getTime() < 90_000,
      ),
    },
  };
}

function awaitingAnalysis(round: RoundRow): boolean {
  return round.status === "queued" || round.status === "analyzing";
}

/** Applies a validated AI Task response. Never mutates work items. */
export function onCleanupRoundAnalyzed(db: Db, round: RoundRow, raw: unknown): void {
  // A dismissed/settled round must not be revived by a late result.
  if (!awaitingAnalysis(round)) return;
  const items = roundItems(db, round.id).filter((item) => item.status === "pending");
  if (items.length === 0) {
    // Every card was handled while the analysis was running.
    db.update(schema.cleanupRounds).set({
      status: "completed",
      rawResponseJson: JSON.stringify(raw ?? null),
      revision: round.revision + 1,
      updatedAt: nowIso(),
    }).where(eq(schema.cleanupRounds.id, round.id)).run();
    return;
  }
  const outcome = validateCleanupRoundResponse(raw, items);
  const now = nowIso();
  const results = outcome.response?.results ?? [];
  const status: CleanupRoundStatus = outcome.issues.length === 0 && results.length > 0
    ? "ready"
    : results.length > 0 ? "partial" : "failed";
  const error = status === "ready"
    ? null
    : errorInfo(
        "ai_task_invalid_response",
        status === "partial"
          ? "Some AI Task results were ignored."
          : "The AI Task returned no usable results.",
        { issues: outcome.issues.slice(0, 50) },
      );
  db.update(schema.cleanupRounds).set({
    status,
    rawResponseJson: JSON.stringify(raw ?? null),
    resultJson: outcome.response
      ? JSON.stringify(outcome.response)
      : null,
    errorJson: error ? JSON.stringify(error) : null,
    revision: round.revision + 1,
    updatedAt: now,
  }).where(eq(schema.cleanupRounds.id, round.id)).run();
  for (const item of items) {
    const result = results.find(
      (candidate) => candidate.targetType === item.targetType && candidate.targetId === item.targetId,
    );
    db.update(schema.cleanupRoundItems).set({
      status: result ? "ready" : "failed",
      resultJson: result ? JSON.stringify(result) : null,
      updatedAt: now,
    }).where(eq(schema.cleanupRoundItems.id, item.id)).run();
  }
}

export function onCleanupRoundRequestFailed(
  db: Db,
  round: RoundRow,
  error: { code: string; message: string; details?: CleanupRoundErrorInfo["details"] },
): void {
  if (!awaitingAnalysis(round)) return;
  const now = nowIso();
  db.update(schema.cleanupRounds).set({
    status: "failed",
    errorJson: JSON.stringify(errorInfo(error.code || "ai_task_failed", error.message, error.details)),
    revision: round.revision + 1,
    updatedAt: now,
  }).where(eq(schema.cleanupRounds.id, round.id)).run();
  db.update(schema.cleanupRoundItems).set({ status: "failed", updatedAt: now })
    .where(and(
      eq(schema.cleanupRoundItems.cleanupRoundId, round.id),
      eq(schema.cleanupRoundItems.status, "pending"),
    )).run();
}

export function retryCleanupRound(
  db: Db,
  signal: HomeAssistantRequestSignal,
  id: string,
  viewerMemberId: number | null,
): void {
  const round = roundOrThrow(db, id, viewerMemberId);
  if (round.status !== "failed" && round.status !== "partial") {
    throw AppError.conflict("cleanup_round_state_conflict", "Only failed or partial rounds can be retried.");
  }
  const integration = readyIntegration(db);
  const openItems = roundItems(db, id).filter((item) => item.status === "ready" || item.status === "failed");
  if (openItems.length === 0) {
    throw AppError.conflict("cleanup_round_state_conflict", "No open items remain in this round.");
  }
  const previousIssues = parseJson<CleanupRoundErrorInfo>(round.errorJson)?.details?.issues ?? [];
  db.transaction((tx) => {
    const now = nowIso();
    const updated = tx.update(schema.cleanupRounds).set({
      status: "queued",
      errorJson: null,
      revision: round.revision + 1,
      updatedAt: now,
    }).where(and(
      eq(schema.cleanupRounds.id, id),
      eq(schema.cleanupRounds.revision, round.revision),
    )).run();
    if (updated.changes !== 1) {
      throw AppError.conflict("stale_write_conflict", "The Klärungsrunde has changed since it was read.");
    }
    tx.update(schema.cleanupRoundItems).set({ status: "pending", resultJson: null, updatedAt: now })
      .where(inArray(schema.cleanupRoundItems.id, openItems.map((item) => item.id)))
      .run();
    enqueueAnalysis(
      tx as unknown as Db,
      integration.id,
      id,
      openItems.map((item) => JSON.parse(item.contextJson) as CleanupItemContext),
      previousIssues,
      signal,
    );
  });
}

export function dismissCleanupRound(db: Db, id: string, viewerMemberId: number | null): void {
  const round = roundOrThrow(db, id, viewerMemberId);
  if (round.status === "dismissed" || round.status === "completed") return;
  const now = nowIso();
  db.transaction((tx) => {
    tx.update(schema.cleanupRounds).set({
      status: "dismissed",
      revision: round.revision + 1,
      updatedAt: now,
    }).where(eq(schema.cleanupRounds.id, id)).run();
    // Withdraw outstanding analysis so it is neither leased nor completed later.
    tx.update(schema.homeAssistantRequests).set({
      status: "failed",
      error: JSON.stringify({ code: "cleanup_round_dismissed", message: "The cleanup round was dismissed.", retryable: false }),
      completedAt: now,
      leaseExpiresAt: null,
    }).where(and(
      eq(schema.homeAssistantRequests.cleanupRoundId, id),
      inArray(schema.homeAssistantRequests.status, ["queued", "leased"]),
    )).run();
  });
}

/**
 * Resolves one card. `reviewed` additionally acknowledges the target
 * through the canonical Review acknowledgement (`reviewedAt = now`), in the
 * same transaction as the item transition.
 */
export function resolveCleanupRoundItem(
  db: Db,
  input: {
    roundId: string;
    itemId: string;
    viewerMemberId: number | null;
    actorMemberId: number | null;
    resolution: "dismissed" | "reviewed";
  },
): void {
  db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const round = roundOrThrow(txDb, input.roundId, input.viewerMemberId);
    if (round.status === "dismissed" || round.status === "completed") {
      throw AppError.conflict("cleanup_round_state_conflict", "This Klärungsrunde is already closed.");
    }
    const item = tx.select().from(schema.cleanupRoundItems).where(and(
      eq(schema.cleanupRoundItems.id, input.itemId),
      eq(schema.cleanupRoundItems.cleanupRoundId, input.roundId),
    )).get();
    if (!item) throw AppError.notFound("cleanup_round_item_not_found", "The Klärungsrunde item was not found.");
    if (!OPEN_ITEM_STATUSES.includes(item.status)) {
      throw AppError.conflict("cleanup_round_state_conflict", "This item has already been handled.");
    }
    if (input.resolution === "reviewed") {
      const context = { actorMemberId: input.actorMemberId };
      if (item.targetType === "task") acknowledgeTaskReview(txDb, item.targetId, undefined, context);
      else acknowledgeProjectReview(txDb, item.targetId, undefined, context);
    }
    const now = nowIso();
    tx.update(schema.cleanupRoundItems).set({ status: input.resolution, updatedAt: now })
      .where(eq(schema.cleanupRoundItems.id, item.id)).run();
    const remaining = roundItems(txDb, input.roundId).filter(
      (candidate) => candidate.id !== item.id && OPEN_ITEM_STATUSES.includes(candidate.status),
    );
    const settled = round.status === "ready" || round.status === "partial" || round.status === "failed";
    tx.update(schema.cleanupRounds).set({
      status: remaining.length === 0 && settled ? "completed" : round.status,
      revision: round.revision + 1,
      updatedAt: now,
    }).where(eq(schema.cleanupRounds.id, round.id)).run();
  });
}
