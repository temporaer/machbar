import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, lte } from "drizzle-orm";
import type {
  HomeAssistantCalendarEventRef,
  HomeAssistantRequestErrorCode,
  IntakeDraft,
  IntakeErrorInfo,
  IntakeIssue,
  IntakePlan,
  IntakeRecord,
  WorkItemScope,
} from "@machbar/shared";
import {
  buildDraftFromPlan,
  intakeErrorIssues,
  intakeDraftIssues,
  isIntakeIssueCode,
  normalizeIntakePlan,
} from "@machbar/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import type { Env } from "../env.js";
import { AppError } from "../errors.js";
import { activeHomeAssistantIntegration } from "../integrations/homeAssistant.js";
import {
  enqueueHomeAssistantRequest,
  type HomeAssistantRequestSignal,
} from "../integrations/homeAssistantRequests.js";
import { intakePlanStructureSchema } from "../schemas.js";
import { nowIso } from "../domain/workItemShared.js";
import { buildIntakeInstructions } from "./prompt.js";
import { deleteJobFiles, writeAttachment } from "./storage.js";
import { addExternalWorkItemRef } from "../domain/externalWorkItemRefs.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function errorInfo(
  code: IntakeErrorInfo["code"],
  message: string,
  retryable = true,
  details?: IntakeErrorInfo["details"],
): IntakeErrorInfo {
  return { code, message, retryable, ...(details ? { details } : {}) };
}

function parseJson<T>(value: string | null): T | null {
  return value === null ? null : JSON.parse(value) as T;
}

/**
 * Intake jobs can outlive a server deployment. Convert the retired
 * single-reminder field only when the new collection is absent; the old
 * value has the same absolute-instant meaning and is therefore lossless.
 */
export function normalizeStoredIntakeDraft(value: unknown): IntakeDraft | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { workItems?: unknown };
  if (!Array.isArray(candidate.workItems)) return null;
  let changed = false;
  const workItems = candidate.workItems.map((item) => {
    if (!item || typeof item !== "object") return item;
    const workItem = item as Record<string, unknown>;
    if ("reminders" in workItem) return workItem;
    changed = true;
    const reminderAt = workItem.reminderAt;
    const reminders = typeof reminderAt === "string"
      ? [{ kind: "absolute" as const, at: reminderAt }]
      : [];
    const { reminderAt: _legacyReminderAt, ...withoutLegacyReminder } = workItem;
    return { ...withoutLegacyReminder, reminders };
  });
  if (!changed) return value as IntakeDraft;
  return { ...(candidate as object), workItems } as IntakeDraft;
}

function retryValidationIssues(error: IntakeErrorInfo | null): IntakeIssue[] {
  return intakeErrorIssues(error);
}

function jobOrThrow(db: Db, id: string) {
  const job = db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, id)).get();
  if (!job) throw AppError.notFound("intake_not_found", "The intake was not found.");
  if (job.expiresAt <= nowIso()) throw new AppError(410, "intake_expired", "The intake has expired.");
  return job;
}

export function recoverExpiredApplyClaim(
  db: Db,
  job: typeof schema.intakeJobs.$inferSelect,
  now = nowIso(),
): boolean {
  if (
    job.status !== "applying"
    || job.applyClaimToken === null
    || job.applyClaimExpiresAt === null
    || job.applyClaimExpiresAt > now
  ) return false;
  const error: IntakeErrorInfo = {
    code: "intake_apply_partial",
    message: "The previous Apply was interrupted and can be retried.",
    retryable: true,
  };
  const recovered = db.update(schema.intakeJobs).set({
    status: "partially_applied",
    applyClaimToken: null,
    applyClaimExpiresAt: null,
    errorJson: JSON.stringify(error),
    revision: job.revision + 1,
    updatedAt: now,
  }).where(and(
    eq(schema.intakeJobs.id, job.id),
    eq(schema.intakeJobs.status, "applying"),
    eq(schema.intakeJobs.applyClaimToken, job.applyClaimToken),
    lte(schema.intakeJobs.applyClaimExpiresAt, now),
  )).run();
  return recovered.changes === 1;
}

export async function createIntakeJob(
  db: Db,
  env: Env,
  signal: HomeAssistantRequestSignal,
  input: {
    text: string | null;
    files: Array<{ id?: string; filename: string; mimeType: string; data: Buffer }>;
    actorMemberId: number | null;
    createdByMemberId: number | null;
    scope: WorkItemScope;
  },
): Promise<string> {
  const integration = activeHomeAssistantIntegration(db);
  if (!integration) throw AppError.conflict("home_assistant_not_connected", "Home Assistant is not connected.");
  if (integration.protocolVersion !== 3) throw AppError.conflict("home_assistant_protocol_outdated", "The Home Assistant integration must be updated.");
  const capabilities = integration.capabilitiesJson ? JSON.parse(integration.capabilitiesJson) as {
    aiTask?: { state?: string; supportsAttachments?: boolean };
  } : null;
  if (capabilities?.aiTask?.state && capabilities.aiTask.state !== "ok") {
    throw AppError.conflict("ai_task_not_configured", "No usable Home Assistant AI Task is configured.");
  }
  const binaryAttachments = input.files.filter((file) => file.mimeType !== "text/plain");
  if (binaryAttachments.length > 0 && capabilities?.aiTask?.supportsAttachments === false) {
    throw AppError.conflict("ai_task_attachments_unsupported", "The configured AI Task does not support attachments.");
  }

  const id = randomUUID();
  const attachmentRows: Array<{ id: string; filename: string; mimeType: string; sizeBytes: number; sha256: string }> = [];
  try {
    for (const file of input.files) {
      const attachmentId = file.id ?? randomUUID();
      await writeAttachment(env, id, attachmentId, file.data);
      attachmentRows.push({
        id: attachmentId,
        filename: file.filename,
        mimeType: file.mimeType,
        sizeBytes: file.data.length,
        sha256: createHash("sha256").update(file.data).digest("hex"),
      });
    }
    const members = db.select({ name: schema.members.name }).from(schema.members).all();
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + DAY_MS).toISOString();
    db.transaction((tx) => {
      tx.insert(schema.intakeJobs).values({
        id,
        createdByMemberId: input.createdByMemberId,
        actorMemberId: input.actorMemberId,
        scope: input.scope,
        status: "queued",
        revision: 1,
        text: input.text,
        retryHint: null,
        createdAt,
        updatedAt: createdAt,
        expiresAt,
      }).run();
      for (const attachment of attachmentRows) {
        tx.insert(schema.intakeAttachments).values({
          id: attachment.id,
          intakeJobId: id,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          sha256: attachment.sha256,
          createdAt,
        }).run();
      }
      enqueueHomeAssistantRequest(tx as unknown as Db, {
        integrationId: integration.id,
        intakeJobId: id,
        kind: "intake_analyze",
        payload: {
          intakeId: id,
          taskName: "Machbar intake",
          instructions: buildIntakeInstructions({
            today: new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date()),
            timezone: "Europe/Berlin",
            memberNames: members.map((member) => member.name),
            hasText: input.text !== null,
            attachmentCount: binaryAttachments.length,
          }),
          text: input.text,
          attachments: attachmentRows.filter((attachment) => attachment.mimeType !== "text/plain")
            .map(({ id, filename, mimeType, sizeBytes }) => ({ id, filename, mimeType, sizeBytes })),
        },
      }, signal);
    });
    return id;
  } catch (error) {
    await deleteJobFiles(env, id);
    throw error;
  }
}

export function getIntake(
  db: Db,
  id: string,
  viewerMemberId: number | null,
  paperlessAvailable = false,
): IntakeRecord {
  let job = jobOrThrow(db, id);
  if (job.createdByMemberId !== viewerMemberId) throw AppError.notFound("intake_not_found", "The intake was not found.");
  if (recoverExpiredApplyClaim(db, job)) job = jobOrThrow(db, id);
  const request = db.select().from(schema.homeAssistantRequests).where(and(
    eq(schema.homeAssistantRequests.intakeJobId, id),
    eq(schema.homeAssistantRequests.kind, "intake_analyze"),
  )).orderBy(desc(schema.homeAssistantRequests.createdAt)).get();
  const draft = normalizeStoredIntakeDraft(parseJson<unknown>(job.draftJson));
  const error = parseJson<IntakeErrorInfo>(job.errorJson);
  const integration = activeHomeAssistantIntegration(db);
  return {
    id: job.id,
    status: (job.status === "queued" && request?.status === "leased" ? "analyzing" : job.status) as IntakeRecord["status"],
    revision: job.revision,
    createdAt: job.createdAt,
    expiresAt: job.expiresAt,
    text: job.text,
    retryHint: job.retryHint,
    attachments: db.select().from(schema.intakeAttachments).where(eq(schema.intakeAttachments.intakeJobId, id)).all()
      .map(({ id: attachmentId, filename, mimeType, sizeBytes }) => ({ id: attachmentId, filename, mimeType, sizeBytes })),
    draft,
    error,
    applyResults: parseJson(job.applyResultsJson),
    homeAssistant: { workerOnline: Boolean(integration?.lastRequestPollAt && Date.now() - new Date(integration.lastRequestPollAt).getTime() < 90_000) },
    paperlessAvailable,
  };
}

export function onIntakeAnalyzed(db: Db, job: typeof schema.intakeJobs.$inferSelect, plan: IntakePlan): void {
  const parsed = intakePlanStructureSchema.safeParse(plan);
  if (!parsed.success) {
    const issues: IntakeIssue[] = parsed.error.issues.map((item) => {
      const params = "params" in item && item.params && typeof item.params === "object"
        ? item.params as { code?: unknown }
        : undefined;
      return {
        path: item.path,
        code: isIntakeIssueCode(params?.code) ? params.code : "schema_invalid",
        message: item.message.slice(0, 500),
      };
    });
    const info = errorInfo(
      "intake_plan_invalid",
      "The AI Task returned an intake plan that Machbar rejected.",
      true,
      { issues },
    );
    db.update(schema.intakeJobs).set({
      status: "analysis_failed",
      errorJson: JSON.stringify(info),
      updatedAt: nowIso(),
      revision: job.revision + 1,
    }).where(eq(schema.intakeJobs.id, job.id)).run();
    return;
  }
  const members = db.select({ id: schema.members.id, name: schema.members.name }).from(schema.members).all();
  const normalized = normalizeIntakePlan(parsed.data);
  const draft = buildDraftFromPlan(normalized.plan, members);
  db.update(schema.intakeJobs).set({
    status: "ready",
    planJson: JSON.stringify(normalized.plan),
    draftJson: JSON.stringify(draft),
    errorJson: null,
    updatedAt: nowIso(),
    revision: job.revision + 1,
  }).where(eq(schema.intakeJobs.id, job.id)).run();
}

export function onIntakeRequestFailed(
  db: Db,
  job: typeof schema.intakeJobs.$inferSelect,
  request: typeof schema.homeAssistantRequests.$inferSelect,
  error: { code: string; message: string; details?: IntakeErrorInfo["details"] },
): void {
  if (request.kind === "intake_analyze") {
    db.update(schema.intakeJobs).set({
      status: "analysis_failed",
      errorJson: JSON.stringify(errorInfo(
        (error.code as IntakeErrorInfo["code"]) || "ai_task_failed",
        error.message,
        true,
        error.details,
      )),
      updatedAt: nowIso(),
      revision: job.revision + 1,
    }).where(eq(schema.intakeJobs.id, job.id)).run();
    return;
  }
  const results = parseJson<{ work: unknown[]; calendar: Array<{ key: string; correlationId: string; status: string; error: unknown; event: unknown }>; paperlessDocumentIds: number[] }>(job.applyResultsJson);
  if (!results) return;
  const requestPayload = JSON.parse(request.payloadJson) as { correlationId: string };
  const result = results.calendar.find((item) => item.correlationId === requestPayload.correlationId);
  if (result) {
    result.status = "failed";
    result.error = errorInfo((error.code as IntakeErrorInfo["code"]) || "calendar_create_failed", error.message);
  }
  const status = results.calendar.some((item) => item.status === "pending") ? "applying" : "partially_applied";
  db.update(schema.intakeJobs).set({ status, applyResultsJson: JSON.stringify(results), updatedAt: nowIso(), revision: job.revision + 1 }).where(eq(schema.intakeJobs.id, job.id)).run();
}

export function onCalendarCreated(
  db: Db,
  job: typeof schema.intakeJobs.$inferSelect,
  request: typeof schema.homeAssistantRequests.$inferSelect,
  ref: HomeAssistantCalendarEventRef,
): void {
  const payload = JSON.parse(request.payloadJson) as { correlationId: string; title: string };
  if (payload.correlationId !== ref.correlationId) {
    onIntakeRequestFailed(db, job, request, { code: "calendar_create_failed", message: "The calendar correlation ID did not match." });
    return;
  }
  const results = parseJson<{ work: Array<{ key: string; workItemId: number }>; calendar: Array<{ key: string; correlationId: string; status: string; error: unknown; event: unknown }>; paperlessDocumentIds: number[] }>(job.applyResultsJson);
  if (!results) return;
  const event = results.calendar.find((item) => item.correlationId === ref.correlationId);
  if (!event) return;
  event.status = "succeeded";
  event.error = null;
  event.event = { calendarEntityId: ref.calendarEntityId, uid: ref.uid, recurrenceId: ref.recurrenceId, summary: ref.summary, start: ref.start, end: ref.end };
  const acceptedDraft = normalizeStoredIntakeDraft(parseJson<unknown>(job.acceptedDraftJson));
  const eventDraft = acceptedDraft?.calendarEvents.find((item) => item.key === event.key && item.enabled);
  if (acceptedDraft && eventDraft) {
    const workKeys = new Set(eventDraft.relatedWorkKeys);
    for (const item of acceptedDraft.workItems) {
      if (item.enabled && item.relatedCalendarKeys.includes(eventDraft.key)) workKeys.add(item.key);
    }
    for (const work of results.work) if (workKeys.has(work.key) && acceptedDraft.workItems.some((item) => item.enabled && item.key === work.key)) {
      addExternalWorkItemRef(db, work.workItemId, { source: "home_assistant_calendar", calendarEntityId: ref.calendarEntityId, uid: ref.uid, recurrenceId: ref.recurrenceId, summary: ref.summary, start: ref.start, end: ref.end, correlationId: ref.correlationId });
    }
  }
  const status = results.calendar.some((item) => item.status === "pending") ? "applying" : results.calendar.some((item) => item.status === "failed") ? "partially_applied" : "applied";
  db.update(schema.intakeJobs).set({ status, applyResultsJson: JSON.stringify(results), updatedAt: nowIso(), revision: job.revision + 1 }).where(eq(schema.intakeJobs.id, job.id)).run();
}

export function updateIntakeDraft(db: Db, id: string, viewerMemberId: number | null, input: { expectedRevision: number; draft: IntakeDraft }, options = { paperlessAvailable: false, hasFiles: false }): void {
  const current = db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, id)).get();
  if (!current) throw AppError.notFound("intake_not_found", "The intake was not found.");
  if (current.expiresAt <= nowIso()) throw new AppError(410, "intake_expired", "The intake has expired.");
  if (current.createdByMemberId !== viewerMemberId) throw AppError.notFound("intake_not_found", "The intake was not found.");
  if (current.status !== "ready" || current.acceptedDraftJson !== null) {
    throw AppError.conflict("intake_state_conflict", "The intake can only be edited before Apply starts.");
  }
  if (current.revision !== input.expectedRevision) throw AppError.conflict("stale_write_conflict", "The intake has changed since it was read.", { expectedRevision: input.expectedRevision, actualRevision: current.revision });
  db.transaction((tx) => {
    const job = tx.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, id)).get();
    if (!job) throw AppError.notFound("intake_not_found", "The intake was not found.");
    if (job.expiresAt <= nowIso()) throw new AppError(410, "intake_expired", "The intake has expired.");
    if (job.createdByMemberId !== viewerMemberId) throw AppError.notFound("intake_not_found", "The intake was not found.");
    if (job.status !== "ready" || job.acceptedDraftJson !== null) {
      throw AppError.conflict("intake_state_conflict", "The intake can only be edited before Apply starts.");
    }
    if (job.revision !== input.expectedRevision) throw AppError.conflict("stale_write_conflict", "The intake has changed since it was read.", { expectedRevision: input.expectedRevision, actualRevision: job.revision });
    const updated = tx.update(schema.intakeJobs)
      .set({
        draftJson: JSON.stringify(input.draft),
        revision: input.expectedRevision + 1,
        updatedAt: nowIso(),
      })
      .where(and(eq(schema.intakeJobs.id, id), eq(schema.intakeJobs.revision, input.expectedRevision)))
      .run();
    if (updated.changes !== 1) throw AppError.conflict("stale_write_conflict", "The intake has changed since it was read.");
  });
}

export async function retryIntakeAnalysis(
  db: Db,
  env: Env,
  signal: HomeAssistantRequestSignal,
  id: string,
  viewerMemberId: number | null,
  userInstruction?: string | null,
): Promise<void> {
  const job = jobOrThrow(db, id);
  if (job.createdByMemberId !== viewerMemberId) throw AppError.notFound("intake_not_found", "The intake was not found.");
  if (job.status !== "analysis_failed" && job.status !== "ready") {
    throw AppError.conflict("intake_state_conflict", "Only failed or unapplied analyses can be retried.");
  }
  const integration = activeHomeAssistantIntegration(db);
  if (!integration) throw AppError.conflict("home_assistant_not_connected", "Home Assistant is not connected.");
  if (integration.protocolVersion !== 3) throw AppError.conflict("home_assistant_protocol_outdated", "The Home Assistant integration must be updated.");
  const previousError = parseJson<IntakeErrorInfo>(job.errorJson);
  const currentDraft = normalizeStoredIntakeDraft(parseJson<unknown>(job.draftJson));
  const membersForValidation = db.select({ id: schema.members.id }).from(schema.members).all().map((member) => member.id);
  const attachments = db.select().from(schema.intakeAttachments).where(eq(schema.intakeAttachments.intakeJobId, id)).all();
  const validationIssues = job.status === "ready" && currentDraft
    ? intakeDraftIssues(currentDraft, {
        memberIds: membersForValidation,
        paperlessAvailable: false,
        hasFiles: attachments.length > 0,
      })
    : retryValidationIssues(previousError);
  const retryHint = userInstruction === undefined
    ? job.retryHint
    : userInstruction?.trim() || null;
  const members = db.select({ name: schema.members.name }).from(schema.members).all();
  db.transaction((tx) => {
    tx.update(schema.intakeJobs).set({
      status: "queued",
      errorJson: null,
      retryHint,
      revision: job.revision + 1,
      updatedAt: nowIso(),
    }).where(eq(schema.intakeJobs.id, id)).run();
    enqueueHomeAssistantRequest(tx as unknown as Db, {
      integrationId: integration.id, intakeJobId: id, kind: "intake_analyze",
      payload: {
        intakeId: id,
        taskName: "Machbar intake",
        instructions: buildIntakeInstructions({
          today: new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date()),
          timezone: "Europe/Berlin",
          memberNames: members.map((m) => m.name),
          hasText: job.text !== null,
          attachmentCount: attachments.filter((attachment) => attachment.mimeType !== "text/plain").length,
          validationIssues,
          userInstruction: retryHint,
        }),
        text: job.text,
        attachments: attachments
          .filter((attachment) => attachment.mimeType !== "text/plain")
          .map(({ id: attachmentId, filename, mimeType, sizeBytes }) => ({ id: attachmentId, filename, mimeType, sizeBytes })),
      },
    }, signal);
  });
}

export async function deleteIntake(db: Db, env: Env, id: string, viewerMemberId: number | null): Promise<void> {
  const job = jobOrThrow(db, id);
  if (job.createdByMemberId !== viewerMemberId) throw AppError.notFound("intake_not_found", "The intake was not found.");
  db.delete(schema.intakeJobs).where(eq(schema.intakeJobs.id, id)).run();
  await deleteJobFiles(env, id);
}

export function purgeExpiredIntakes(db: Db, env: Env, now = new Date()): Promise<void> {
  const jobs = db.select({ id: schema.intakeJobs.id }).from(schema.intakeJobs).where(lte(schema.intakeJobs.expiresAt, now.toISOString())).all();
  for (const job of jobs) db.delete(schema.intakeJobs).where(eq(schema.intakeJobs.id, job.id)).run();
  return Promise.all(jobs.map((job) => deleteJobFiles(env, job.id))).then(async () => {
    const root = env.dataDir + "/intake";
    try {
      const entries = await (await import("node:fs/promises")).readdir(root, { withFileTypes: true });
      const known = new Set(db.select({ id: schema.intakeJobs.id }).from(schema.intakeJobs).all().map((job) => job.id));
      await Promise.all(entries.filter((entry) => entry.isDirectory() && !known.has(entry.name)).map((entry) => deleteJobFiles(env, entry.name).catch(() => undefined)));
    } catch { /* absent root is fine */ }
  });
}
