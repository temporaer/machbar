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

export const MAX_ATTEMPTS = 3;
const LEASE_MS = { intake_analyze: 180_000, calendar_create: 60_000 } as const;

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

type RequestKind = "intake_analyze" | "calendar_create";

export function enqueueHomeAssistantRequest(
  tx: Db,
  input: {
    integrationId: number;
    intakeJobId: string;
    kind: RequestKind;
    payload: unknown;
  },
  signal?: HomeAssistantRequestSignal,
): string {
  const id = randomUUID();
  tx.insert(schema.homeAssistantRequests).values({
    id,
    integrationId: input.integrationId,
    intakeJobId: input.intakeJobId,
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
        const job = tx.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, row.intakeJobId)).get();
        if (job) onIntakeRequestFailed(tx as unknown as Db, job, row, error);
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
    if (row.status !== "leased" || row.leaseToken !== completion.leaseToken) {
      throw AppError.conflict("home_assistant_request_lease_lost", "The Home Assistant request lease is no longer valid.");
    }
    const job = tx.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, row.intakeJobId)).get();
    if (!job) throw AppError.notFound("home_assistant_request_not_found", "The intake request no longer exists.");
    const now = new Date().toISOString();
    if (completion.outcome === "failed") {
      tx.update(schema.homeAssistantRequests).set({
        status: "failed",
        error: JSON.stringify(completion.error),
        completedAt: now,
        resultJson: null,
      }).where(eq(schema.homeAssistantRequests.id, id)).run();
      onIntakeRequestFailed(tx as unknown as Db, job, row, completion.error);
      return;
    }
    tx.update(schema.homeAssistantRequests).set({
      status: "succeeded",
      resultJson: JSON.stringify(completion.result),
      completedAt: now,
      error: null,
      leaseExpiresAt: null,
    }).where(eq(schema.homeAssistantRequests.id, id)).run();
    if (row.kind === "intake_analyze") {
      onIntakeAnalyzed(tx as unknown as Db, job, completion.result as IntakePlan);
    } else {
      onCalendarCreated(tx as unknown as Db, job, row, completion.result as never);
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
