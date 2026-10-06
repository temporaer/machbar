import { randomUUID } from "node:crypto";
import { and, asc, eq, lte, or, sql } from "drizzle-orm";
import type {
  HomeAssistantLeasedRequest,
  HomeAssistantRequestCompletion,
  IntakePlan,
} from "@machbar/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { AppError } from "../errors.js";
import { onCalendarCreated, onIntakeAnalyzed, onIntakeRequestFailed } from "../intake/jobs.js";
import { onCleanupRoundAnalyzed, onCleanupRoundRequestFailed } from "../cleanupRound/jobs.js";

export const MAX_ATTEMPTS = 3;
const LEASE_MS = {
  intake_analyze: 180_000,
  calendar_create: 60_000,
  cleanup_round_analyze: 180_000,
} as const;

export class HomeAssistantRequestSignal {
  private listeners = new Set<() => void>();
  notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
  wait(abortSignal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const listener = () => {
        this.listeners.delete(listener);
        resolve();
      };
      this.listeners.add(listener);
      if (abortSignal) {
        const abort = () => {
          this.listeners.delete(listener);
          resolve();
        };
        if (abortSignal.aborted) abort();
        else abortSignal.addEventListener("abort", abort, { once: true });
      }
    });
  }
}

/** Each request is owned by exactly one intake job or Klärungsrunde. */
type RequestOwner =
  | { intakeJobId: string; kind: "intake_analyze" | "calendar_create" }
  | { cleanupRoundId: string; kind: "cleanup_round_analyze" };

export function enqueueHomeAssistantRequest(
  tx: Db,
  input: RequestOwner & {
    integrationId: number;
    payload: unknown;
  },
  signal?: HomeAssistantRequestSignal,
): string {
  const id = randomUUID();
  tx.insert(schema.homeAssistantRequests).values({
    id,
    integrationId: input.integrationId,
    intakeJobId: "intakeJobId" in input ? input.intakeJobId : null,
    cleanupRoundId: "cleanupRoundId" in input ? input.cleanupRoundId : null,
    kind: input.kind,
    payloadJson: JSON.stringify(input.payload),
    status: "queued",
    attempts: 0,
    createdAt: new Date().toISOString(),
  }).run();
  // SQLite commits synchronously; notification happens after the transaction
  // has returned in callers that need to guarantee visibility.
  signal?.notify();
  return id;
}

function requestPayload(row: typeof schema.homeAssistantRequests.$inferSelect): HomeAssistantLeasedRequest["payload"] {
  return JSON.parse(row.payloadJson) as HomeAssistantLeasedRequest["payload"];
}

export function leaseNextHomeAssistantRequest(
  db: Db,
  integrationId: number,
  now = new Date(),
): HomeAssistantLeasedRequest | null {
  return db.transaction((tx) => {
    const nowIso = now.toISOString();
    const rows = tx.select().from(schema.homeAssistantRequests).where(and(
      eq(schema.homeAssistantRequests.integrationId, integrationId),
      or(
        eq(schema.homeAssistantRequests.status, "queued"),
        and(eq(schema.homeAssistantRequests.status, "leased"), lte(schema.homeAssistantRequests.leaseExpiresAt, nowIso)),
      ),
    )).orderBy(asc(schema.homeAssistantRequests.createdAt)).all();
    for (const row of rows) {
      if (row.attempts >= MAX_ATTEMPTS) {
        const error = { code: "home_assistant_request_exhausted", message: "The Home Assistant request exceeded its retry limit.", retryable: false };
        tx.update(schema.homeAssistantRequests).set({
          status: "failed",
          error: JSON.stringify(error),
          completedAt: nowIso,
        }).where(eq(schema.homeAssistantRequests.id, row.id)).run();
        failOwner(tx as unknown as Db, row, error);
        continue;
      }
      const leaseToken = randomUUID();
      const leaseExpiresAt = new Date(now.getTime() + LEASE_MS[row.kind]).toISOString();
      tx.update(schema.homeAssistantRequests).set({
        status: "leased",
        leaseToken,
        leaseExpiresAt,
        attempts: row.attempts + 1,
      }).where(eq(schema.homeAssistantRequests.id, row.id)).run();
      return {
        id: row.id,
        leaseToken,
        leaseExpiresAt,
        kind: row.kind,
        payload: requestPayload(row),
      } as HomeAssistantLeasedRequest;
    }
    return null;
  });
}

type RequestRow = typeof schema.homeAssistantRequests.$inferSelect;

function cleanupRoundFor(db: Db, row: RequestRow) {
  return row.cleanupRoundId === null
    ? undefined
    : db.select().from(schema.cleanupRounds).where(eq(schema.cleanupRounds.id, row.cleanupRoundId)).get();
}

function intakeJobFor(db: Db, row: RequestRow) {
  return row.intakeJobId === null
    ? undefined
    : db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, row.intakeJobId)).get();
}

function failOwner(
  db: Db,
  row: RequestRow,
  error: { code: string; message: string; details?: Record<string, unknown> },
): void {
  if (row.kind === "cleanup_round_analyze") {
    const round = cleanupRoundFor(db, row);
    if (round) onCleanupRoundRequestFailed(db, round, error as never);
    return;
  }
  const job = intakeJobFor(db, row);
  if (job) onIntakeRequestFailed(db, job, row, error as never);
}

export function completeHomeAssistantRequest(
  db: Db,
  integrationId: number,
  id: string,
  completion: HomeAssistantRequestCompletion,
): void {
  db.transaction((tx) => {
    const row = tx.select().from(schema.homeAssistantRequests).where(and(
      eq(schema.homeAssistantRequests.id, id),
      eq(schema.homeAssistantRequests.integrationId, integrationId),
    )).get();
    if (!row) throw AppError.notFound("home_assistant_request_not_found", "The Home Assistant request was not found.");
    const now = new Date().toISOString();
    if (
      row.status !== "leased"
      || row.leaseToken !== completion.leaseToken
      || row.leaseExpiresAt === null
      || row.leaseExpiresAt <= now
    ) {
      throw AppError.conflict("home_assistant_request_lease_lost", "The Home Assistant request lease is no longer valid.");
    }
    const txDb = tx as unknown as Db;
    const round = row.kind === "cleanup_round_analyze" ? cleanupRoundFor(txDb, row) : undefined;
    const job = row.kind === "cleanup_round_analyze" ? undefined : intakeJobFor(txDb, row);
    if (!round && !job) throw AppError.notFound("home_assistant_request_not_found", "The request owner no longer exists.");
    if (completion.outcome === "failed") {
      tx.update(schema.homeAssistantRequests).set({
        status: "failed",
        error: JSON.stringify(completion.error),
        completedAt: now,
        resultJson: null,
      }).where(eq(schema.homeAssistantRequests.id, id)).run();
      failOwner(txDb, row, completion.error as never);
      return;
    }
    tx.update(schema.homeAssistantRequests).set({
      status: "succeeded",
      resultJson: JSON.stringify(completion.result),
      completedAt: now,
      error: null,
      leaseExpiresAt: null,
    }).where(eq(schema.homeAssistantRequests.id, id)).run();
    if (round) {
      onCleanupRoundAnalyzed(txDb, round, completion.result);
    } else if (row.kind === "intake_analyze") {
      onIntakeAnalyzed(txDb, job!, completion.result as IntakePlan);
    } else {
      onCalendarCreated(txDb, job!, row, completion.result as never);
    }
  });
}

export async function waitForHomeAssistantRequest(
  db: Db,
  signal: HomeAssistantRequestSignal,
  integrationId: number,
  waitMs: number,
  abortSignal?: AbortSignal,
): Promise<HomeAssistantLeasedRequest | null> {
  const deadline = Date.now() + waitMs;
  while (true) {
    const leased = leaseNextHomeAssistantRequest(db, integrationId);
    if (leased) return leased;
    const remaining = deadline - Date.now();
    if (remaining <= 0 || abortSignal?.aborted) return null;
    await Promise.race([
      signal.wait(abortSignal),
      new Promise<void>((resolve) => setTimeout(resolve, Math.min(remaining, 1_000))),
    ]);
  }
}
