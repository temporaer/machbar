import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import type { PaperlessDocumentSummary, IntakeDraft, IntakeApplyResults } from "@machbar/shared";
import { intakeDraftIssues, paperlessMarkdownReference } from "@machbar/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import type { Env } from "../env.js";
import { AppError } from "../errors.js";
import { activeHomeAssistantIntegration } from "../integrations/homeAssistant.js";
import { enqueueHomeAssistantRequest, type HomeAssistantRequestSignal } from "../integrations/homeAssistantRequests.js";
import { createProject } from "../domain/storyCrud.js";
import { createChildTask, createTask } from "../domain/taskCrud.js";
import type { MutationContext } from "../domain/workItemShared.js";
import type { PaperlessClient } from "../paperless/client.js";
import { uploadAndResolveDocument } from "../paperless/upload.js";
import { listExternalWorkItemRefs } from "../domain/externalWorkItemRefs.js";
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
  if (stored.status !== "ready" && stored.status !== "partially_applied") throw AppError.conflict("intake_state_conflict", "The intake is not ready to apply.");
  if (stored.revision !== input.expectedRevision) throw AppError.conflict("stale_write_conflict", "The intake has changed since it was read.");
  const memberIds = db.select({ id: schema.members.id }).from(schema.members).all().map((member) => member.id);
  const attachments = db.select().from(schema.intakeAttachments).all().filter((attachment) => attachment.intakeJobId === id);
  const issues = intakeDraftIssues(input.draft, {
    memberIds,
    paperlessAvailable: Boolean(paperless),
    hasFiles: attachments.length > 0,
  });
  if (issues.length > 0) throw AppError.badRequest("intake_draft_invalid", "The intake draft is invalid.", { issues });

  const enabledEvents = input.draft.calendarEvents.filter((event) => event.enabled);
  if (enabledEvents.length > 0) {
    const integration = activeHomeAssistantIntegration(db);
    if (!integration) throw AppError.conflict("home_assistant_not_connected", "Home Assistant is not connected.");
    if (integration.protocolVersion !== 2) throw AppError.conflict("home_assistant_protocol_outdated", "The Home Assistant integration must be updated.");
    const capabilities = integration.capabilitiesJson ? JSON.parse(integration.capabilitiesJson) as { calendar?: { state?: string } } : null;
    if (capabilities?.calendar?.state === "not_writable") throw AppError.conflict("calendar_not_writable", "The configured calendar is not writable.");
    if (capabilities?.calendar?.state !== "ok") throw AppError.conflict("calendar_not_configured", "No writable calendar is configured.");
  }

  let results = parse<IntakeApplyResults>(stored.applyResultsJson) ?? { work: [], calendar: [], paperlessDocumentIds: [] };
  if (input.draft.retainSourceInPaperless && results.paperlessDocumentIds.length === 0) {
    if (!paperless) throw AppError.conflict("intake_source_retention_failed", "Paperless is not configured.");
    try {
      results.paperlessDocumentIds = [];
      for (const attachment of attachments) {
        const bytes = await readFile(attachmentPath(env, id, attachment.id));
        const document = await uploadAndResolveDocument(paperless, {
          filename: attachment.filename,
          contentType: attachment.mimeType,
          data: bytes,
        });
        results.paperlessDocumentIds.push(document.id);
      }
      db.update(schema.intakeJobs).set({ applyResultsJson: JSON.stringify(results), updatedAt: nowIso() }).where(eq(schema.intakeJobs.id, id)).run();
    } catch (error) {
      throw new AppError(502, "intake_source_retention_failed", "The source could not be retained in Paperless.", { cause: error instanceof Error ? error.message : String(error) });
    }
  }

  db.transaction((tx) => {
    const jobNow = tx.select().from(schema.intakeJobs).all().find((candidate) => candidate.id === id)!;
    const existingKeys = new Set(results.work.map((item) => item.key));
    const enabled = input.draft.workItems.filter((item) => item.enabled);
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
    const ids = new Map<string, number>();
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
          ownerMemberId: item.ownerMemberId,
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
          ownerMemberId: item.ownerMemberId,
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
    if (input.draft.retainSourceInPaperless && retentionTarget !== null && paperlessDocs.length > 0) {
      const row = tx.select().from(schema.workItems).all().find((candidate) => candidate.id === retentionTarget);
      if (row && !row.notes.includes("paperless:")) {
        const block = paperlessDocs.map((document) => paperlessMarkdownReference(document)).join("\n\n");
        tx.update(schema.workItems).set({ notes: row.notes ? `${row.notes}\n\n${block}` : block }).where(eq(schema.workItems.id, retentionTarget)).run();
      }
    }
    const integration = enabledEvents.length > 0 ? activeHomeAssistantIntegration(tx as unknown as Db) : null;
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
    tx.update(schema.intakeJobs).set({ status, applyResultsJson: JSON.stringify(results), revision: jobNow.revision + 1, updatedAt: nowIso() }).where(eq(schema.intakeJobs.id, id)).run();
  });
}
