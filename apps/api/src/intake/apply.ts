import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import type { PaperlessDocumentSummary, IntakeDraft, IntakeApplyResults } from "@machbar/shared";
import { intakeDraftIssues, paperlessMarkdownReference } from "@machbar/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import type { Env } from "../env.js";
import { AppError } from "../errors.js";
import { activeHomeAssistantIntegration } from "../integrations/homeAssistant.js";
import { enqueueHomeAssistantRequest, type HomeAssistantRequestSignal } from "../integrations/homeAssistantRequests.js";
import { appendProjectNotes, createProject } from "../domain/storyCrud.js";
import { appendTaskNotes, createChildTask, createTask } from "../domain/taskCrud.js";
import type { MutationContext } from "../domain/workItemShared.js";
import type { PaperlessClient } from "../paperless/client.js";
import { uploadAndResolveDocument } from "../paperless/upload.js";
import { nowIso } from "../domain/workItemShared.js";
import { attachmentPath } from "./storage.js";

type StoredJob = typeof schema.intakeJobs.$inferSelect;

function parse<T>(value: string | null): T | null {
  return value === null ? null : JSON.parse(value) as T;
}

export async function applyIntake(
  db: Db,
  env: Env,
  paperless: PaperlessClient | undefined,
  signal: HomeAssistantRequestSignal,
  id: string,
  input: { expectedRevision: number; draft: IntakeDraft },
  context: MutationContext,
  viewerMemberId: number | null,
): Promise<void> {
  const stored = db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, id)).get();
  if (!stored) throw AppError.notFound("intake_not_found", "The intake was not found.");
  if (stored.createdByMemberId !== viewerMemberId) throw AppError.notFound("intake_not_found", "The intake was not found.");
  if (stored.expiresAt <= nowIso()) throw new AppError(410, "intake_expired", "The intake has expired.");
  if (stored.status !== "ready" && stored.status !== "partially_applied") throw AppError.conflict("intake_state_conflict", "The intake is not ready to apply.");
  if (stored.revision !== input.expectedRevision) throw AppError.conflict("stale_write_conflict", "The intake has changed since it was read.");
  const draft = parse<IntakeDraft>(stored.acceptedDraftJson) ?? input.draft;
  const memberIds = db.select({ id: schema.members.id }).from(schema.members).all().map((member) => member.id);
  const attachments = db.select().from(schema.intakeAttachments)
    .where(eq(schema.intakeAttachments.intakeJobId, id)).all();
  const issues = intakeDraftIssues(draft, {
    memberIds,
    paperlessAvailable: Boolean(paperless),
    hasFiles: attachments.length > 0,
  });
  if (issues.length > 0) throw AppError.badRequest("intake_draft_invalid", "The intake draft is invalid.", { issues });

  const enabledEvents = draft.calendarEvents.filter((event) => event.enabled);
  const integration = enabledEvents.length > 0 ? activeHomeAssistantIntegration(db) : null;
  if (enabledEvents.length > 0) {
    if (!integration) throw AppError.conflict("home_assistant_not_connected", "Home Assistant is not connected.");
    if (integration.protocolVersion !== 2) throw AppError.conflict("home_assistant_protocol_outdated", "The Home Assistant integration must be updated.");
    const capabilities = integration.capabilitiesJson ? JSON.parse(integration.capabilitiesJson) as { calendar?: { state?: string } } : null;
    if (capabilities?.calendar?.state === "not_writable") throw AppError.conflict("calendar_not_writable", "The configured calendar is not writable.");
    if (capabilities?.calendar?.state !== "ok") throw AppError.conflict("calendar_not_configured", "No writable calendar is configured.");
  }

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
        db.update(schema.intakeJobs)
          .set({ applyResultsJson: JSON.stringify(results), updatedAt: nowIso() })
          .where(and(eq(schema.intakeJobs.id, id), eq(schema.intakeJobs.revision, stored.revision)))
          .run();
      }
    } catch (error) {
      throw new AppError(502, "intake_source_retention_failed", "The source could not be retained in Paperless.", { cause: error instanceof Error ? error.message : String(error) });
    }
  }

  db.transaction((tx) => {
    const jobNow = tx.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, id)).get();
    if (!jobNow) throw new AppError(410, "intake_expired", "The intake has expired.");
    if (jobNow.expiresAt <= nowIso()) throw new AppError(410, "intake_expired", "The intake has expired.");
    if (jobNow.createdByMemberId !== viewerMemberId) throw AppError.notFound("intake_not_found", "The intake was not found.");
    if (jobNow.status !== "ready" && jobNow.status !== "partially_applied") throw AppError.conflict("intake_state_conflict", "The intake is not ready to apply.");
    if (jobNow.revision !== input.expectedRevision) throw AppError.conflict("stale_write_conflict", "The intake has changed since it was read.");
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
    const paperlessDocs = results.paperlessDocumentIds.map((documentId) => ({ id: documentId, title: "", originalFileName: "", mimeType: null } as PaperlessDocumentSummary));
    let retentionTarget: number | null = null;
    for (const item of sorted) {
      if (existingKeys.has(item.key)) {
        retentionTarget ??= results.work.find((result) => result.key === item.key)?.workItemId ?? null;
        continue;
      }
      const parent = item.parentKey ? byKey.get(item.parentKey) : null;
      const parentId = item.parentKey ? ids.get(item.parentKey) ?? null : null;
      const notes = item.notes ?? "";
      const isRoot = item.parentKey === null;
      let created: { id: number; title: string; kind?: string; role?: string };
      if (item.kind === "project") {
        const project = createProject(tx as unknown as Db, {
          title: item.title,
          notes,
          parentId: parent?.kind === "project" ? parentId : null,
          ...(item.ownerMemberId === null ? {} : { ownerMemberId: item.ownerMemberId }),
          dueDate: item.dueDate,
          scope: isRoot ? jobNow.scope as "household" | "work" : undefined,
        }, context);
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
          scheduledDate: item.scheduledDate,
          notBeforeDate: item.notBeforeDate,
          notBeforeAt: item.notBeforeAt,
          reminders: item.reminderAt === null ? undefined : [{ kind: "absolute" as const, at: item.reminderAt }],
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
        acceptedDraftJson: jobNow.acceptedDraftJson ?? JSON.stringify(draft),
        revision: input.expectedRevision + 1,
        updatedAt: nowIso(),
      })
      .where(and(eq(schema.intakeJobs.id, id), eq(schema.intakeJobs.revision, input.expectedRevision)))
      .run();
    if (updated.changes !== 1) throw AppError.conflict("stale_write_conflict", "The intake has changed since it was read.");
  });
}
