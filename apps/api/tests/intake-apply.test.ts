import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema.js";
import { applyIntake } from "../src/intake/apply.js";
import { HomeAssistantRequestSignal } from "../src/integrations/homeAssistantRequests.js";
import { writeAttachment } from "../src/intake/storage.js";
import type { PaperlessClient } from "../src/paperless/client.js";
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

  async function prepare() {
    const member = ctx.handle.db.insert(schema.members).values({ name: "Alex", color: "#123456" }).returning().get();
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

  function draft(workItems: any[], calendarEvents: any[] = []) {
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

  it("seeds existing parent IDs when a later apply adds a child", async () => {
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
    await applyIntake(ctx.handle.db, env(ctx.dataDir), undefined, signal, setup.id, { expectedRevision: applied.revision + 1, draft: childDraft }, { actorMemberId: setup.member.id }, setup.member.id);
    const parent = ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.title, "Existing parent")).get()!;
    const child = ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.title, "New child")).get()!;
    expect(child.parentId).toBe(parent.id);
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

  it("stores calendar external refs and exposes them on task and project details", async () => {
    const setup = await prepare();
    const signal = new HomeAssistantRequestSignal();
    const d = draft([
      { key: "task", kind: "action", title: "Calendar task", notes: null, parentKey: null, dueDate: null, scheduledDate: null, notBeforeDate: null, notBeforeAt: null, reminderAt: null, needsClarification: false, relatedCalendarKeys: ["event"], enabled: true, ownerMemberId: null },
    ], [{
      key: "event", title: "Appointment", description: null, location: null, allDay: false,
      startDate: null, endDate: null, startDateTime: "2026-10-01T10:00:00+02:00", endDateTime: "2026-10-01T11:00:00+02:00",
      relatedWorkKeys: ["task"], enabled: true, durationAssumed: false,
    }]);
    ctx.handle.db.update(schema.intakeJobs).set({
      planJson: JSON.stringify({ summary: "Source", calendarEvents: d.calendarEvents, workItems: d.workItems, warnings: [] }),
    }).where(eq(schema.intakeJobs.id, setup.id)).run();
    await applyIntake(ctx.handle.db, env(ctx.dataDir), undefined, signal, setup.id, { expectedRevision: setup.revision, draft: d }, { actorMemberId: setup.member.id }, setup.member.id);
    const request = ctx.handle.db.select().from(schema.homeAssistantRequests).where(eq(schema.homeAssistantRequests.kind, "calendar_create")).get()!;
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
    const task = ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.title, "Calendar task")).get()!;
    const refs = ctx.handle.db.select().from(schema.externalWorkItemRefs).where(eq(schema.externalWorkItemRefs.workItemId, task.id)).all();
    expect(refs).toHaveLength(1);
    expect(refs[0]!.source).toBe("home_assistant_calendar");
    expect(refs[0]!.externalId).toBe("calendar.family:uid-1");
    expect(refs[0]!.metadataJson).toContain("rec-1");
    expect((await ctx.app.inject({ method: "GET", url: `/api/tasks/${task.id}` })).json().externalRefs).toHaveLength(1);
  });

  it("persists successful Paperless uploads and retries only the failed attachment", async () => {
    const setup = await prepare();
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
    let uploadCount = 0;
    const paperless: PaperlessClient = {
      upload: async () => ({ taskId: `task-${++uploadCount}` }),
      awaitDocumentId: async (taskId) => {
        if (taskId === "task-2" && uploadCount === 2) throw new Error("temporary failure");
        return taskId === "task-1" ? 101 : 202;
      },
      getDocument: async (id) => ({ id, title: `doc-${id}`, originalFileName: `doc-${id}.txt`, mimeType: "text/plain" }),
      search: async () => ({ results: [], count: 0, next: null, previous: null }),
      thumbnail: async () => ({ contentType: "text/plain", contentLength: 0, filename: null, body: Readable.from([]) }),
      preview: async () => ({ contentType: "text/plain", contentLength: 0, filename: null, body: Readable.from([]) }),
      download: async () => ({ contentType: "text/plain", contentLength: 0, filename: null, body: Readable.from([]) }),
    };
    const draftWithRetention = draft([
      { key: "retention", kind: "action", title: "Retained", notes: null, parentKey: null, dueDate: null, scheduledDate: null, notBeforeDate: null, notBeforeAt: null, reminderAt: null, needsClarification: false, relatedCalendarKeys: [], enabled: true, ownerMemberId: null },
    ]);
    draftWithRetention.retainSourceInPaperless = true;
    const signal = new HomeAssistantRequestSignal();
    await expect(applyIntake(ctx.handle.db, env(ctx.dataDir), paperless, signal, setup.id, {
      expectedRevision: setup.revision,
      draft: draftWithRetention,
    }, { actorMemberId: setup.member.id }, setup.member.id)).rejects.toThrow();
    expect(uploadCount).toBe(2);
    const partial = ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, setup.id)).get()!;
    expect(JSON.parse(partial.applyResultsJson!).paperlessDocumentIds).toEqual([101]);
    await applyIntake(ctx.handle.db, env(ctx.dataDir), paperless, signal, setup.id, {
      expectedRevision: setup.revision,
      draft: draftWithRetention,
    }, { actorMemberId: setup.member.id }, setup.member.id);
    expect(uploadCount).toBe(3);
    expect(ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.title, "Retained")).all()).toHaveLength(1);
  });
});
