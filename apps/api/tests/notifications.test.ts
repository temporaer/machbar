import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { ACTIVITY_ACTOR_HEADER } from "@machbar/shared";
import * as schema from "../src/db/schema.js";
import { createProject, updateProject } from "../src/domain/storyCrud.js";
import { activateProject } from "../src/domain/storyWorkflow.js";
import { createTask, updateTask } from "../src/domain/taskCrud.js";
import {
  buildNotificationPayload,
  dispatchNotificationEvents,
  type PushTransport,
} from "../src/notifications/delivery.js";
import {
  enqueueDueReminders,
  enqueueNotification,
} from "../src/notifications/outbox.js";
import { createSession } from "../src/auth/repository.js";
import { SESSION_COOKIE } from "../src/auth/routes.js";
import {
  closeTestContext,
  createTestContext,
  type TestContext,
} from "./helpers.js";

function addMember(ctx: TestContext, name: string) {
  return ctx.handle.db
    .insert(schema.members)
    .values({ name, color: "#123456" })
    .returning()
    .get();
}

describe("Push subscription API", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await closeTestContext(ctx);
  });

  const payload = {
    endpoint: "https://push.example/subscription",
    p256dh: "p256dh",
    auth: "auth",
    locale: "de",
    timezone: "Europe/Berlin",
  } as const;

  it("registers, reassociates, and removes a device endpoint", async () => {
    const hannes = addMember(ctx, "Hannes");
    const sarah = addMember(ctx, "Sarah");

    const registered = await ctx.app.inject({
      method: "PUT",
      url: "/api/push/subscription",
      headers: { [ACTIVITY_ACTOR_HEADER]: String(hannes.id) },
      payload,
    });
    expect(registered.statusCode).toBe(204);

    const reassociated = await ctx.app.inject({
      method: "PUT",
      url: "/api/push/subscription",
      headers: { [ACTIVITY_ACTOR_HEADER]: String(sarah.id) },
      payload: { ...payload, locale: "en", timezone: null },
    });
    expect(reassociated.statusCode).toBe(204);
    expect(ctx.handle.db.select().from(schema.pushSubscriptions).all()).toEqual([
      expect.objectContaining({
        endpoint: payload.endpoint,
        memberId: sarah.id,
        locale: "en",
        timezone: null,
      }),
    ]);

    const removed = await ctx.app.inject({
      method: "DELETE",
      url: "/api/push/subscription",
      headers: { [ACTIVITY_ACTOR_HEADER]: String(sarah.id) },
      payload: { endpoint: payload.endpoint },
    });
    expect(removed.statusCode).toBe(204);
    expect(ctx.handle.db.select().from(schema.pushSubscriptions).all()).toEqual([]);
  });

  it("keeps separate browser and phone subscriptions for the same member", async () => {
    const hannes = addMember(ctx, "Hannes");
    const phone = { ...payload, endpoint: "https://push.example/phone" };
    const desktop = { ...payload, endpoint: "https://push.example/desktop" };

    for (const device of [phone, desktop]) {
      const response = await ctx.app.inject({
        method: "PUT",
        url: "/api/push/subscription",
        headers: { [ACTIVITY_ACTOR_HEADER]: String(hannes.id) },
        payload: device,
      });
      expect(response.statusCode).toBe(204);
    }

    expect(
      ctx.handle.db
        .select()
        .from(schema.pushSubscriptions)
        .where(eq(schema.pushSubscriptions.memberId, hannes.id))
        .all()
        .map((item) => item.endpoint)
        .sort(),
    ).toEqual([desktop.endpoint, phone.endpoint].sort());
  });

  it("stores notification preferences per member with enabled defaults", async () => {
    const hannes = addMember(ctx, "Hannes");
    const sarah = addMember(ctx, "Sarah");

    const defaults = await ctx.app.inject({
      method: "GET",
      url: "/api/push/preferences",
      headers: { [ACTIVITY_ACTOR_HEADER]: String(hannes.id) },
    });
    expect(defaults.json()).toEqual({
      project_assigned: true,
      task_reminder: true,
      context_entered: true,
    });

    const preferences = {
      project_assigned: false,
      task_reminder: true,
      context_entered: false,
    };
    const updated = await ctx.app.inject({
      method: "PUT",
      url: "/api/push/preferences",
      headers: { [ACTIVITY_ACTOR_HEADER]: String(hannes.id) },
      payload: preferences,
    });
    expect(updated.json()).toEqual(preferences);

    const reread = await ctx.app.inject({
      method: "GET",
      url: "/api/push/preferences",
      headers: { [ACTIVITY_ACTOR_HEADER]: String(hannes.id) },
    });
    expect(reread.json()).toEqual(preferences);

    const otherMember = await ctx.app.inject({
      method: "GET",
      url: "/api/push/preferences",
      headers: { [ACTIVITY_ACTOR_HEADER]: String(sarah.id) },
    });
    expect(otherMember.json()).toEqual({
      project_assigned: true,
      task_reminder: true,
      context_entered: true,
    });
  });

  it("sends a localized test notification only to the requesting browser", async () => {
    await closeTestContext(ctx);
    const send = vi.fn<PushTransport["send"]>().mockResolvedValue(undefined);
    ctx = createTestContext({
      push: {
        publicKey: "public",
        privateKey: "private",
        subject: "https://machbar.example",
      },
      pushTransport: { send },
    });
    const hannes = addMember(ctx, "Hannes");
    ctx.handle.db
      .insert(schema.pushSubscriptions)
      .values([
        {
          ...payload,
          endpoint: "https://push.example/phone",
          memberId: hannes.id,
        },
        {
          ...payload,
          endpoint: "https://push.example/desktop",
          memberId: hannes.id,
        },
      ])
      .run();

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/push/test",
      headers: { [ACTIVITY_ACTOR_HEADER]: String(hannes.id) },
      payload: { endpoint: "https://push.example/desktop" },
    });

    expect(response.statusCode).toBe(204);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "https://push.example/desktop" }),
      expect.any(String),
    );
    expect(JSON.parse(send.mock.calls[0]![1])).toEqual(
      expect.objectContaining({
        kind: "test",
        title: "Machbar",
        body: "Benachrichtigungen funktionieren auf diesem Gerät.",
        entity: null,
        recipientMemberId: hannes.id,
        actions: [],
      }),
    );
  });

  it("removes an expired subscription when a test delivery rejects it", async () => {
    await closeTestContext(ctx);
    const send = vi
      .fn<PushTransport["send"]>()
      .mockRejectedValue({ statusCode: 410 });
    ctx = createTestContext({
      push: {
        publicKey: "public",
        privateKey: "private",
        subject: "https://machbar.example",
      },
      pushTransport: { send },
    });
    const hannes = addMember(ctx, "Hannes");
    ctx.handle.db
      .insert(schema.pushSubscriptions)
      .values({
        ...payload,
        memberId: hannes.id,
      })
      .run();

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/push/test",
      headers: { [ACTIVITY_ACTOR_HEADER]: String(hannes.id) },
      payload: { endpoint: payload.endpoint },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("push_subscription_missing");
    expect(ctx.handle.db.select().from(schema.pushSubscriptions).all()).toEqual([]);
  });

  it("requires a resolvable current member", async () => {
    const response = await ctx.app.inject({
      method: "PUT",
      url: "/api/push/subscription",
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("push_member_required");
  });

  it("prefers an authenticated member over the selected-member header", async () => {
    await closeTestContext(ctx);
    const transport: PushTransport = { send: vi.fn().mockResolvedValue(undefined) };
    ctx = createTestContext({
      oidc: {
        issuerUrl: "https://pocket.example",
        clientId: "client",
        clientSecret: "secret",
        publicUrl: "https://machbar.example",
        sessionTtlDays: 30,
      },
      push: {
        publicKey: "public",
        privateKey: "private",
        subject: "https://machbar.example",
      },
      pushTransport: transport,
    });
    const authenticated = addMember(ctx, "Authenticated");
    const selected = addMember(ctx, "Selected");
    const session = createSession(ctx.handle.db, authenticated.id, 30);
    const config = await ctx.app.inject({
      method: "GET",
      url: "/api/push/config",
      headers: { cookie: `${SESSION_COOKIE}=${session.token}` },
    });
    expect(config.json()).toEqual({ enabled: true, publicKey: "public" });
    expect(config.body).not.toContain("private");

    const response = await ctx.app.inject({
      method: "PUT",
      url: "/api/push/subscription",
      headers: {
        cookie: `${SESSION_COOKIE}=${session.token}`,
        origin: "https://machbar.example",
        [ACTIVITY_ACTOR_HEADER]: String(selected.id),
      },
      payload,
    });
    expect(response.statusCode).toBe(204);
    expect(
      ctx.handle.db.select().from(schema.pushSubscriptions).get()?.memberId,
    ).toBe(authenticated.id);
  });
});

describe("notification event creation", () => {
  let ctx: TestContext;
  beforeEach(() => {
    ctx = createTestContext();
  });
  afterEach(async () => {
    await closeTestContext(ctx);
  });

  it("does not notify when another member assigns a task", () => {
    const hannes = addMember(ctx, "Hannes");
    const sarah = addMember(ctx, "Sarah");
    const task = createTask(
      ctx.handle.db,
      { title: "Paket abholen" },
      { actorMemberId: sarah.id },
    );
    updateTask(
      ctx.handle.db,
      task.id,
      { ownerMemberId: hannes.id, ownerInheritanceMode: "explicit" },
      { actorMemberId: sarah.id },
    );
    createTask(
      ctx.handle.db,
      {
        title: "Paket abholen",
        ownerMemberId: hannes.id,
        ownerInheritanceMode: "explicit",
      },
      { actorMemberId: sarah.id },
    );
    expect(ctx.handle.db.select().from(schema.notificationEvents).all()).toEqual([]);
  });

  it("emits one project assignment without inherited child fan-out", () => {
    const hannes = addMember(ctx, "Hannes");
    const sarah = addMember(ctx, "Sarah");
    const project = createProject(ctx.handle.db, { title: "Kinderzimmer" });
    createTask(ctx.handle.db, { title: "Streichen", projectId: project.id });
    createTask(ctx.handle.db, { title: "Möbel", projectId: project.id });
    ctx.handle.db.delete(schema.notificationEvents).run();

    updateProject(
      ctx.handle.db,
      project.id,
      { ownerMemberId: hannes.id },
      { actorMemberId: sarah.id },
    );
    expect(ctx.handle.db.select().from(schema.notificationEvents).all()).toEqual([
      expect.objectContaining({
        kind: "project_assigned",
        recipientMemberId: hannes.id,
        entityTitle: "Kinderzimmer",
      }),
    ]);
  });

  it("notifies the new project driver on reassignment", () => {
    const hannes = addMember(ctx, "Hannes");
    const sarah = addMember(ctx, "Sarah");
    const project = createProject(ctx.handle.db, {
      title: "Kinderzimmer",
      ownerMemberId: sarah.id,
    });
    ctx.handle.db.delete(schema.notificationEvents).run();
    updateProject(
      ctx.handle.db,
      project.id,
      { ownerMemberId: hannes.id },
      { actorMemberId: sarah.id },
    );
    expect(ctx.handle.db.select().from(schema.notificationEvents).all()).toEqual([
      expect.objectContaining({
        kind: "project_assigned",
        recipientMemberId: hannes.id,
        actorMemberId: sarah.id,
      }),
    ]);
  });

  it("records assignment when project activation supplies the driver", () => {
    const hannes = addMember(ctx, "Hannes");
    const sarah = addMember(ctx, "Sarah");
    const project = createProject(ctx.handle.db, { title: "Kinderzimmer" });
    createTask(ctx.handle.db, {
      title: "Next action",
      projectId: project.id,
      status: "actionable",
    });
    activateProject(
      ctx.handle.db,
      project.id,
      { ownerMemberId: hannes.id },
      { actorMemberId: sarah.id },
    );
    expect(ctx.handle.db.select().from(schema.notificationEvents).all()).toEqual([
      expect.objectContaining({ kind: "project_assigned" }),
    ]);
  });
});

describe("reminders and Push delivery", () => {
  let ctx: TestContext;
  beforeEach(() => {
    ctx = createTestContext();
  });
  afterEach(async () => {
    await closeTestContext(ctx);
  });

  it("fires multiple absolute reminders for one task independently and dedupes repeated passes", () => {
    const hannes = addMember(ctx, "Hannes");
    const task = createTask(ctx.handle.db, {
      title: "Paket abholen",
      status: "actionable",
      ownerMemberId: hannes.id,
      ownerInheritanceMode: "explicit",
      reminders: [
        { kind: "absolute", at: "2026-08-30T08:00:00.000Z" },
        { kind: "absolute", at: "2026-09-01T08:00:00.000Z" },
      ],
    });
    expect(task.reminders).toHaveLength(2);
    ctx.handle.db.delete(schema.notificationEvents).run();

    expect(enqueueDueReminders(ctx.handle.db, new Date("2026-08-30T09:00:00Z"))).toBe(1);
    expect(enqueueDueReminders(ctx.handle.db, new Date("2026-08-30T09:00:00Z"))).toBe(0);
    expect(enqueueDueReminders(ctx.handle.db, new Date("2026-09-01T09:00:00Z"))).toBe(1);
    expect(enqueueDueReminders(ctx.handle.db, new Date("2026-09-01T09:00:00Z"))).toBe(0);
  });

  it("does not fire an absolute reminder when the task is done or cancelled", () => {
    const hannes = addMember(ctx, "Hannes");
    const task = createTask(ctx.handle.db, {
      title: "Später",
      status: "actionable",
      ownerMemberId: hannes.id,
      ownerInheritanceMode: "explicit",
      reminders: [{ kind: "absolute", at: "2026-09-01T08:00:00.000Z" }],
    });
    ctx.handle.db.delete(schema.notificationEvents).run();
    updateTask(ctx.handle.db, task.id, { status: "done", completedOn: "2026-08-30" });
    expect(enqueueDueReminders(ctx.handle.db, new Date("2026-09-02T09:00:00Z"))).toBe(0);
  });

  it("fires multiple deadline-relative reminders for one deadline independently, at their own local targets", () => {
    const hannes = addMember(ctx, "Hannes");
    const task = createTask(ctx.handle.db, {
      title: "Steuererklärung",
      status: "actionable",
      ownerMemberId: hannes.id,
      ownerInheritanceMode: "explicit",
      dueDate: "2026-09-20",
      reminders: [
        { kind: "deadline_relative", daysBefore: 2, time: "09:00", timezone: "Europe/Berlin" },
        { kind: "deadline_relative", daysBefore: 0, time: "08:00", timezone: "Europe/Berlin" },
      ],
    });
    expect(task.reminders).toHaveLength(2);
    ctx.handle.db.delete(schema.notificationEvents).run();

    // 2026-09-18T09:00 Europe/Berlin (CEST, UTC+2) = 07:00Z.
    expect(enqueueDueReminders(ctx.handle.db, new Date("2026-09-18T06:59:00Z"))).toBe(0);
    expect(enqueueDueReminders(ctx.handle.db, new Date("2026-09-18T07:00:00Z"))).toBe(1);
    expect(enqueueDueReminders(ctx.handle.db, new Date("2026-09-18T07:00:00Z"))).toBe(0);

    // 2026-09-20T08:00 Europe/Berlin (CEST) = 06:00Z.
    expect(enqueueDueReminders(ctx.handle.db, new Date("2026-09-20T05:59:00Z"))).toBe(0);
    expect(enqueueDueReminders(ctx.handle.db, new Date("2026-09-20T06:00:00Z"))).toBe(1);
  });

  it("supports daysBefore: 0 (reminds on the deadline day itself)", () => {
    const hannes = addMember(ctx, "Hannes");
    createTask(ctx.handle.db, {
      title: "Geburtstag",
      status: "actionable",
      ownerMemberId: hannes.id,
      ownerInheritanceMode: "explicit",
      dueDate: "2026-09-20",
      reminders: [{ kind: "deadline_relative", daysBefore: 0, time: "08:00", timezone: "UTC" }],
    });
    ctx.handle.db.delete(schema.notificationEvents).run();
    expect(enqueueDueReminders(ctx.handle.db, new Date("2026-09-20T07:59:00Z"))).toBe(0);
    expect(enqueueDueReminders(ctx.handle.db, new Date("2026-09-20T08:00:00Z"))).toBe(1);
  });

  it("keeps a deadline-relative reminder dormant while the task has no deadline, and reactivates/repositions it once a deadline is (re)set", () => {
    const hannes = addMember(ctx, "Hannes");
    const task = createTask(ctx.handle.db, {
      title: "Anmeldung",
      status: "actionable",
      ownerMemberId: hannes.id,
      ownerInheritanceMode: "explicit",
      dueDate: "2026-09-20",
      reminders: [{ kind: "deadline_relative", daysBefore: 1, time: "09:00", timezone: "UTC" }],
    });
    ctx.handle.db.delete(schema.notificationEvents).run();

    updateTask(ctx.handle.db, task.id, { dueDate: null });
    expect(enqueueDueReminders(ctx.handle.db, new Date("2026-09-19T09:00:00Z"))).toBe(0);

    updateTask(ctx.handle.db, task.id, { dueDate: "2026-09-25" });
    expect(enqueueDueReminders(ctx.handle.db, new Date("2026-09-19T09:00:00Z"))).toBe(0);
    expect(enqueueDueReminders(ctx.handle.db, new Date("2026-09-24T09:00:00Z"))).toBe(1);
  });

  it("produces a new occurrence when the deadline moves after a previous relative reminder already fired", () => {
    const hannes = addMember(ctx, "Hannes");
    const task = createTask(ctx.handle.db, {
      title: "Abgabe",
      status: "actionable",
      ownerMemberId: hannes.id,
      ownerInheritanceMode: "explicit",
      dueDate: "2026-09-20",
      reminders: [{ kind: "deadline_relative", daysBefore: 0, time: "09:00", timezone: "UTC" }],
    });
    ctx.handle.db.delete(schema.notificationEvents).run();

    expect(enqueueDueReminders(ctx.handle.db, new Date("2026-09-20T09:00:00Z"))).toBe(1);
    expect(enqueueDueReminders(ctx.handle.db, new Date("2026-09-20T09:00:00Z"))).toBe(0);

    updateTask(ctx.handle.db, task.id, { dueDate: "2026-09-27" });
    expect(enqueueDueReminders(ctx.handle.db, new Date("2026-09-20T09:00:00Z"))).toBe(0);
    expect(enqueueDueReminders(ctx.handle.db, new Date("2026-09-27T09:00:00Z"))).toBe(1);
  });

  it("does not move an absolute reminder when the deadline changes", () => {
    const hannes = addMember(ctx, "Hannes");
    const task = createTask(ctx.handle.db, {
      title: "Rechnung",
      status: "actionable",
      ownerMemberId: hannes.id,
      ownerInheritanceMode: "explicit",
      dueDate: "2026-09-20",
      reminders: [{ kind: "absolute", at: "2026-09-15T08:00:00.000Z" }],
    });
    const updated = updateTask(ctx.handle.db, task.id, { dueDate: "2026-10-01" });
    expect(updated.reminders).toEqual([
      expect.objectContaining({ kind: "absolute", at: "2026-09-15T08:00:00.000Z" }),
    ]);
    ctx.handle.db.delete(schema.notificationEvents).run();
    expect(enqueueDueReminders(ctx.handle.db, new Date("2026-09-15T09:00:00Z"))).toBe(1);
  });

  it("handles a DST spring-forward nonexistent local wall time by firing once local time has advanced past it", () => {
    const hannes = addMember(ctx, "Hannes");
    // Europe/Berlin jumps 02:00 CET -> 03:00 CEST at 2026-03-29T01:00Z; 02:30 never
    // occurs on the local wall clock that day.
    createTask(ctx.handle.db, {
      title: "Uhrenumstellung",
      status: "actionable",
      ownerMemberId: hannes.id,
      ownerInheritanceMode: "explicit",
      dueDate: "2026-03-30",
      reminders: [{ kind: "deadline_relative", daysBefore: 1, time: "02:30", timezone: "Europe/Berlin" }],
    });
    ctx.handle.db.delete(schema.notificationEvents).run();

    expect(enqueueDueReminders(ctx.handle.db, new Date("2026-03-29T00:30:00Z"))).toBe(0);
    expect(enqueueDueReminders(ctx.handle.db, new Date("2026-03-29T01:05:00Z"))).toBe(1);
  });

  it("handles a DST fall-back duplicated local wall time without duplicating the reminder", () => {
    const hannes = addMember(ctx, "Hannes");
    // Europe/Berlin falls back 03:00 CEST -> 02:00 CET at 2026-10-25T01:00Z; 02:30
    // occurs twice on the local wall clock that day.
    createTask(ctx.handle.db, {
      title: "Uhrenumstellung",
      status: "actionable",
      ownerMemberId: hannes.id,
      ownerInheritanceMode: "explicit",
      dueDate: "2026-10-26",
      reminders: [{ kind: "deadline_relative", daysBefore: 1, time: "02:30", timezone: "Europe/Berlin" }],
    });
    ctx.handle.db.delete(schema.notificationEvents).run();

    expect(enqueueDueReminders(ctx.handle.db, new Date("2026-10-25T00:30:00Z"))).toBe(1);
    expect(enqueueDueReminders(ctx.handle.db, new Date("2026-10-25T01:30:00Z"))).toBe(0);
  });

  it("keeps reminder ids stable when editing one reminder alongside unrelated ones", () => {
    const hannes = addMember(ctx, "Hannes");
    const task = createTask(ctx.handle.db, {
      title: "Mehrere Erinnerungen",
      status: "actionable",
      ownerMemberId: hannes.id,
      ownerInheritanceMode: "explicit",
      reminders: [
        { kind: "absolute", at: "2026-09-01T08:00:00.000Z" },
        { kind: "absolute", at: "2026-09-02T08:00:00.000Z" },
      ],
    });
    const [first, second] = task.reminders;
    const firstAt = first && first.kind === "absolute" ? first.at : "";
    const updated = updateTask(ctx.handle.db, task.id, {
      reminders: [
        { id: first!.id, kind: "absolute", at: firstAt },
        { id: second!.id, kind: "absolute", at: "2026-09-02T09:30:00.000Z" },
      ],
    });
    expect(updated.reminders.map((r) => r.id).sort()).toEqual([first!.id, second!.id].sort());
    expect(
      ctx.handle.db.select().from(schema.taskReminders).where(eq(schema.taskReminders.taskId, task.id)).all(),
    ).toHaveLength(2);
  });

  it("deleting a reminder removes its still-pending notification", () => {
    const hannes = addMember(ctx, "Hannes");
    const task = createTask(ctx.handle.db, {
      title: "Löschen",
      status: "actionable",
      ownerMemberId: hannes.id,
      ownerInheritanceMode: "explicit",
      reminders: [{ kind: "absolute", at: "2026-09-01T08:00:00.000Z" }],
    });
    ctx.handle.db.delete(schema.notificationEvents).run();
    expect(enqueueDueReminders(ctx.handle.db, new Date("2026-09-01T09:00:00Z"))).toBe(1);
    expect(
      ctx.handle.db
        .select()
        .from(schema.notificationEvents)
        .where(and(eq(schema.notificationEvents.kind, "task_reminder"), isNull(schema.notificationEvents.processedAt)))
        .all(),
    ).toHaveLength(1);

    updateTask(ctx.handle.db, task.id, { reminders: [] });
    expect(
      ctx.handle.db
        .select()
        .from(schema.notificationEvents)
        .where(and(eq(schema.notificationEvents.kind, "task_reminder"), isNull(schema.notificationEvents.processedAt)))
        .all(),
    ).toEqual([]);
  });

  it("prevents stale delivery of an already-enqueued reminder once the task is completed or cancelled", async () => {
    const hannes = addMember(ctx, "Hannes");
    const task = createTask(ctx.handle.db, {
      title: "Fertig davor",
      status: "actionable",
      ownerMemberId: hannes.id,
      ownerInheritanceMode: "explicit",
      reminders: [{ kind: "absolute", at: "2026-09-01T08:00:00.000Z" }],
    });
    ctx.handle.db.insert(schema.pushSubscriptions).values({
      endpoint: "https://push.example/device",
      memberId: hannes.id,
      p256dh: "key",
      auth: "auth",
      locale: "de",
    }).run();
    ctx.handle.db.delete(schema.notificationEvents).run();
    expect(enqueueDueReminders(ctx.handle.db, new Date("2026-09-01T09:00:00Z"))).toBe(1);

    updateTask(ctx.handle.db, task.id, { status: "done", completedOn: "2026-09-01" });
    const send = vi.fn<PushTransport["send"]>().mockResolvedValue(undefined);
    await dispatchNotificationEvents(ctx.handle.db, { send }, { error: vi.fn() });

    expect(send).not.toHaveBeenCalled();
    expect(
      ctx.handle.db
        .select()
        .from(schema.notificationEvents)
        .where(isNull(schema.notificationEvents.processedAt))
        .all(),
    ).toEqual([]);
  });

  it("notifies every member (Gemeinsam) when an ownerless task's reminder is due", () => {
    const hannes = addMember(ctx, "Hannes");
    const sarah = addMember(ctx, "Sarah");
    createTask(ctx.handle.db, {
      title: "Gemeinsame Aufgabe",
      status: "actionable",
      reminders: [{ kind: "absolute", at: "2026-09-01T08:00:00.000Z" }],
    });
    ctx.handle.db.delete(schema.notificationEvents).run();

    expect(enqueueDueReminders(ctx.handle.db, new Date("2026-09-01T09:00:00Z"))).toBe(2);
    const recipients = ctx.handle.db
      .select({ recipientMemberId: schema.notificationEvents.recipientMemberId })
      .from(schema.notificationEvents)
      .all()
      .map((row) => row.recipientMemberId)
      .sort();
    expect(recipients).toEqual([hannes.id, sarah.id].sort());
  });

  it("clears a pending reminder event and re-resolves the recipient when effective ownership changes", () => {
    const hannes = addMember(ctx, "Hannes");
    const sarah = addMember(ctx, "Sarah");
    const task = createTask(ctx.handle.db, {
      title: "Zuständigkeit ändert sich",
      status: "actionable",
      ownerMemberId: hannes.id,
      ownerInheritanceMode: "explicit",
      reminders: [{ kind: "absolute", at: "2026-09-01T08:00:00.000Z" }],
    });
    ctx.handle.db.delete(schema.notificationEvents).run();
    const now = new Date("2026-09-01T09:00:00Z");
    expect(enqueueDueReminders(ctx.handle.db, now)).toBe(1);
    expect(
      ctx.handle.db.select().from(schema.notificationEvents).all()[0]!.recipientMemberId,
    ).toBe(hannes.id);

    updateTask(ctx.handle.db, task.id, { ownerMemberId: sarah.id });
    expect(
      ctx.handle.db
        .select()
        .from(schema.notificationEvents)
        .where(isNull(schema.notificationEvents.processedAt))
        .all(),
    ).toEqual([]);

    expect(enqueueDueReminders(ctx.handle.db, now)).toBe(1);
    expect(
      ctx.handle.db.select().from(schema.notificationEvents).all()[0]!.recipientMemberId,
    ).toBe(sarah.id);
  });

  it("localizes context-entry notifications", () => {
    const hannes = addMember(ctx, "Hannes");
    const task = createTask(ctx.handle.db, { title: "Paket abholen" });
    enqueueNotification(ctx.handle.db, {
      kind: "context_entered",
      recipientMemberId: hannes.id,
      actorMemberId: null,
      entityType: "task",
      entityId: task.id,
      entityTitle: `Post: ${task.title}`,
      sourceKey: "context-entry",
    });
    const event = ctx.handle.db.select().from(schema.notificationEvents).get()!;
    expect(buildNotificationPayload(ctx.handle.db, event, "de")).toEqual(
      expect.objectContaining({
        kind: "context_entered",
        title: "Hier machbar",
        body: "Post: Paket abholen",
        actions: [{ action: "open", title: "Öffnen" }],
      }),
    );
  });

  it("sends real notifications with the explicit 7-day TTL", async () => {
    const hannes = addMember(ctx, "Hannes");
    const task = createTask(ctx.handle.db, { title: "Paket abholen" });
    ctx.handle.db.insert(schema.pushSubscriptions).values({
      endpoint: "https://push.example/device",
      memberId: hannes.id,
      p256dh: "key",
      auth: "auth",
      locale: "de",
    }).run();
    enqueueNotification(ctx.handle.db, {
      kind: "context_entered",
      recipientMemberId: hannes.id,
      actorMemberId: null,
      entityType: "task",
      entityId: task.id,
      entityTitle: task.title,
      sourceKey: "ttl-check",
    });
    const send = vi.fn<PushTransport["send"]>().mockResolvedValue(undefined);
    await dispatchNotificationEvents(ctx.handle.db, { send }, { error: vi.fn() });
    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      { ttl: 7 * 24 * 60 * 60 },
    );
  });

  it("retries a transiently-failed subscription on a later pass without resending to one that already succeeded, while a 404/410 subscription is removed permanently", async () => {
    const hannes = addMember(ctx, "Hannes");
    const sarah = addMember(ctx, "Sarah");
    const task = createTask(ctx.handle.db, { title: "Paket abholen" });
    ctx.handle.db.insert(schema.pushSubscriptions).values([
      {
        endpoint: "https://push.example/ok",
        memberId: hannes.id,
        p256dh: "key",
        auth: "auth",
        locale: "de",
      },
      {
        endpoint: "https://push.example/dead",
        memberId: hannes.id,
        p256dh: "key",
        auth: "auth",
        locale: "en",
      },
      {
        endpoint: "https://push.example/fail",
        memberId: hannes.id,
        p256dh: "key",
        auth: "auth",
        locale: "de",
      },
      {
        endpoint: "https://push.example/other-member",
        memberId: sarah.id,
        p256dh: "key",
        auth: "auth",
        locale: "de",
      },
    ]).run();
    enqueueNotification(ctx.handle.db, {
      kind: "context_entered",
      recipientMemberId: hannes.id,
      actorMemberId: null,
      entityType: "task",
      entityId: task.id,
      entityTitle: task.title,
      sourceKey: "delivery",
    });
    let failShouldSucceed = false;
    const send = vi.fn(async (subscription: { endpoint: string }) => {
      if (subscription.endpoint.endsWith("/dead")) {
        throw { statusCode: 410 };
      }
      if (subscription.endpoint.endsWith("/fail") && !failShouldSucceed) {
        throw new Error("temporary");
      }
    });
    const logger = { error: vi.fn() };

    await dispatchNotificationEvents(ctx.handle.db, { send }, logger);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send).not.toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "https://push.example/other-member" }),
      expect.any(String),
      expect.anything(),
    );
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(
      ctx.handle.db
        .select()
        .from(schema.pushSubscriptions)
        .where(eq(schema.pushSubscriptions.endpoint, "https://push.example/dead"))
        .get(),
    ).toBeUndefined();
    // The event as a whole is not yet processed: the "/fail" subscription
    // still needs a retry pass.
    expect(
      ctx.handle.db
        .select()
        .from(schema.notificationEvents)
        .where(isNull(schema.notificationEvents.processedAt))
        .all(),
    ).toHaveLength(1);

    send.mockClear();
    failShouldSucceed = true;
    await dispatchNotificationEvents(ctx.handle.db, { send }, logger);
    // Only the still-outstanding "/fail" subscription is retried; "/ok"
    // already has a delivery record and must not be sent to again.
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "https://push.example/fail" }),
      expect.any(String),
      expect.anything(),
    );
    expect(
      ctx.handle.db
        .select()
        .from(schema.notificationEvents)
        .where(isNull(schema.notificationEvents.processedAt))
        .all(),
    ).toEqual([]);
  });

  it("marks a single-subscription event processed once a 404/410 permanently removes it", async () => {
    const hannes = addMember(ctx, "Hannes");
    const task = createTask(ctx.handle.db, { title: "Paket abholen" });
    ctx.handle.db.insert(schema.pushSubscriptions).values({
      endpoint: "https://push.example/dead",
      memberId: hannes.id,
      p256dh: "key",
      auth: "auth",
      locale: "de",
    }).run();
    enqueueNotification(ctx.handle.db, {
      kind: "context_entered",
      recipientMemberId: hannes.id,
      actorMemberId: null,
      entityType: "task",
      entityId: task.id,
      entityTitle: task.title,
      sourceKey: "dead-only",
    });
    const send = vi.fn().mockRejectedValue({ statusCode: 404 });
    await dispatchNotificationEvents(ctx.handle.db, { send }, { error: vi.fn() });
    expect(
      ctx.handle.db.select().from(schema.pushSubscriptions).all(),
    ).toEqual([]);
    expect(
      ctx.handle.db
        .select()
        .from(schema.notificationEvents)
        .where(isNull(schema.notificationEvents.processedAt))
        .all(),
    ).toEqual([]);
  });

  it("suppresses disabled notification types without affecting other types", async () => {
    const hannes = addMember(ctx, "Hannes");
    const task = createTask(ctx.handle.db, { title: "Paket abholen" });
    ctx.handle.db.insert(schema.pushSubscriptions).values({
      endpoint: "https://push.example/device",
      memberId: hannes.id,
      p256dh: "key",
      auth: "auth",
      locale: "de",
    }).run();
    ctx.handle.db.insert(schema.pushNotificationPreferences).values({
      memberId: hannes.id,
      contextEntered: false,
    }).run();
    enqueueNotification(ctx.handle.db, {
      kind: "context_entered",
      recipientMemberId: hannes.id,
      actorMemberId: null,
      entityType: "task",
      entityId: task.id,
      entityTitle: task.title,
      sourceKey: "disabled-context",
    });
    enqueueNotification(ctx.handle.db, {
      kind: "task_reminder",
      recipientMemberId: hannes.id,
      actorMemberId: null,
      entityType: "task",
      entityId: task.id,
      entityTitle: task.title,
      sourceKey: "enabled-reminder",
    });
    const send = vi.fn<PushTransport["send"]>().mockResolvedValue(undefined);

    await dispatchNotificationEvents(
      ctx.handle.db,
      { send },
      { error: vi.fn() },
    );

    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(send.mock.calls[0]![1])).toEqual(
      expect.objectContaining({ kind: "task_reminder" }),
    );
    expect(
      ctx.handle.db
        .select()
        .from(schema.notificationEvents)
        .where(isNull(schema.notificationEvents.processedAt))
        .all(),
    ).toEqual([]);
  });
});
