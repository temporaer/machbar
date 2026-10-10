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
  normalizeWorkRefinementProposalInput,
  unacceptedWorkRefinementProposal,
  workRefinementProposalSchema,
  type WorkRefinementIntent,
} from "@machbar/shared";
import {
  buildDraftFromPlan,
  intakeErrorIssues,
  intakeDraftIssues,
  isIntakeIssueCode,
  normalizeIntakeDraftInput,
  normalizeIntakeNullableAbsenceFields,
  normalizeIntakePlanInput,
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
import { lifecycleToTaskStatus, type WorkItemLifecycle } from "../domain/workItem.js";
import { buildIntakeInstructions } from "./prompt.js";
import { deleteJobFiles, writeAttachment } from "./storage.js";
import { addExternalWorkItemRef } from "../domain/externalWorkItemRefs.js";
import { getHouseholdAiContext } from "../aiContext.js";
import { assertBreakdownDraft, breakdownSnapshot, breakdownSourceText, breakdownTask } from "./breakdown.js";
import { assertRefinementContext } from "./refinement.js";
import { buildRefinementSnapshot } from "./refinementSnapshot.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_INTAKE_TIMEZONE = "Europe/Berlin";

function intakeTimezone(db: Db): string {
  const row = db
    .select({ value: schema.householdSettings.value })
    .from(schema.householdSettings)
    .where(eq(schema.householdSettings.key, "timezone"))
    .get();
  const timezone = row?.value ?? DEFAULT_INTAKE_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
    return timezone;
  } catch {
    return DEFAULT_INTAKE_TIMEZONE;
  }
}

function intakeLocalDateTime(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}`;
}

function errorInfo(
  code: IntakeErrorInfo["code"],
  message: string,
  retryable = true,
  details?: IntakeErrorInfo["details"],
): IntakeErrorInfo {
  return { code, message, retryable, ...(details ? { details } : {}) };
}

function refinementSchemaIssues(
  issues: readonly { path: readonly (string | number)[]; message: string }[],
): IntakeIssue[] {
  return issues.slice(0, 50).map((issue) => ({
    path: [...issue.path],
    code: "schema_invalid",
    message: issue.message.slice(0, 500),
  }));
}

function parseJson<T>(value: string | null): T | null {
  return value === null ? null : JSON.parse(value) as T;
}

const SAFE_CONTRACT_PREVIEW_FIELDS = new Set([
  "key",
  "parentKey",
  "relatedWorkKeys",
  "relatedCalendarKeys",
  "dueDate",
  "scheduledDate",
  "revisitAt",
  "notBeforeDate",
  "notBeforeAt",
  "startDate",
  "endDate",
  "startDateTime",
  "endDateTime",
  "at",
]);

function valueAtPath(value: unknown, path: readonly (string | number)[]): unknown {
  let current = value;
  for (const segment of path) {
    if (current === null || current === undefined) return undefined;
    if (typeof segment === "number" && Array.isArray(current)) {
      current = current[segment];
    } else if (typeof segment === "string" && typeof current === "object" && !Array.isArray(current)) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function valueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value === undefined) return "missing";
  return typeof value;
}

function safeContractPreview(path: readonly (string | number)[], value: unknown): string | null {
  if (!path.some((segment) => typeof segment === "string" && SAFE_CONTRACT_PREVIEW_FIELDS.has(segment))) {
    return null;
  }
  if (typeof value !== "string") return null;
  const bounded = value.slice(0, 80).replace(/[\r\n\t]/g, " ");
  return `"${bounded}${value.length > 80 ? "..." : ""}"`;
}

function structuralIssueMessage(
  path: readonly (string | number)[],
  raw: unknown,
  message: string,
): string {
  const value = valueAtPath(raw, path);
  const preview = safeContractPreview(path, value);
  return `${message.slice(0, 350)} Received ${valueType(value)}${preview ? ` ${preview}` : ""}.`;
}

/**
 * Intake jobs can outlive a server deployment. Convert the retired
 * single-reminder field only when the new collection is absent; the old
 * value has the same absolute-instant meaning and is therefore lossless.
 */
export function normalizeStoredIntakeDraft(value: unknown): IntakeDraft | null {
  if (!value || typeof value !== "object") return null;
  const normalizedValue = normalizeIntakeNullableAbsenceFields(value);
  const candidate = normalizedValue as { workItems?: unknown };
  if (!Array.isArray(candidate.workItems)) return null;
  const workItems = candidate.workItems.map((item) => {
    if (!item || typeof item !== "object") return item;
    const workItem = item as Record<string, unknown>;
    if ("reminders" in workItem) return workItem;
    const reminderAt = workItem.reminderAt;
    const reminders = typeof reminderAt === "string"
      ? [{ kind: "absolute" as const, at: reminderAt }]
      : [];
    const { reminderAt: _legacyReminderAt, ...withoutLegacyReminder } = workItem;
    return { ...withoutLegacyReminder, reminders };
  });
  return normalizeIntakeDraftInput({
    ...(candidate as object),
    workItems,
  }) as IntakeDraft;
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
    breakdown?: { taskId: number; expectedRevision: number; instruction: string | null };
    refinement?: { targetType: "task" | "project"; targetId: number; intent: WorkRefinementIntent; instruction?: string; snapshot: string };
  },
): Promise<string> {
  const integration = activeHomeAssistantIntegration(db);
  const sourceTask = input.breakdown
    ? breakdownTask(db, input.breakdown.taskId, input.createdByMemberId)
    : null;
  if (sourceTask && sourceTask.revision !== input.breakdown!.expectedRevision) {
    throw AppError.conflict("stale_write_conflict", "The task changed before starting the breakdown.");
  }
  const sourceSnapshot = sourceTask ? breakdownSnapshot(db, sourceTask.id) : null;
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
    const promptNow = new Date();
    const promptTimezone = intakeTimezone(db);
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
        breakdownTaskId: sourceTask?.id ?? null,
        breakdownSnapshotJson: sourceSnapshot,
        breakdownInstruction: input.breakdown?.instruction ?? null,
        refinementTargetType: input.refinement?.targetType ?? null,
        refinementTargetId: input.refinement?.targetId ?? null,
        refinementIntent: input.refinement?.intent ?? null,
        refinementInstruction: input.refinement?.instruction?.trim() || null,
        refinementSnapshotJson: input.refinement?.snapshot ?? null,
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
            today: new Intl.DateTimeFormat("en-CA", { timeZone: promptTimezone }).format(promptNow),
            timezone: promptTimezone,
            currentLocalDateTime: intakeLocalDateTime(promptNow, promptTimezone),
            memberNames: members.map((member) => member.name),
            hasText: input.text !== null,
            attachmentCount: binaryAttachments.length,
            aiContext: getHouseholdAiContext(db),
            breakdownInstruction: sourceTask ? input.breakdown?.instruction ?? "" : undefined,
            refinement: input.refinement ? {
              targetType: input.refinement.targetType,
              intent: input.refinement.intent,
              ...(input.refinement.instruction ? { instruction: input.refinement.instruction } : {}),
              context: input.refinement.snapshot,
            } : undefined,
          }),
          ...(input.refinement ? { analysisMode: "work_refinement" } : {}),
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
  const breakdownRows = job.breakdownSnapshotJson ? JSON.parse(job.breakdownSnapshotJson) as Array<{
    id: number;
    parentId: number | null;
    title: string;
    status: WorkItemLifecycle;
    ownerMemberId: number | null;
    scheduledDate: string | null;
    revisitAt: string | null;
    notBeforeAt: string | null;
    notBeforeDate: string | null;
    priority: number | null;
    size: "S" | "M" | "L" | "XL" | null;
  }> : [];
  const breakdownSource = job.breakdownTaskId === null
    ? null
    : breakdownRows.find((row) => row.id === job.breakdownTaskId) ?? null;
  return {
    id: job.id,
    status: (job.status === "queued" && request?.status === "leased" ? "analyzing" : job.status) as IntakeRecord["status"],
    revision: job.revision,
    createdAt: job.createdAt,
    expiresAt: job.expiresAt,
    text: job.text,
    retryHint: job.retryHint,
    breakdown: job.breakdownTaskId === null ? null : {
      taskId: job.breakdownTaskId,
      instruction: job.breakdownInstruction ?? "",
      sourceStatus: (() => {
        const status = breakdownSource ? lifecycleToTaskStatus(breakdownSource.status) : "captured";
        return status === "captured" || status === "actionable" || status === "someday" ? status : "captured";
      })(),
      sourceOwnerMemberId: breakdownSource?.ownerMemberId ?? null,
      scheduledDate: breakdownSource?.scheduledDate ?? null,
      revisitAt: breakdownSource?.revisitAt ?? null,
      notBeforeAt: breakdownSource?.notBeforeAt ?? null,
      notBeforeDate: breakdownSource?.notBeforeDate ?? null,
      priority: breakdownSource?.priority ?? null,
      size: breakdownSource?.size ?? null,
      existingChildren: (() => {
        const rows = breakdownRows;
        const byParent = new Map<number, typeof rows>();
        for (const row of rows) if (row.parentId !== null) byParent.set(row.parentId, [...(byParent.get(row.parentId) ?? []), row]);
        const result: Array<{ id: number; title: string; status: string; depth: number }> = [];
        const visit = (parentId: number, depth: number) => {
          for (const row of byParent.get(parentId) ?? []) {
            result.push({ id: row.id, title: row.title, status: row.status, depth });
            visit(row.id, depth + 1);
          }
        };
        visit(job.breakdownTaskId!, 0);
        return result;
      })(),
    },
    refinement: job.refinementTargetType && job.refinementTargetId !== null && job.refinementIntent ? {
      targetType: job.refinementTargetType,
      targetId: job.refinementTargetId,
      intent: job.refinementIntent as WorkRefinementIntent,
      proposal: parseJson(job.refinementJson),
    } : null,
    attachments: db.select().from(schema.intakeAttachments).where(eq(schema.intakeAttachments.intakeJobId, id)).all()
      .map(({ id: attachmentId, filename, mimeType, sizeBytes }) => ({ id: attachmentId, filename, mimeType, sizeBytes })),
    draft,
    error,
    applyResults: parseJson(job.applyResultsJson),
    homeAssistant: { workerOnline: Boolean(integration?.lastRequestPollAt && Date.now() - new Date(integration.lastRequestPollAt).getTime() < 90_000) },
    paperlessAvailable,
  };
}

export function onIntakeAnalyzed(db: Db, job: typeof schema.intakeJobs.$inferSelect, plan: unknown): void {
  if (job.refinementTargetType !== null) {
    const parsed = workRefinementProposalSchema.safeParse(normalizeWorkRefinementProposalInput(plan));
    const issues = !parsed.success
      ? refinementSchemaIssues(parsed.error.issues)
      : parsed.data.intent !== job.refinementIntent
        ? [{
            path: ["intent"],
            code: "schema_invalid" as const,
            message: `The proposal intent must be '${job.refinementIntent}'.`,
          }]
        : [];
    if (issues.length > 0) {
      db.update(schema.intakeJobs).set({
        status: "analysis_failed",
        errorJson: JSON.stringify(errorInfo(
          "intake_plan_invalid",
          parsed.success ? "The AI Task returned a refinement proposal for the wrong intent." : "The AI Task returned an invalid refinement proposal.",
          true,
          { issues },
        )),
        updatedAt: nowIso(), revision: job.revision + 1,
      }).where(eq(schema.intakeJobs.id, job.id)).run();
      return;
    }
    const proposal = unacceptedWorkRefinementProposal(parsed.data);
    try {
      assertRefinementContext(proposal, job.refinementTargetType, job.refinementTargetId!, JSON.parse(job.refinementSnapshotJson ?? "null"), false, db);
    } catch (error) {
      db.update(schema.intakeJobs).set({
        status: "analysis_failed",
        errorJson: JSON.stringify(errorInfo(
          "intake_plan_invalid",
          error instanceof Error ? error.message : "The refinement is structurally incompatible.",
          true,
          {
            issues: [{
              path: ["context"],
              code: "schema_invalid",
              message: error instanceof Error ? error.message : "The refinement is structurally incompatible.",
            }],
          },
        )),
        updatedAt: nowIso(), revision: job.revision + 1,
      }).where(eq(schema.intakeJobs.id, job.id)).run();
      return;
    }
    db.update(schema.intakeJobs).set({
      status: "ready", refinementJson: JSON.stringify(proposal), errorJson: null,
      updatedAt: nowIso(), revision: job.revision + 1,
    }).where(eq(schema.intakeJobs.id, job.id)).run();
    return;
  }
  const members = db.select({ id: schema.members.id, name: schema.members.name }).from(schema.members).all();
  const normalizedInput = normalizeIntakePlanInput(plan, {
    ownerNames: members.map((member) => member.name),
  });
  const parsed = intakePlanStructureSchema.safeParse(normalizedInput);
  if (!parsed.success) {
    const issues: IntakeIssue[] = parsed.error.issues.map((item) => {
      const params = "params" in item && item.params && typeof item.params === "object"
        ? item.params as { code?: unknown }
        : undefined;
      return {
        path: item.path,
        code: isIntakeIssueCode(params?.code) ? params.code : "schema_invalid",
        message: structuralIssueMessage(item.path, normalizedInput, item.message),
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
  const normalized = normalizeIntakePlan(parsed.data as IntakePlan);
  const draft = buildDraftFromPlan(normalized.plan, members);
  if (job.breakdownTaskId !== null) {
    try {
      const source = breakdownTask(db, job.breakdownTaskId, job.createdByMemberId);
      assertBreakdownDraft(draft, source);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid task breakdown.";
      db.update(schema.intakeJobs).set({
        status: "analysis_failed",
        errorJson: JSON.stringify(errorInfo("intake_plan_invalid", message)),
        updatedAt: nowIso(), revision: job.revision + 1,
      }).where(eq(schema.intakeJobs.id, job.id)).run();
      return;
    }
  }
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
  const normalizedDraft = normalizeStoredIntakeDraft(input.draft) ?? input.draft;
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
        draftJson: JSON.stringify(normalizedDraft),
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
  paperlessAvailable: boolean,
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
  const currentDraftIssues = currentDraft
    ? intakeDraftIssues(currentDraft, {
        memberIds: membersForValidation,
        paperlessAvailable,
        hasFiles: attachments.length > 0,
      })
    : [];
  const previousIssues = retryValidationIssues(previousError);
  const validationIssues = [...currentDraftIssues, ...previousIssues.filter(
    (previousIssue) => !currentDraftIssues.some((currentIssue) =>
      currentIssue.code === previousIssue.code
      && currentIssue.path.join(".") === previousIssue.path.join(".")
      && currentIssue.message === previousIssue.message
    ),
  )];
  const retryHint = userInstruction === undefined
    ? job.retryHint
    : userInstruction?.trim() || null;
  const members = db.select({ id: schema.members.id, name: schema.members.name }).from(schema.members).all();
  const currentProposal = currentDraft ? {
    summary: currentDraft.summary,
    calendarEvents: currentDraft.calendarEvents,
    workItems: currentDraft.workItems.map(({ ownerMemberId, ...item }) => ({
      ...item,
      ownerName: members.find((member) => member.id === ownerMemberId)?.name ?? null,
    })),
    warnings: currentDraft.warnings,
  } : null;
  const promptNow = new Date();
  const promptTimezone = intakeTimezone(db);
  const sourceTask = job.breakdownTaskId !== null
    ? breakdownTask(db, job.breakdownTaskId, viewerMemberId)
    : null;
  const sourceText = sourceTask ? breakdownSourceText(sourceTask) : job.text;
  const sourceSnapshot = sourceTask ? breakdownSnapshot(db, sourceTask.id) : null;
  const previousRefinementProposal = job.refinementJson
    ? parseJson<unknown>(job.refinementJson)
    : null;
  let freshRefinementSnapshot: ReturnType<typeof buildRefinementSnapshot> | null = null;
  db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    freshRefinementSnapshot = job.refinementTargetType && job.refinementTargetId !== null
      ? buildRefinementSnapshot(txDb, job.refinementTargetType, job.refinementTargetId, viewerMemberId)
      : null;
    tx.update(schema.intakeJobs).set({
      status: "queued",
      errorJson: null,
      retryHint,
      ...(sourceTask ? { text: sourceText, breakdownSnapshotJson: sourceSnapshot } : {}),
      ...(freshRefinementSnapshot ? { text: freshRefinementSnapshot.snapshot, scope: freshRefinementSnapshot.scope, refinementSnapshotJson: freshRefinementSnapshot.snapshot } : {}),
      revision: job.revision + 1,
      updatedAt: nowIso(),
    }).where(eq(schema.intakeJobs.id, id)).run();
    enqueueHomeAssistantRequest(tx as unknown as Db, {
      integrationId: integration.id, intakeJobId: id, kind: "intake_analyze",
      payload: {
        intakeId: id,
        taskName: "Machbar intake",
        instructions: buildIntakeInstructions({
          today: new Intl.DateTimeFormat("en-CA", { timeZone: promptTimezone }).format(promptNow),
          timezone: promptTimezone,
          currentLocalDateTime: intakeLocalDateTime(promptNow, promptTimezone),
          memberNames: members.map((member) => member.name),
          hasText: job.text !== null,
          attachmentCount: attachments.filter((attachment) => attachment.mimeType !== "text/plain").length,
          validationIssues,
          currentProposal,
          userInstruction: retryHint,
          aiContext: getHouseholdAiContext(db),
          breakdownInstruction: job.breakdownTaskId !== null ? job.breakdownInstruction ?? "" : undefined,
          refinement: job.refinementTargetType && job.refinementIntent ? {
            targetType: job.refinementTargetType,
            intent: job.refinementIntent as WorkRefinementIntent,
            ...(job.refinementInstruction ? { instruction: job.refinementInstruction } : {}),
            context: freshRefinementSnapshot?.snapshot ?? "{}",
            ...(previousRefinementProposal ? { previousProposal: JSON.stringify(previousRefinementProposal) } : {}),
            ...(retryHint ? { feedback: retryHint } : {}),
            ...(validationIssues.length ? { validationFeedback: validationIssues } : {}),
            ...(previousError?.message ? { validationMessage: previousError.message } : {}),
          } : undefined,
        }),
        ...(job.refinementTargetType ? { analysisMode: "work_refinement" } : {}),
        text: freshRefinementSnapshot?.snapshot ?? sourceText,
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
