import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, isNull } from "drizzle-orm";
import { ACTIVITY_ACTOR_HEADER } from "@machbar/shared";
import * as schema from "../src/db/schema.js";
import {
  activateProject,
  createProject,
  createTask,
  updateProject,
  updateTask,
} from "../src/domain/mutations.js";
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

  it("emits task assignment events only for explicit owner changes by another member", () => {
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
    expect(
      ctx.handle.db.select().from(schema.notificationEvents).all(),
    ).toEqual([
      expect.objectContaining({
        kind: "task_assigned",
        recipientMemberId: hannes.id,
        actorMemberId: sarah.id,
        entityTitle: "Paket abholen",
      }),
    ]);

    updateTask(
      ctx.handle.db,
      task.id,
      { ownerMemberId: hannes.id, ownerInheritanceMode: "explicit" },
      { actorMemberId: sarah.id },
    );
    updateTask(
      ctx.handle.db,
      task.id,
      { notes: "Nur eine Notiz" },
      { actorMemberId: sarah.id },
    );
    expect(ctx.handle.db.select().from(schema.notificationEvents).all()).toHaveLength(1);
  });

  it("emits reassignment but suppresses self-assignment", () => {
    const hannes = addMember(ctx, "Hannes");
    const sarah = addMember(ctx, "Sarah");
    const task = createTask(ctx.handle.db, {
      title: "Paket abholen",
      ownerMemberId: sarah.id,
      ownerInheritanceMode: "explicit",
    });

    ctx.handle.db.delete(schema.notificationEvents).run();

    updateTask(
      ctx.handle.db,
      task.id,
      { ownerMemberId: hannes.id },
      { actorMemberId: sarah.id },
    );
    updateTask(
      ctx.handle.db,
      task.id,
      { ownerMemberId: sarah.id },
      { actorMemberId: sarah.id },
    );
    expect(ctx.handle.db.select().from(schema.notificationEvents).all()).toEqual([
      expect.objectContaining({
        recipientMemberId: hannes.id,
        actorMemberId: sarah.id,
      }),
    ]);
  });

  it("emits an event when another member creates a task for Hannes", () => {
    const hannes = addMember(ctx, "Hannes");
    const sarah = addMember(ctx, "Sarah");
    createTask(
      ctx.handle.db,
      {
        title: "Paket abholen",
        ownerMemberId: hannes.id,
        ownerInheritanceMode: "explicit",
      },
      { actorMemberId: sarah.id },
    );
    expect(ctx.handle.db.select().from(schema.notificationEvents).all()).toEqual([
      expect.objectContaining({
        kind: "task_assigned",
        recipientMemberId: hannes.id,
        actorMemberId: sarah.id,
      }),
    ]);
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

  it("emits due reminders idempotently and respects changed, cleared, and closed tasks", () => {
    const hannes = addMember(ctx, "Hannes");
    const due = createTask(ctx.handle.db, {
      title: "Paket abholen",
      status: "actionable",
      ownerMemberId: hannes.id,
      ownerInheritanceMode: "explicit",
      reminderAt: "2026-08-30T08:00:00.000Z",
    });
    const future = createTask(ctx.handle.db, {
      title: "Später",
      status: "actionable",
      ownerMemberId: hannes.id,
      ownerInheritanceMode: "explicit",
      reminderAt: "2026-09-01T08:00:00.000Z",
    });
    ctx.handle.db.delete(schema.notificationEvents).run();

    expect(enqueueDueReminders(ctx.handle.db, new Date("2026-08-30T09:00:00Z"))).toBe(1);
    expect(enqueueDueReminders(ctx.handle.db, new Date("2026-08-30T09:00:00Z"))).toBe(0);

    updateTask(ctx.handle.db, due.id, {
      reminderAt: "2026-08-30T08:30:00.000Z",
    });
    expect(enqueueDueReminders(ctx.handle.db, new Date("2026-08-30T09:00:00Z"))).toBe(1);
    updateTask(ctx.handle.db, due.id, { reminderAt: null });
    updateTask(ctx.handle.db, future.id, { status: "done", completedOn: "2026-08-30" });
    expect(enqueueDueReminders(ctx.handle.db, new Date("2026-09-02T09:00:00Z"))).toBe(0);
  });

  it("localizes German assignment copy and actor-neutral fallback", () => {
    const hannes = addMember(ctx, "Hannes");
    const sarah = addMember(ctx, "Sarah");
    const task = createTask(ctx.handle.db, { title: "Paket abholen" });
    enqueueNotification(ctx.handle.db, {
      kind: "task_assigned",
      recipientMemberId: hannes.id,
      actorMemberId: sarah.id,
      entityType: "task",
      entityId: task.id,
      entityTitle: task.title,
      sourceKey: "copy-with-actor",
    });

    enqueueNotification(ctx.handle.db, {
      kind: "task_assigned",
      recipientMemberId: hannes.id,
      actorMemberId: null,
      entityType: "task",
      entityId: task.id,
      entityTitle: task.title,
      sourceKey: "copy-without-actor",
    });
    const [withActor, withoutActor] = ctx.handle.db
      .select()
      .from(schema.notificationEvents)
      .all();

    expect(buildNotificationPayload(ctx.handle.db, withActor!, "de")).toEqual(
      expect.objectContaining({
        title: "Jetzt machbar",
        body: "Sarah hat dir „Paket abholen“ zugewiesen.",
        recurringTask: false,
        actions: [
          { action: "today", title: "Heute" },
          { action: "open", title: "Öffnen" },
        ],
      }),
    );
    expect(buildNotificationPayload(ctx.handle.db, withoutActor!, "de")).toEqual(
      expect.objectContaining({
        body: "Dir wurde „Paket abholen“ zugewiesen.",
      }),
    );
  });

  it("omits the Today action for recurring task assignments", () => {
    const hannes = addMember(ctx, "Hannes");
    const task = createTask(ctx.handle.db, {
      title: "Pflanzen gießen",
      status: "actionable",
      scheduledDate: "2026-08-30",
      repeatAfterDays: 7,
      allowedDeviationDays: 0,
    });
    enqueueNotification(ctx.handle.db, {
      kind: "task_assigned",
      recipientMemberId: hannes.id,
      actorMemberId: null,
      entityType: "task",
      entityId: task.id,
      entityTitle: task.title,
      sourceKey: "recurring-assignment",
    });
    const event = ctx.handle.db
      .select()
      .from(schema.notificationEvents)
      .where(eq(schema.notificationEvents.sourceKey, "recurring-assignment"))
      .get()!;
    expect(buildNotificationPayload(ctx.handle.db, event, "de").actions).toEqual([
      { action: "open", title: "Öffnen" },
    ]);
  });

  it("fans out to every recipient subscription, removes dead endpoints, and isolates failures", async () => {
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
      kind: "task_assigned",
      recipientMemberId: hannes.id,
      actorMemberId: null,
      entityType: "task",
      entityId: task.id,
      entityTitle: task.title,
      sourceKey: "delivery",
    });
    const send = vi.fn(async (subscription: { endpoint: string }) => {
      if (subscription.endpoint.endsWith("/dead")) {
        throw { statusCode: 410 };
      }
      if (subscription.endpoint.endsWith("/fail")) {
        throw new Error("temporary");
      }
    });
    const logger = { error: vi.fn() };

    await expect(
      dispatchNotificationEvents(ctx.handle.db, { send }, logger),
    ).resolves.toBe(1);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send).not.toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "https://push.example/other-member",
      }),
      expect.any(String),
    );
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(
      ctx.handle.db
        .select()
        .from(schema.pushSubscriptions)
        .where(eq(schema.pushSubscriptions.endpoint, "https://push.example/dead"))
        .get(),
    ).toBeUndefined();
    expect(
      ctx.handle.db
        .select()
        .from(schema.notificationEvents)
        .where(isNull(schema.notificationEvents.processedAt))
        .all(),
    ).toEqual([]);
  });
});
