import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema.js";
import { applyIntake } from "../src/intake/apply.js";
import { HomeAssistantRequestSignal } from "../src/integrations/homeAssistantRequests.js";
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
    ctx.handle.db.update(schema.homeAssistantRequests).set({ status: "leased", leaseToken: lease.leaseToken }).where(eq(schema.homeAssistantRequests.id, request.id)).run();
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
});
