import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { IntakeDraft, IntakeDraftCalendarEvent, IntakeDraftWorkItem } from "@machbar/shared";
import * as schema from "../src/db/schema.js";
import { applyIntake } from "../src/intake/apply.js";
import { getIntake, updateIntakeDraft } from "../src/intake/jobs.js";
import { HomeAssistantRequestSignal } from "../src/integrations/homeAssistantRequests.js";
import { writeAttachment } from "../src/intake/storage.js";
import type { PaperlessClient } from "../src/paperless/client.js";
import { createProject } from "../src/domain/storyCrud.js";
import { createTask } from "../src/domain/taskCrud.js";
import {
  closeTestContext,
  createTestContext,
  type TestContext,
} from "./helpers.js";

const env = (dataDir: string) => ({ dataDir } as never);

describe("intake apply", () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = createTestContext(); });
  afterEach(async () => { await closeTestContext(ctx); });

  async function prepare(name = "Alex") {
    const member = ctx.handle.db.insert(schema.members).values({ name, color: "#123456" }).returning().get();
    const code = (await ctx.app.inject({
      method: "POST",
      url: "/api/integrations/home-assistant/pairing-code",
    })).json().code as string;
    const paired = await ctx.app.inject({
      method: "POST",
      url: "/api/integrations/home-assistant/pair",
      payload: { pairingCode: code, protocolVersion: 2 },
    });
    const token = paired.json().token as string;
    await ctx.app.inject({
      method: "POST",
      url: "/api/integrations/home-assistant/context",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        protocolVersion: 2,
        observedAt: new Date().toISOString(),
        contexts: [],
        people: [],
        intake: {
          aiTask: { entityId: "ai_task.test", state: "ok", supportsAttachments: true },
          calendar: { entityId: "calendar.test", state: "ok" },
        },
      },
    });
    const body = "------apply\r\nContent-Disposition: form-data; name=\"text\"\r\n\r\nsource\r\n------apply--\r\n";
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/intake",
      headers: { "content-type": "multipart/form-data; boundary=----apply" },
      payload: Buffer.from(body),
    });
    const id = created.json().id as string;
    const leased = await ctx.app.inject({
      method: "GET",
      url: "/api/integrations/home-assistant/requests/next?protocolVersion=2&waitSeconds=0",
      headers: { authorization: `Bearer ${token}` },
    });
    await ctx.app.inject({
      method: "POST",
      url: `/api/integrations/home-assistant/requests/${leased.json().id}/complete`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        leaseToken: leased.json().leaseToken,
        outcome: "succeeded",
        result: {
          summary: "Source",
          calendarEvents: [],
          workItems: [],
          warnings: [],
        },
      },
    });
    ctx.handle.db.update(schema.intakeJobs).set({
      createdByMemberId: member.id,
      actorMemberId: member.id,
    }).where(eq(schema.intakeJobs.id, id)).run();
    const job = ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, id)).get()!;
    return { id, member, token, revision: job.revision };
  }

  function draft(
    workItems: IntakeDraftWorkItem[],
    calendarEvents: IntakeDraftCalendarEvent[] = [],
  ): IntakeDraft {
    return {
      summary: "Source",
      calendarEvents,
      workItems,
      warnings: [],
      retainSourceInPaperless: false,
    };
  }

  it("creates nested projects, actions, and references with domain activity", async () => {
    const setup = await prepare();
    const signal = new HomeAssistantRequestSignal();
    const d = draft([
      { key: "project", kind: "project", title: "Renovate", notes: "Plan", parentKey: null, dueDate: "2026-10-10", scheduledDate: null, notBeforeDate: null, notBeforeAt: null, reminderAt: null, needsClarification: false, relatedCalendarKeys: [], enabled: true, ownerMemberId: setup.member.id },
      { key: "action", kind: "action", title: "Buy paint", notes: null, parentKey: "project", dueDate: "2026-10-01", scheduledDate: "2026-09-29", notBeforeDate: null, notBeforeAt: null, reminderAt: "2026-09-28T09:00:00.000Z", needsClarification: false, relatedCalendarKeys: [], enabled: true, ownerMemberId: setup.member.id },
      { key: "reference", kind: "reference", title: "Colour chart", notes: "Keep", parentKey: "action", dueDate: null, scheduledDate: null, notBeforeDate: null, notBeforeAt: null, reminderAt: null, needsClarification: false, relatedCalendarKeys: [], enabled: true, ownerMemberId: null },
      { key: "root", kind: "action", title: "Call contractor", notes: null, parentKey: null, dueDate: null, scheduledDate: null, notBeforeDate: null, notBeforeAt: null, reminderAt: null, needsClarification: true, relatedCalendarKeys: [], enabled: true, ownerMemberId: setup.member.id },
    ]);
    await applyIntake(ctx.handle.db, env(ctx.dataDir), undefined, signal, setup.id, {
      expectedRevision: setup.revision,
      draft: d,
    }, { actorMemberId: setup.member.id }, setup.member.id);
    const project = ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.title, "Renovate")).get()!;
    const action = ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.title, "Buy paint")).get()!;
    const reference = ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.title, "Colour chart")).get()!;
    expect(project.role).toBe("story");
    expect(action.parentId).toBe(project.id);
    expect(reference.parentId).toBe(action.id);
    expect(action.ownerMemberId).toBe(setup.member.id);
    expect(ctx.handle.db.select().from(schema.taskReminders).where(eq(schema.taskReminders.taskId, action.id)).get()?.at).toContain("2026-09-28");
    expect(ctx.handle.db.select().from(schema.activityEvents).all().some((row) => row.actorMemberId === setup.member.id)).toBe(true);
    expect((await ctx.app.inject({ method: "GET", url: `/api/projects/${project.id}` })).json().tasks).toEqual(expect.any(Array));
    expect((await ctx.app.inject({ method: "GET", url: `/api/tasks/${action.id}` })).json().kind).toBe("action");
  });

  it("does not duplicate work when a calendar apply is retried", async () => {
    const setup = await prepare();
    const signal = new HomeAssistantRequestSignal();
    const d = draft([
      { key: "task", kind: "action", title: "Unique task", notes: null, parentKey: null, dueDate: null, scheduledDate: null, notBeforeDate: null, notBeforeAt: null, reminderAt: null, needsClarification: false, relatedCalendarKeys: ["event"], enabled: true, ownerMemberId: null },
    ], [{
      key: "event", title: "Appointment", description: null, location: null, allDay: false,
      startDate: null, endDate: null, startDateTime: "2026-10-01T10:00:00+02:00", endDateTime: "2026-10-01T11:00:00+02:00",
      relatedWorkKeys: ["task"], enabled: true, durationAssumed: false,
    }]);
    ctx.handle.db.update(schema.intakeJobs).set({
      planJson: JSON.stringify({
        summary: "Source",
        calendarEvents: d.calendarEvents,
        workItems: d.workItems,
        warnings: [],
      }),
    }).where(eq(schema.intakeJobs.id, setup.id)).run();
    await applyIntake(ctx.handle.db, env(ctx.dataDir), undefined, signal, setup.id, { expectedRevision: setup.revision, draft: d }, { actorMemberId: setup.member.id }, setup.member.id);
    const first = ctx.handle.db.select().from(schema.homeAssistantRequests).where(eq(schema.homeAssistantRequests.kind, "calendar_create")).get()!;
    const firstJob = ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, setup.id)).get()!;
    const results = JSON.parse(firstJob.applyResultsJson!);
    results.calendar[0]!.status = "failed";
    results.calendar[0]!.error = { code: "calendar_uid_not_recovered", message: "retry", retryable: true };
    ctx.handle.db.update(schema.intakeJobs).set({ status: "partially_applied", applyResultsJson: JSON.stringify(results), revision: firstJob.revision + 1 }).where(eq(schema.intakeJobs.id, setup.id)).run();
    await applyIntake(ctx.handle.db, env(ctx.dataDir), undefined, signal, setup.id, { expectedRevision: firstJob.revision + 1, draft: d }, { actorMemberId: setup.member.id }, setup.member.id);
    const second = ctx.handle.db.select().from(schema.homeAssistantRequests).where(eq(schema.homeAssistantRequests.kind, "calendar_create")).orderBy(schema.homeAssistantRequests.createdAt).all();
    expect(second).toHaveLength(2);
    expect(JSON.parse(second[1]!.payloadJson).correlationId).toBe(JSON.parse(first.payloadJson).correlationId);
    expect(ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.title, "Unique task")).all()).toHaveLength(1);
  });

  it("rejects a second apply with the original revision and creates work once", async () => {
    const setup = await prepare();
    const signal = new HomeAssistantRequestSignal();
    const d = draft([
      { key: "task", kind: "action", title: "Only once", notes: null, parentKey: null, dueDate: null, scheduledDate: null, notBeforeDate: null, notBeforeAt: null, reminderAt: null, needsClarification: false, relatedCalendarKeys: [], enabled: true, ownerMemberId: null },
    ]);
    const input = { expectedRevision: setup.revision, draft: d };
    await applyIntake(ctx.handle.db, env(ctx.dataDir), undefined, signal, setup.id, input, { actorMemberId: setup.member.id }, setup.member.id);
    await expect(applyIntake(ctx.handle.db, env(ctx.dataDir), undefined, signal, setup.id, input, { actorMemberId: setup.member.id }, setup.member.id))
      .rejects.toThrowError(/not ready|changed since it was read/);
    expect(ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.title, "Only once")).all()).toHaveLength(1);
  });

  it("keeps the originally accepted work when a partial apply is retried with a changed draft", async () => {
    const setup = await prepare();
    const signal = new HomeAssistantRequestSignal();
    const parentDraft = draft([
      { key: "parent", kind: "action", title: "Existing parent", notes: null, parentKey: null, dueDate: null, scheduledDate: null, notBeforeDate: null, notBeforeAt: null, reminderAt: null, needsClarification: false, relatedCalendarKeys: [], enabled: true, ownerMemberId: null },
    ]);
    await applyIntake(ctx.handle.db, env(ctx.dataDir), undefined, signal, setup.id, { expectedRevision: setup.revision, draft: parentDraft }, { actorMemberId: setup.member.id }, setup.member.id);
    const applied = ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, setup.id)).get()!;
    ctx.handle.db.update(schema.intakeJobs).set({ status: "partially_applied", revision: applied.revision + 1 }).where(eq(schema.intakeJobs.id, setup.id)).run();
    const childDraft = draft([
      ...parentDraft.workItems,
      { key: "child", kind: "action", title: "New child", notes: null, parentKey: "parent", dueDate: null, scheduledDate: null, notBeforeDate: null, notBeforeAt: null, reminderAt: null, needsClarification: false, relatedCalendarKeys: [], enabled: true, ownerMemberId: null },
    ]);
    const partial = ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, setup.id)).get()!;
    expect(() => updateIntakeDraft(ctx.handle.db, setup.id, setup.member.id, {
      expectedRevision: partial.revision,
      draft: childDraft,
    })).toThrowError(/only be edited before Apply starts/);
    await applyIntake(ctx.handle.db, env(ctx.dataDir), undefined, signal, setup.id, {
      expectedRevision: partial.revision,
      draft: childDraft,
    }, { actorMemberId: setup.member.id }, setup.member.id);
    const parent = ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.title, "Existing parent")).get()!;
    const child = ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.title, "New child")).get();
    expect(child).toBeUndefined();
    expect(parent).toBeDefined();
  });

  it("assigns a work-scope root action to the actor when no owner is selected", async () => {
    const setup = await prepare();
    ctx.handle.db.update(schema.intakeJobs).set({ scope: "work" }).where(eq(schema.intakeJobs.id, setup.id)).run();
    const signal = new HomeAssistantRequestSignal();
    await applyIntake(ctx.handle.db, env(ctx.dataDir), undefined, signal, setup.id, {
      expectedRevision: setup.revision,
      draft: draft([{ key: "task", kind: "action", title: "Owned by actor", notes: null, parentKey: null, dueDate: null, scheduledDate: null, notBeforeDate: null, notBeforeAt: null, reminderAt: null, needsClarification: false, relatedCalendarKeys: [], enabled: true, ownerMemberId: null }]),
    }, { actorMemberId: setup.member.id }, setup.member.id);
    const task = ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.title, "Owned by actor")).get()!;
    expect(task.ownerMemberId).toBe(setup.member.id);
  });

  it("reports an expired cleanup race as intake_expired", async () => {
    const setup = await prepare();
    ctx.handle.db.update(schema.intakeJobs).set({ expiresAt: new Date(0).toISOString() }).where(eq(schema.intakeJobs.id, setup.id)).run();
    await expect(applyIntake(ctx.handle.db, env(ctx.dataDir), undefined, new HomeAssistantRequestSignal(), setup.id, {
      expectedRevision: setup.revision,
      draft: draft([]),
    }, { actorMemberId: setup.member.id }, setup.member.id)).rejects.toThrowError(/expired/);
  });

  it("recovers an abandoned local apply lease without changing the accepted draft", async () => {
    const setup = await prepare();
    const accepted = draft([
      { key: "task-a", kind: "action", title: "Accepted task A", notes: null, parentKey: null, dueDate: null, scheduledDate: null, notBeforeDate: null, notBeforeAt: null, reminderAt: null, needsClarification: false, relatedCalendarKeys: [], enabled: true, ownerMemberId: null },
    ]);
    ctx.handle.db.update(schema.intakeJobs).set({
      status: "applying",
      acceptedDraftJson: JSON.stringify(accepted),
      applyClaimToken: "dead-claim",
      applyClaimExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      revision: setup.revision + 1,
    }).where(eq(schema.intakeJobs.id, setup.id)).run();

    const recovered = getIntake(ctx.handle.db, setup.id, setup.member.id);
    expect(recovered.status).toBe("partially_applied");
    expect(recovered.error).toMatchObject({
      code: "intake_apply_partial",
      message: "The previous Apply was interrupted and can be retried.",
    });
    const saved = ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, setup.id)).get()!;
    expect(saved.applyClaimToken).toBeNull();
    expect(saved.applyClaimExpiresAt).toBeNull();
    expect(saved.acceptedDraftJson).toBe(JSON.stringify(accepted));

    await applyIntake(ctx.handle.db, env(ctx.dataDir), undefined, new HomeAssistantRequestSignal(), setup.id, {
      expectedRevision: recovered.revision,
    }, { actorMemberId: setup.member.id }, setup.member.id);
    expect(ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.title, "Accepted task A")).all()).toHaveLength(1);
    const completed = ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, setup.id)).get()!;
    expect(completed.status).toBe("applied");
    expect(completed.acceptedDraftJson).toBe(JSON.stringify(accepted));
  });

  it("directly retries an expired apply claim using its frozen draft and previous revision", async () => {
    const setup = await prepare();
    const accepted = draft([
      { key: "accepted", kind: "action", title: "Recovered accepted task", notes: null, parentKey: null, dueDate: null, scheduledDate: null, notBeforeDate: null, notBeforeAt: null, reminderAt: null, needsClarification: false, relatedCalendarKeys: [], enabled: true, ownerMemberId: null },
    ]);
    ctx.handle.db.update(schema.intakeJobs).set({
      status: "applying",
      acceptedDraftJson: JSON.stringify(accepted),
      applyClaimToken: "expired-direct-claim",
      applyClaimExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      revision: setup.revision + 1,
    }).where(eq(schema.intakeJobs.id, setup.id)).run();
    const before = ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, setup.id)).get()!;
    const changedDraft = draft([
      { key: "changed", kind: "action", title: "Should not be created", notes: null, parentKey: null, dueDate: null, scheduledDate: null, notBeforeDate: null, notBeforeAt: null, reminderAt: null, needsClarification: false, relatedCalendarKeys: [], enabled: true, ownerMemberId: null },
    ]);
    await applyIntake(ctx.handle.db, env(ctx.dataDir), undefined, new HomeAssistantRequestSignal(), setup.id, {
      expectedRevision: before.revision,
      draft: changedDraft,
    }, { actorMemberId: setup.member.id }, setup.member.id);
    expect(ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.title, "Recovered accepted task")).all()).toHaveLength(1);
    expect(ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.title, "Should not be created")).all()).toHaveLength(0);
    const completed = ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, setup.id)).get()!;
    expect(completed.status).toBe("applied");
    expect(completed.acceptedDraftJson).toBe(JSON.stringify(accepted));
  });

  it("rejects a stale direct retry before recovering an expired claim", async () => {
    const setup = await prepare();
    const accepted = draft([
      { key: "accepted", kind: "action", title: "Not created by stale retry", notes: null, parentKey: null, dueDate: null, scheduledDate: null, notBeforeDate: null, notBeforeAt: null, reminderAt: null, needsClarification: false, relatedCalendarKeys: [], enabled: true, ownerMemberId: null },
    ]);
    const expiredAt = new Date(Date.now() - 60_000).toISOString();
    ctx.handle.db.update(schema.intakeJobs).set({
      status: "applying",
      acceptedDraftJson: JSON.stringify(accepted),
      applyClaimToken: "expired-stale-claim",
      applyClaimExpiresAt: expiredAt,
      revision: setup.revision + 1,
    }).where(eq(schema.intakeJobs.id, setup.id)).run();

    await expect(applyIntake(ctx.handle.db, env(ctx.dataDir), undefined, new HomeAssistantRequestSignal(), setup.id, {
      expectedRevision: setup.revision,
    }, { actorMemberId: setup.member.id }, setup.member.id)).rejects.toMatchObject({ code: "stale_write_conflict" });
    const unchanged = ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, setup.id)).get()!;
    expect(unchanged).toMatchObject({
      status: "applying",
      revision: setup.revision + 1,
      applyClaimToken: "expired-stale-claim",
      applyClaimExpiresAt: expiredAt,
      acceptedDraftJson: JSON.stringify(accepted),
    });
    expect(unchanged.applyResultsJson).toBeNull();
    expect(ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.title, "Not created by stale retry")).all()).toHaveLength(0);
  });

  it("does not disclose a Paperless failure cause in the Apply API response", async () => {
    await closeTestContext(ctx);
    const secret = "private-paperless-failure-detail-91";
    const paperlessClient: PaperlessClient = {
      upload: async () => { throw new Error(secret); },
      awaitDocumentId: async () => { throw new Error("unexpected document resolution"); },
      getDocument: async () => { throw new Error("unexpected document lookup"); },
      search: async () => ({ results: [], count: 0, next: null, previous: null }),
      thumbnail: async () => ({ contentType: "text/plain", contentLength: 0, filename: null, body: Readable.from([]) }),
      preview: async () => ({ contentType: "text/plain", contentLength: 0, filename: null, body: Readable.from([]) }),
      download: async () => ({ contentType: "text/plain", contentLength: 0, filename: null, body: Readable.from([]) }),
    };
    ctx = createTestContext({ paperlessClient });
    const setup = await prepare();
    const attachmentId = randomUUID();
    const bytes = Buffer.from("Paperless source");
    await writeAttachment(env(ctx.dataDir), setup.id, attachmentId, bytes);
    ctx.handle.db.insert(schema.intakeAttachments).values({
      id: attachmentId,
      intakeJobId: setup.id,
      filename: "source.txt",
      mimeType: "text/plain",
      sizeBytes: bytes.length,
      sha256: "hash",
      createdAt: new Date().toISOString(),
    }).run();
    ctx.handle.db.update(schema.intakeJobs).set({ createdByMemberId: null })
      .where(eq(schema.intakeJobs.id, setup.id)).run();
    const accepted = draft([
      { key: "task", kind: "action", title: "Retain source", notes: null, parentKey: null, dueDate: null, scheduledDate: null, notBeforeDate: null, notBeforeAt: null, reminderAt: null, needsClarification: false, relatedCalendarKeys: [], enabled: true, ownerMemberId: null },
    ]);
    accepted.retainSourceInPaperless = true;

    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/intake/${setup.id}/apply`,
      payload: { expectedRevision: setup.revision, draft: accepted },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().error).toEqual({
      code: "intake_source_retention_failed",
      message: "The source could not be retained in Paperless.",
    });
    expect(response.body).not.toContain(secret);
    const detail = await ctx.app.inject({ method: "GET", url: `/api/intake/${setup.id}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().status).toBe("partially_applied");
    expect(detail.body).not.toContain(secret);
  });

  it("persists only a generic error for unexpected post-claim failures", async () => {
    const setup = await prepare();
    const unsafeMessage = "sensitive internal detail must not be persisted";
    const calendarDraft = draft([], [{
      key: "event",
      title: "Local apply failure",
      description: null,
      location: null,
      allDay: false,
      startDate: null,
      endDate: null,
      startDateTime: "2026-10-03T10:00:00+02:00",
      endDateTime: "2026-10-03T11:00:00+02:00",
      relatedWorkKeys: [],
      enabled: true,
      durationAssumed: false,
    }]);
    const signal = new HomeAssistantRequestSignal();
    signal.notify = () => { throw new Error(unsafeMessage); };
    const logger = { error: vi.fn() } as unknown as Pick<FastifyBaseLogger, "error">;
    await expect(applyIntake(ctx.handle.db, env(ctx.dataDir), undefined, signal, setup.id, {
      expectedRevision: setup.revision,
      draft: calendarDraft,
    }, { actorMemberId: setup.member.id }, setup.member.id, logger)).rejects.toThrow(unsafeMessage);
    const record = getIntake(ctx.handle.db, setup.id, setup.member.id);
    expect(record.status).toBe("partially_applied");
    expect(record.error).toEqual({
      code: "intake_apply_partial",
      message: "The intake could not be fully applied.",
      retryable: true,
    });
    expect(JSON.stringify(record.error)).not.toContain(unsafeMessage);
    expect(logger.error).toHaveBeenCalledWith({ err: expect.any(Error) }, "Intake Apply failed.");
  });

  it("does not recover calendar-wait or active local apply states", async () => {
    const waiting = await prepare();
    const waitResults = { work: [], calendar: [{ key: "event", correlationId: "event-correlation", status: "pending", error: null, event: null }], paperlessDocumentIds: [] };
    ctx.handle.db.update(schema.intakeJobs).set({
      status: "applying",
      acceptedDraftJson: JSON.stringify(draft([])),
      applyResultsJson: JSON.stringify(waitResults),
      applyClaimToken: null,
      applyClaimExpiresAt: null,
    }).where(eq(schema.intakeJobs.id, waiting.id)).run();
    expect(getIntake(ctx.handle.db, waiting.id, waiting.member.id).status).toBe("applying");

    const active = await prepare("Jordan");
    ctx.handle.db.update(schema.intakeJobs).set({
      status: "applying",
      acceptedDraftJson: JSON.stringify(draft([])),
      applyClaimToken: "active-claim",
      applyClaimExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    }).where(eq(schema.intakeJobs.id, active.id)).run();
    expect(getIntake(ctx.handle.db, active.id, active.member.id).status).toBe("applying");
    const activeRow = ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, active.id)).get()!;
    expect(activeRow.applyClaimToken).toBe("active-claim");
  });

  it("uses the accepted draft for calendar refs and exposes project refs on project details", async () => {
    const setup = await prepare();
    const signal = new HomeAssistantRequestSignal();
    const d = draft([
      { key: "project", kind: "project", title: "Calendar project", notes: null, parentKey: null, dueDate: "2026-10-10", scheduledDate: null, notBeforeDate: null, notBeforeAt: null, reminderAt: null, needsClarification: false, relatedCalendarKeys: ["event"], enabled: true, ownerMemberId: setup.member.id },
      { key: "disabled-task", kind: "action", title: "Disabled task", notes: null, parentKey: null, dueDate: null, scheduledDate: null, notBeforeDate: null, notBeforeAt: null, reminderAt: null, needsClarification: false, relatedCalendarKeys: ["event", "disabled-event"], enabled: false, ownerMemberId: null },
    ], [{
      key: "event", title: "Appointment", description: "Accepted event detail", location: "Library", allDay: false,
      startDate: null, endDate: null, startDateTime: "2026-10-01T10:00:00+02:00", endDateTime: "2026-10-01T11:00:00+02:00",
      relatedWorkKeys: ["project", "disabled-task"], enabled: true, durationAssumed: false,
    }, {
      key: "disabled-event", title: "Disabled event", description: null, location: null, allDay: false,
      startDate: null, endDate: null, startDateTime: "2026-10-02T10:00:00+02:00", endDateTime: "2026-10-02T11:00:00+02:00",
      relatedWorkKeys: ["disabled-task"], enabled: false, durationAssumed: false,
    }]);
    ctx.handle.db.update(schema.intakeJobs).set({
      planJson: JSON.stringify({
        summary: "Source",
        calendarEvents: [{ ...d.calendarEvents[0], relatedWorkKeys: ["disabled-task"] }],
        workItems: [{ ...d.workItems[1], relatedCalendarKeys: ["event"] }],
        warnings: [],
      }),
    }).where(eq(schema.intakeJobs.id, setup.id)).run();
    await applyIntake(ctx.handle.db, env(ctx.dataDir), undefined, signal, setup.id, { expectedRevision: setup.revision, draft: d }, { actorMemberId: setup.member.id }, setup.member.id);
    const accepted = ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, setup.id)).get()!;
    expect(JSON.parse(accepted.acceptedDraftJson!)).toEqual(d);
    expect(accepted.status).toBe("applying");
    expect(accepted.applyClaimToken).toBeNull();
    expect(accepted.applyClaimExpiresAt).toBeNull();
    const requests = ctx.handle.db.select().from(schema.homeAssistantRequests).where(eq(schema.homeAssistantRequests.kind, "calendar_create")).all();
    expect(requests).toHaveLength(1);
    const initialRequest = requests[0]!;
    ctx.handle.db.update(schema.homeAssistantRequests).set({
      status: "leased",
      leaseToken: "failed-attempt",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    }).where(eq(schema.homeAssistantRequests.id, initialRequest.id)).run();
    await ctx.app.inject({
      method: "POST",
      url: `/api/integrations/home-assistant/requests/${initialRequest.id}/complete`,
      headers: { authorization: `Bearer ${setup.token}` },
      payload: {
        leaseToken: "failed-attempt",
        outcome: "failed",
        error: { code: "calendar_create_failed", message: "Retry this accepted event." },
      },
    });
    const failedJob = ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, setup.id)).get()!;
    expect(() => updateIntakeDraft(ctx.handle.db, setup.id, setup.member.id, {
      expectedRevision: failedJob.revision,
      draft: d,
    })).toThrowError(/only be edited before Apply starts/);
    const changedDraft = draft([
      { ...d.workItems[0]!, title: "Changed project", dueDate: "2026-12-31", ownerMemberId: null },
      ...d.workItems.slice(1),
    ], [
      { ...d.calendarEvents[0]!, title: "Changed appointment", description: "Unaccepted", relatedWorkKeys: ["disabled-task"] },
      { ...d.calendarEvents[1]!, enabled: true },
    ]);
    await applyIntake(ctx.handle.db, env(ctx.dataDir), undefined, signal, setup.id, {
      expectedRevision: failedJob.revision,
      draft: changedDraft,
    }, { actorMemberId: setup.member.id }, setup.member.id);
    const retriedRequests = ctx.handle.db.select().from(schema.homeAssistantRequests)
      .where(eq(schema.homeAssistantRequests.kind, "calendar_create")).all();
    expect(retriedRequests).toHaveLength(2);
    const request = retriedRequests[1]!;
    expect(JSON.parse(request.payloadJson)).toMatchObject({
      title: "Appointment",
      description: "Accepted event detail",
      location: "Library",
    });
    const lease = { ...request, leaseToken: "test" };
    ctx.handle.db.update(schema.homeAssistantRequests).set({
      status: "leased",
      leaseToken: lease.leaseToken,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    }).where(eq(schema.homeAssistantRequests.id, request.id)).run();
    const completion = await ctx.app.inject({
      method: "POST",
      url: `/api/integrations/home-assistant/requests/${request.id}/complete`,
      headers: { authorization: `Bearer ${setup.token}` },
      payload: {
        leaseToken: lease.leaseToken,
        outcome: "succeeded",
        result: { calendarEntityId: "calendar.family", uid: "uid-1", recurrenceId: "rec-1", summary: "Appointment", start: "2026-10-01T10:00:00+02:00", end: "2026-10-01T11:00:00+02:00", correlationId: JSON.parse(request.payloadJson).correlationId },
      },
    });
    expect(completion.statusCode, completion.body).toBe(204);
    const completedJob = ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, setup.id)).get()!;
    expect(JSON.parse(completedJob.acceptedDraftJson!)).toEqual(d);
    const project = ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.title, "Calendar project")).get()!;
    const disabledTask = ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.title, "Disabled task")).get();
    const refs = ctx.handle.db.select().from(schema.externalWorkItemRefs).where(eq(schema.externalWorkItemRefs.workItemId, project.id)).all();
    expect(refs).toHaveLength(1);
    expect(refs[0]!.source).toBe("home_assistant_calendar");
    expect(refs[0]!.externalId).toBe("calendar.family:uid-1");
    expect(refs[0]!.metadataJson).toContain("rec-1");
    expect(disabledTask).toBeUndefined();
    expect(project.ownerMemberId).toBe(setup.member.id);
    expect(project.dueDate).toBe("2026-10-10");
    const projectDetail = await ctx.app.inject({ method: "GET", url: `/api/projects/${project.id}` });
    expect(projectDetail.json().externalRefs).toHaveLength(1);
  });

  it("persists successful Paperless uploads and retries only the failed attachment", async () => {
    const setup = await prepare();
    const existingTask = createTask(ctx.handle.db, {
      title: "Retained",
      notes: "Keep this note\n\n[older document](paperless:10)",
    });
    ctx.handle.db.update(schema.intakeJobs).set({
      applyResultsJson: JSON.stringify({
        work: [{ key: "retention", kind: "action", workItemId: existingTask.id, role: "task" }],
        calendar: [],
        paperlessDocumentIds: [],
      }),
    }).where(eq(schema.intakeJobs.id, setup.id)).run();
    const attachments = [
      { id: randomUUID(), filename: "one.txt", mimeType: "text/plain", data: Buffer.from("one") },
      { id: randomUUID(), filename: "two.txt", mimeType: "text/plain", data: Buffer.from("two") },
    ];
    for (const attachment of attachments) {
      await writeAttachment(env(ctx.dataDir), setup.id, attachment.id, attachment.data);
      ctx.handle.db.insert(schema.intakeAttachments).values({
        id: attachment.id,
        intakeJobId: setup.id,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.data.length,
        sha256: "hash",
        createdAt: new Date().toISOString(),
      }).run();
    }
    const draftWithRetention = draft([
      { key: "retention", kind: "action", title: "Retained", notes: null, parentKey: null, dueDate: null, scheduledDate: null, notBeforeDate: null, notBeforeAt: null, reminderAt: null, needsClarification: false, relatedCalendarKeys: [], enabled: true, ownerMemberId: null },
    ]);
    draftWithRetention.retainSourceInPaperless = true;
    let uploadCount = 0;
    let acceptedDraftAtUpload: unknown;
    let patchBlockedAfterClaim = false;
    let firstClaimToken: string | null = null;
    let firstClaimExpiry: string | null = null;
    let firstClaimRevision: number | null = null;
    let heartbeatVerified = false;
    const paperless: PaperlessClient = {
      upload: async () => {
        const job = ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, setup.id)).get()!;
        acceptedDraftAtUpload = JSON.parse(job.acceptedDraftJson!);
        if (uploadCount === 0) {
          firstClaimToken = job.applyClaimToken;
          firstClaimExpiry = job.applyClaimExpiresAt;
          firstClaimRevision = job.revision;
        } else {
          heartbeatVerified = job.applyClaimToken === firstClaimToken
            && job.applyClaimExpiresAt !== null
            && job.applyClaimExpiresAt > firstClaimExpiry!
            && job.revision === firstClaimRevision;
        }
        try {
          updateIntakeDraft(ctx.handle.db, setup.id, setup.member.id, {
            expectedRevision: job.revision,
            draft: draft([{ key: "changed", kind: "action", title: "Changed", notes: null, parentKey: null, dueDate: null, scheduledDate: null, notBeforeDate: null, notBeforeAt: null, reminderAt: null, needsClarification: false, relatedCalendarKeys: [], enabled: true, ownerMemberId: null }]),
          }, { paperlessAvailable: true, hasFiles: true });
        } catch {
          patchBlockedAfterClaim = true;
        }
        return { taskId: `task-${++uploadCount}` };
      },
      awaitDocumentId: async (taskId) => {
        if (taskId === "task-1") return new Promise<number>((resolve) => setTimeout(() => resolve(101), 10));
        if (taskId === "task-2" && uploadCount === 2) throw new Error("temporary failure");
        return taskId === "task-1" ? 101 : 202;
      },
      getDocument: async (id) => ({ id, title: `doc-${id}`, originalFileName: `doc-${id}.txt`, mimeType: "text/plain" }),
      search: async () => ({ results: [], count: 0, next: null, previous: null }),
      thumbnail: async () => ({ contentType: "text/plain", contentLength: 0, filename: null, body: Readable.from([]) }),
      preview: async () => ({ contentType: "text/plain", contentLength: 0, filename: null, body: Readable.from([]) }),
      download: async () => ({ contentType: "text/plain", contentLength: 0, filename: null, body: Readable.from([]) }),
    };
    const signal = new HomeAssistantRequestSignal();
    await expect(applyIntake(ctx.handle.db, env(ctx.dataDir), paperless, signal, setup.id, {
      expectedRevision: setup.revision,
      draft: draftWithRetention,
    }, { actorMemberId: setup.member.id }, setup.member.id)).rejects.toThrow();
    expect(uploadCount).toBe(2);
    expect(acceptedDraftAtUpload).toEqual(draftWithRetention);
    expect(patchBlockedAfterClaim).toBe(true);
    expect(heartbeatVerified).toBe(true);
    const partial = ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, setup.id)).get()!;
    expect(partial.status).toBe("partially_applied");
    expect(partial.status === "ready" && partial.acceptedDraftJson !== null).toBe(false);
    expect(partial.applyClaimToken).toBeNull();
    expect(partial.applyClaimExpiresAt).toBeNull();
    expect(JSON.parse(partial.applyResultsJson!).paperlessDocumentIds).toEqual([101]);
    expect(JSON.parse(partial.acceptedDraftJson!)).toEqual(draftWithRetention);
    expect(partial.acceptedDraftJson).not.toBeNull();
    expect(() => updateIntakeDraft(ctx.handle.db, setup.id, setup.member.id, {
      expectedRevision: partial.revision,
      draft: draftWithRetention,
    })).toThrowError(/only be edited before Apply starts/);
    const changedRetryDraft = draft([
      { key: "changed", kind: "action", title: "Changed during retry", notes: null, parentKey: null, dueDate: "2026-12-31", scheduledDate: null, notBeforeDate: null, notBeforeAt: null, reminderAt: null, needsClarification: false, relatedCalendarKeys: [], enabled: true, ownerMemberId: setup.member.id },
    ]);
    await applyIntake(ctx.handle.db, env(ctx.dataDir), paperless, signal, setup.id, {
      expectedRevision: partial.revision,
      draft: changedRetryDraft,
    }, { actorMemberId: setup.member.id }, setup.member.id);
    expect(uploadCount).toBe(3);
    expect(ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.title, "Retained")).all()).toHaveLength(1);
    expect(ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.title, "Changed during retry")).get()).toBeUndefined();
    const retained = ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.id, existingTask.id)).get()!;
    expect(retained.notes).toContain("Keep this note");
    expect(retained.notes).toContain("paperless:10");
    expect(retained.notes).toContain("paperless:101");
    expect(retained.notes.match(/paperless:101/g)).toHaveLength(1);
    expect(retained.notes.match(/paperless:202/g)).toHaveLength(1);
    const completed = ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, setup.id)).get()!;
    expect(JSON.parse(completed.acceptedDraftJson!)).toEqual(draftWithRetention);
  });

  it("retains Paperless references on a project target", async () => {
    const setup = await prepare();
    const project = createProject(ctx.handle.db, { title: "Paperless project", notes: "Existing project note" });
    const attachmentId = randomUUID();
    await writeAttachment(env(ctx.dataDir), setup.id, attachmentId, Buffer.from("source"));
    ctx.handle.db.insert(schema.intakeAttachments).values({
      id: attachmentId,
      intakeJobId: setup.id,
      filename: "source.txt",
      mimeType: "text/plain",
      sizeBytes: 6,
      sha256: "hash",
      createdAt: new Date().toISOString(),
    }).run();
    let uploads = 0;
    const paperless: PaperlessClient = {
      upload: async () => ({ taskId: `upload-${++uploads}` }),
      awaitDocumentId: async () => 303,
      getDocument: async (id) => ({ id, title: "source", originalFileName: "source.txt", mimeType: "text/plain" }),
      search: async () => ({ results: [], count: 0, next: null, previous: null }),
      thumbnail: async () => ({ contentType: "text/plain", contentLength: 0, filename: null, body: Readable.from([]) }),
      preview: async () => ({ contentType: "text/plain", contentLength: 0, filename: null, body: Readable.from([]) }),
      download: async () => ({ contentType: "text/plain", contentLength: 0, filename: null, body: Readable.from([]) }),
    };
    const acceptedDraft = draft([
      { key: "project", kind: "project", title: "Paperless project", notes: null, parentKey: null, dueDate: null, scheduledDate: null, notBeforeDate: null, notBeforeAt: null, reminderAt: null, needsClarification: false, relatedCalendarKeys: [], enabled: true, ownerMemberId: null },
    ]);
    acceptedDraft.retainSourceInPaperless = true;
    ctx.handle.db.update(schema.intakeJobs).set({
      applyResultsJson: JSON.stringify({
        work: [{ key: "project", kind: "project", workItemId: project.id, role: "story" }],
        calendar: [],
        paperlessDocumentIds: [],
      }),
    }).where(eq(schema.intakeJobs.id, setup.id)).run();
    await applyIntake(ctx.handle.db, env(ctx.dataDir), paperless, new HomeAssistantRequestSignal(), setup.id, {
      expectedRevision: setup.revision,
      draft: acceptedDraft,
    }, { actorMemberId: setup.member.id }, setup.member.id);
    const retained = ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.id, project.id)).get()!;
    expect(uploads).toBe(1);
    expect(retained.notes).toContain("Existing project note");
    expect(retained.notes).toContain("paperless:303");
  });
});
