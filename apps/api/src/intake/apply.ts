import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import {
  INTAKE_TIMEZONE,
  type PaperlessDocumentSummary,
  type IntakeDraft,
  type IntakeApplyResults,
  type IntakeErrorInfo,
  type ProjectActivationResolution,
} from "@machbar/shared";
import {
  intakeSelectedDraftIssues,
  intakeCanonicalPlanning,
  paperlessMarkdownReference,
  prepareIncompleteIntakeDraft,
} from "@machbar/shared";
import type { Db } from "../db/client.js";
import type { FastifyBaseLogger } from "fastify";
import * as schema from "../db/schema.js";
import type { Env } from "../env.js";
import { AppError } from "../errors.js";
import { activeHomeAssistantIntegration } from "../integrations/homeAssistant.js";
import { enqueueHomeAssistantRequest, type HomeAssistantRequestSignal } from "../integrations/homeAssistantRequests.js";
import { appendProjectNotes, createProject, updateProject } from "../domain/storyCrud.js";
import { appendTaskNotes, createChildTask, createTask } from "../domain/taskCrud.js";
import type { MutationContext } from "../domain/workItemShared.js";
import type { PaperlessClient } from "../paperless/client.js";
import { uploadAndResolveDocument } from "../paperless/upload.js";
import { nowIso } from "../domain/workItemShared.js";
import { attachmentPath } from "./storage.js";
import { normalizeStoredIntakeDraft, recoverExpiredApplyClaim } from "./jobs.js";
import { applyBreakdown, assertBreakdownDraft } from "./breakdown.js";

const APPLY_CLAIM_MS = 10 * 60 * 1000;

function parse<T>(value: string | null): T | null {
  return value === null ? null : JSON.parse(value) as T;
}

function failApplyClaim(
  db: Db,
  id: string,
  claimToken: string,
  claimRevision: number,
  error: IntakeErrorInfo,
  hasEffects: boolean,
  draft: IntakeDraft,
): void {
  db.update(schema.intakeJobs).set({
    status: hasEffects ? "partially_applied" : "ready",
    ...(!hasEffects ? { acceptedDraftJson: null, draftJson: JSON.stringify(draft) } : {}),
    applyClaimToken: null,
    applyClaimExpiresAt: null,
    errorJson: JSON.stringify(error),
    revision: claimRevision + 1,
    updatedAt: nowIso(),
  }).where(and(
    eq(schema.intakeJobs.id, id),
    eq(schema.intakeJobs.status, "applying"),
    eq(schema.intakeJobs.applyClaimToken, claimToken),
    eq(schema.intakeJobs.revision, claimRevision),
  )).run();
}

function applyFailureInfo(
  error: unknown,
  logger?: Pick<FastifyBaseLogger, "error">,
): IntakeErrorInfo {
  if (error instanceof AppError && error.code === "intake_source_retention_failed") {
    return { code: "intake_source_retention_failed", message: error.message, retryable: true };
  }
  if (error instanceof AppError) {
    return { code: error.code, message: error.message, retryable: true, ...(error.details ? { details: error.details } : {}) };
  }
  if (logger) logger.error({ err: error }, "Intake Apply failed.");
  else console.error("Intake Apply failed.", error);
  return {
    code: "intake_apply_partial",
    message: "The intake could not be fully applied.",
    retryable: true,
  };
}

export async function applyIntake(
  db: Db,
  env: Env,
  paperless: PaperlessClient | undefined,
  signal: HomeAssistantRequestSignal,
  id: string,
  input: { expectedRevision: number; draft?: IntakeDraft; acceptIncomplete?: boolean; timezone?: string; projectDriverMemberId?: number; activationResolution?: ProjectActivationResolution },
  context: MutationContext,
  viewerMemberId: number | null,
  logger?: Pick<FastifyBaseLogger, "error">,
): Promise<void> {
  let effectiveExpectedRevision = input.expectedRevision;
  let stored = db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, id)).get();
  if (!stored) throw AppError.notFound("intake_not_found", "The intake was not found.");
  if (stored.createdByMemberId !== viewerMemberId) throw AppError.notFound("intake_not_found", "The intake was not found.");
  if (stored.expiresAt <= nowIso()) throw new AppError(410, "intake_expired", "The intake has expired.");
  const revisionBeforeRecovery = stored.revision;
  if (revisionBeforeRecovery !== input.expectedRevision) {
    throw AppError.conflict("stale_write_conflict", "The intake has changed since it was read.");
  }
  if (recoverExpiredApplyClaim(db, stored)) {
    stored = db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, id)).get();
    if (!stored) throw AppError.notFound("intake_not_found", "The intake was not found.");
    effectiveExpectedRevision = stored.revision;
  }
  if (stored.status !== "ready" && stored.status !== "partially_applied") throw AppError.conflict("intake_state_conflict", "The intake is not ready to apply.");
  if (stored.revision !== effectiveExpectedRevision) throw AppError.conflict("stale_write_conflict", "The intake has changed since it was read.");
  if (stored.status === "partially_applied" && stored.acceptedDraftJson === null) {
    throw AppError.conflict("intake_state_conflict", "This partially applied intake has no accepted draft and cannot be safely retried.");
  }
  const acceptedDraft = normalizeStoredIntakeDraft(parse<unknown>(stored.acceptedDraftJson));
  const initialAcceptance = acceptedDraft === null;
  const submittedDraft = acceptedDraft ?? (
    input.draft === undefined
      ? undefined
      : normalizeStoredIntakeDraft(input.draft) ?? input.draft
  );
  let draftToValidate = submittedDraft;
  if (draftToValidate === undefined) throw AppError.badRequest("intake_draft_invalid", "A draft is required for the initial apply.");
  const memberIds = db.select({ id: schema.members.id }).from(schema.members).all().map((member) => member.id);
  const attachments = db.select().from(schema.intakeAttachments)
    .where(eq(schema.intakeAttachments.intakeJobId, id)).all();
  const validationOptions = {
    memberIds,
    paperlessAvailable: Boolean(paperless),
    hasFiles: attachments.length > 0,
    timezone: input.timezone ?? INTAKE_TIMEZONE,
  };
  let incompletePreparation:
    | ReturnType<typeof prepareIncompleteIntakeDraft>
    | undefined;
  if (initialAcceptance && input.acceptIncomplete) {
    incompletePreparation = prepareIncompleteIntakeDraft(draftToValidate, validationOptions);
    draftToValidate = incompletePreparation.draft;
  }
  const validationIssues = incompletePreparation
    ? incompletePreparation.blockingIssues
    : intakeSelectedDraftIssues(draftToValidate, validationOptions);
  const committedWork = initialAcceptance ? [] : parse<IntakeApplyResults>(stored.applyResultsJson)?.work ?? [];
  const issues = validationIssues.filter((issue) => {
    // Old immutable partial drafts may contain planning now rejected for new
    // acceptance. Only grandfather the new checks on ledger-confirmed work
    // that Apply will skip; all hierarchy, reminder and external checks remain.
    if (issue.path[0] !== "workItems" || typeof issue.path[1] !== "number") return true;
    const item = draftToValidate.workItems[issue.path[1]];
    if (!item || !committedWork.some((work) => work.key === item.key && work.kind === item.kind)) return true;
    const field = issue.path[2];
    const newPlanningCheck = issue.code === "planning_conflict"
      || (issue.code === "invalid_datetime" && field === "revisitAt")
      || (issue.code === "reference_field_not_allowed" && field === "revisitAt")
      || (issue.code === "project_field_not_allowed" && field === "scheduledDate");
    return !newPlanningCheck;
  });
  if (issues.length > 0) throw AppError.badRequest("intake_draft_invalid", "The intake draft is invalid.", { issues });
  if (stored.breakdownTaskId !== null) assertBreakdownDraft(draftToValidate);

  const enabledEvents = draftToValidate.calendarEvents.filter((event) => event.enabled);
  const integration = enabledEvents.length > 0 ? activeHomeAssistantIntegration(db) : null;
  if (enabledEvents.length > 0) {
    if (!integration) throw AppError.conflict("home_assistant_not_connected", "Home Assistant is not connected.");
    if (integration.protocolVersion !== 3) throw AppError.conflict("home_assistant_protocol_outdated", "The Home Assistant integration must be updated.");
    const capabilities = integration.capabilitiesJson ? JSON.parse(integration.capabilitiesJson) as { calendar?: { state?: string } } : null;
    if (capabilities?.calendar?.state === "not_writable") throw AppError.conflict("calendar_not_writable", "The configured calendar is not writable.");
    if (capabilities?.calendar?.state !== "ok") throw AppError.conflict("calendar_not_configured", "No writable calendar is configured.");
  }

  const claim = db.transaction((tx) => {
    const current = tx.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, id)).get();
    if (!current) throw AppError.notFound("intake_not_found", "The intake was not found.");
    if (current.expiresAt <= nowIso()) throw new AppError(410, "intake_expired", "The intake has expired.");
    if (current.createdByMemberId !== viewerMemberId) throw AppError.notFound("intake_not_found", "The intake was not found.");
    if (current.revision !== effectiveExpectedRevision) throw AppError.conflict("stale_write_conflict", "The intake has changed since it was read.");
    if (current.status !== "ready" && current.status !== "partially_applied") {
      throw AppError.conflict("intake_state_conflict", "The intake is not ready to apply.");
    }
    if (current.status === "partially_applied" && current.acceptedDraftJson === null) {
      throw AppError.conflict("intake_state_conflict", "This partially applied intake has no accepted draft and cannot be safely retried.");
    }
    const claimDraft = normalizeStoredIntakeDraft(parse<unknown>(current.acceptedDraftJson))
      ?? draftToValidate;
    if (claimDraft === undefined) throw AppError.badRequest("intake_draft_invalid", "A draft is required for the initial apply.");
    const claimToken = randomUUID();
    const claimNow = nowIso();
    const updated = tx.update(schema.intakeJobs)
      .set({
        acceptedDraftJson: JSON.stringify(claimDraft),
        status: "applying",
        applyClaimToken: claimToken,
        applyClaimExpiresAt: new Date(Date.parse(claimNow) + APPLY_CLAIM_MS).toISOString(),
        revision: effectiveExpectedRevision + 1,
        updatedAt: claimNow,
      })
      .where(and(
        eq(schema.intakeJobs.id, id),
        eq(schema.intakeJobs.revision, effectiveExpectedRevision),
        eq(schema.intakeJobs.status, current.status),
      ))
      .run();
    if (updated.changes !== 1) throw AppError.conflict("stale_write_conflict", "The intake has changed since it was read.");
    return { acceptedDraft: claimDraft, claimToken, claimRevision: effectiveExpectedRevision + 1 };
  });
  // Read persisted results, never the in-memory list modified by a rolled-back transaction.
  const fail = (error: unknown) => {
    const current = db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, id)).get();
    const committed = parse<IntakeApplyResults>(current?.applyResultsJson ?? null);
    const hasEffects = Boolean(committed && (committed.work.length || committed.calendar.length || committed.paperlessDocumentIds.length));
    const info = applyFailureInfo(error, logger);
    if (!hasEffects && info.code === "intake_apply_partial") {
      info.code = "intake_apply_failed";
      info.message = "Nothing was applied. Review the proposal and retry.";
    }
    failApplyClaim(db, id, claim.claimToken, claim.claimRevision, info, hasEffects, claim.acceptedDraft);
  };

  try {
  const draft = claim.acceptedDraft;
  let results = parse<IntakeApplyResults>(stored.applyResultsJson) ?? { work: [], calendar: [], paperlessDocumentIds: [] };
  if (draft.retainSourceInPaperless && results.paperlessDocumentIds.length < attachments.length) {
    if (!paperless) throw AppError.conflict("intake_source_retention_failed", "Paperless is not configured.");
    try {
      for (const attachment of attachments.slice(results.paperlessDocumentIds.length)) {
        const bytes = await readFile(attachmentPath(env, id, attachment.id));
        const document = await uploadAndResolveDocument(paperless, {
          filename: attachment.filename,
          contentType: attachment.mimeType,
          data: bytes,
        });
        results.paperlessDocumentIds.push(document.id);
        const saved = db.update(schema.intakeJobs)
          .set({
            applyResultsJson: JSON.stringify(results),
            applyClaimExpiresAt: new Date(Date.now() + APPLY_CLAIM_MS).toISOString(),
            updatedAt: nowIso(),
          })
          .where(and(
            eq(schema.intakeJobs.id, id),
            eq(schema.intakeJobs.revision, claim.claimRevision),
            eq(schema.intakeJobs.status, "applying"),
            eq(schema.intakeJobs.applyClaimToken, claim.claimToken),
          ))
          .run();
        if (saved.changes !== 1) throw AppError.conflict("stale_write_conflict", "The intake apply claim was lost.");
      }
    } catch (error) {
      if (error instanceof AppError && error.code === "stale_write_conflict") throw error;
      if (logger) logger.error({ err: error }, "Intake Paperless retention failed.");
      else console.error("Intake Paperless retention failed.", error);
      throw new AppError(502, "intake_source_retention_failed", "The source could not be retained in Paperless.");
    }
  }

  db.transaction((tx) => {
    const jobNow = tx.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, id)).get();
    if (!jobNow) throw new AppError(410, "intake_expired", "The intake has expired.");
    if (jobNow.expiresAt <= nowIso()) throw new AppError(410, "intake_expired", "The intake has expired.");
    if (jobNow.createdByMemberId !== viewerMemberId) throw AppError.notFound("intake_not_found", "The intake was not found.");
    if (jobNow.status !== "applying") throw AppError.conflict("intake_state_conflict", "The intake apply claim was lost.");
    if (jobNow.revision !== claim.claimRevision || jobNow.applyClaimToken !== claim.claimToken) throw AppError.conflict("stale_write_conflict", "The intake has changed since it was read.");
    if (jobNow.breakdownTaskId !== null) {
      results = applyBreakdown(
        tx as unknown as Db,
        jobNow,
        draft,
        context,
        viewerMemberId,
        input.projectDriverMemberId,
        input.activationResolution,
      );
      tx.update(schema.intakeJobs).set({
        status: "applied", applyResultsJson: JSON.stringify(results),
        applyClaimToken: null, applyClaimExpiresAt: null, errorJson: null,
        revision: claim.claimRevision + 1, updatedAt: nowIso(),
      }).where(eq(schema.intakeJobs.id, id)).run();
      return;
    }
    const existingKeys = new Set(results.work.map((item) => item.key));
    const enabled = draft.workItems.filter((item) => item.enabled);
    const byKey = new Map(enabled.map((item) => [item.key, item]));
    const sorted: typeof enabled = [];
    const remaining = new Set(enabled.map((item) => item.key));
    while (remaining.size > 0) {
      let progressed = false;
      for (const item of enabled) {
        if (!remaining.has(item.key)) continue;
        if (item.parentKey === null || !byKey.has(item.parentKey) || !remaining.has(item.parentKey)) {
          sorted.push(item);
          remaining.delete(item.key);
          progressed = true;
        }
      }
      if (!progressed) throw AppError.badRequest("intake_draft_invalid", "The enabled work hierarchy is cyclic.");
    }
    const ids = new Map(results.work.map((item) => [item.key, item.workItemId]));
    const pendingProjectDeadlines: Array<{ projectId: number; dueDate: string }> = [];
    const paperlessDocs = results.paperlessDocumentIds.map((documentId) => ({ id: documentId, title: "", originalFileName: "", mimeType: null } as PaperlessDocumentSummary));
    let retentionTarget: number | null = null;
    for (const item of sorted) {
      if (existingKeys.has(item.key)) {
        retentionTarget ??= results.work.find((result) => result.key === item.key)?.workItemId ?? null;
        continue;
      }
      const parent = item.parentKey ? byKey.get(item.parentKey) : null;
      const parentId = item.parentKey ? ids.get(item.parentKey) ?? null : null;
      const planning = intakeCanonicalPlanning(item);
      const notes = [item.notes, planning.availabilityContext].filter(Boolean).join("\n\n");
      const isRoot = item.parentKey === null;
      let created: { id: number; title: string; kind?: string; role?: string };
      if (item.kind === "project") {
        const project = createProject(tx as unknown as Db, {
          title: item.title,
          notes,
          parentId: parent?.kind === "project" ? parentId : null,
          ...(item.ownerMemberId === null ? {} : { ownerMemberId: item.ownerMemberId }),
          // The complete accepted tree is built below. Apply the project's
          // own deadline after its child actions exist so readiness is
          // evaluated against the final atomic graph.
          dueDate: null,
          revisitAt: planning.revisitAt,
          scope: isRoot ? jobNow.scope as "household" | "work" : undefined,
        }, context);
        if (item.dueDate !== null) {
          pendingProjectDeadlines.push({ projectId: project.id, dueDate: item.dueDate });
        }
        created = { id: project.id, title: project.title, role: "story" };
      } else {
        const base = item.kind === "reference" ? {
          title: item.title,
          notes,
          kind: "reference" as const,
          createdByMemberId: jobNow.createdByMemberId,
          scope: isRoot ? jobNow.scope as "household" | "work" : undefined,
        } : {
          title: item.title,
          notes,
          kind: "action" as const,
          needsClarification: item.needsClarification,
          ...(item.ownerMemberId === null ? {} : { ownerMemberId: item.ownerMemberId }),
          ownerInheritanceMode: item.ownerMemberId === null ? undefined : "explicit" as const,
          dueDate: item.dueDate,
          scheduledDate: planning.scheduledDate,
          revisitAt: planning.revisitAt,
          reminders: item.reminders.length > 0 ? item.reminders : undefined,
          createdByMemberId: jobNow.createdByMemberId,
          scope: isRoot ? jobNow.scope as "household" | "work" : undefined,
        };
        const task = parent?.kind === "action" && parentId !== null
          ? createChildTask(tx as unknown as Db, parentId, base, context)
          : createTask(tx as unknown as Db, { ...base, projectId: parent?.kind === "project" ? parentId : null }, context);
        created = { id: task.id, title: task.title, kind: item.kind, role: "task" };
      }
      ids.set(item.key, created.id);
      results.work.push({ key: item.key, kind: item.kind, workItemId: created.id, role: created.role === "story" ? "story" : "task" });
      retentionTarget ??= isRoot ? created.id : null;
    }
    for (const { projectId, dueDate } of pendingProjectDeadlines) {
      updateProject(tx as unknown as Db, projectId, { dueDate }, context);
    }
    if (draft.retainSourceInPaperless && retentionTarget !== null && paperlessDocs.length > 0) {
      const row = tx.select({ role: schema.workItems.role, notes: schema.workItems.notes })
        .from(schema.workItems).where(eq(schema.workItems.id, retentionTarget)).get();
      if (row) {
        const retainedIds = new Set(
          Array.from(row.notes.matchAll(/paperless:(\d+)\)/g), ([, id]) => Number(id)),
        );
        const newDocs = paperlessDocs.filter((document) => !retainedIds.has(document.id));
        if (newDocs.length > 0) {
          const block = newDocs.map((document) => paperlessMarkdownReference(document)).join("\n\n");
          if (row.role === "story") appendProjectNotes(tx as unknown as Db, retentionTarget, block, context);
          else appendTaskNotes(tx as unknown as Db, retentionTarget, block, context);
        }
      }
    }
    for (const event of enabledEvents) {
      let result = results.calendar.find((candidate) => candidate.key === event.key);
      if (result?.status === "succeeded" || result?.status === "pending") continue;
      const correlationId = result?.correlationId ?? randomUUID();
      result = { key: event.key, correlationId, status: "pending", error: null, event: null };
      results.calendar = results.calendar.filter((candidate) => candidate.key !== event.key);
      results.calendar.push(result);
      enqueueHomeAssistantRequest(tx as unknown as Db, {
        integrationId: integration!.id,
        intakeJobId: id,
        kind: "calendar_create",
        payload: { intakeId: id, correlationId, title: event.title, description: event.description, location: event.location, allDay: event.allDay, startDate: event.startDate, endDate: event.endDate, startDateTime: event.startDateTime, endDateTime: event.endDateTime },
      }, signal);
    }
    const status = results.calendar.some((event) => event.status === "pending") ? "applying" : results.calendar.some((event) => event.status === "failed") ? "partially_applied" : "applied";
    const updated = tx.update(schema.intakeJobs)
      .set({
        status,
        applyResultsJson: JSON.stringify(results),
        applyClaimToken: null,
        applyClaimExpiresAt: null,
        errorJson: null,
        revision: claim.claimRevision + 1,
        updatedAt: nowIso(),
      })
      .where(and(
        eq(schema.intakeJobs.id, id),
        eq(schema.intakeJobs.revision, claim.claimRevision),
        eq(schema.intakeJobs.status, "applying"),
        eq(schema.intakeJobs.applyClaimToken, claim.claimToken),
      ))
      .run();
    if (updated.changes !== 1) throw AppError.conflict("stale_write_conflict", "The intake has changed since it was read.");
  });
  } catch (error) {
    fail(error);
    throw error;
  }
}
