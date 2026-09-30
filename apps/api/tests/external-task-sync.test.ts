import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "../src/db/schema.js";
import { syncExternalTask } from "../src/domain/externalTaskSync.js";
import { updateTask } from "../src/domain/taskCrud.js";
import { cancelTask, completeTask, reopenTask } from "../src/domain/taskWorkflow.js";
import {
  closeTestContext,
  createTestContext,
  type TestContext,
} from "./helpers.js";

describe("Home Assistant external task reconciliation", () => {
  let ctx: TestContext;
  let integrationId: number;
  let memberId: number;

  beforeEach(() => {
    ctx = createTestContext();
    ctx.handle.sqlite.pragma("reverse_unordered_selects = ON");
    memberId = ctx.handle.db.insert(schema.members)
      .values({ name: "Hannes", color: "#123456" })
      .returning({ id: schema.members.id }).get().id;
    integrationId = ctx.handle.db.insert(schema.homeAssistantIntegrations)
      .values({
        instanceId: "test",
        tokenHash: "token",
        protocolVersion: 1,
        connectedAt: new Date().toISOString(),
      })
      .returning({ id: schema.homeAssistantIntegrations.id }).get().id;
    ctx.handle.db.insert(schema.homeAssistantPeople).values({
      integrationId,
      externalId: "person.hannes",
      name: "Hannes",
      state: "known",
      observedAt: new Date().toISOString(),
    }).run();
    ctx.handle.db.insert(schema.homeAssistantMemberMappings).values({
      memberId,
      externalPersonId: "person.hannes",
    }).run();
  });

  afterEach(async () => closeTestContext(ctx));

  it("creates idempotently and reconciles only supplied fields", () => {
    const first = syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "school:lars:sports:2026-09-23",
      relevant: true,
      title: "Sportzeug",
      person: "person.hannes",
      notes: "Von HA",
      priority: 1,
    })!;
    const second = syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "school:lars:sports:2026-09-23",
      relevant: true,
    })!;
    expect(second.taskId).toBe(first.taskId);
    expect(ctx.handle.db.select().from(schema.workItems).all()).toHaveLength(1);
    const task = ctx.handle.db.select().from(schema.workItems).get()!;
    expect(task.notes).toBe("Von HA");
    expect(task.priority).toBe(1);
  });

  it("reconciles one managed deadline reminder without touching manual reminders", () => {
    const created = syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "deadline-reminder",
      relevant: true,
      title: "Frist",
      dueDate: "2026-10-10",
      deadlineReminder: {
        daysBefore: 1,
        time: "19:00",
        timezone: "Europe/Berlin",
      },
    })!;
    let link = ctx.handle.db.select().from(schema.externalTaskLinks)
      .where(eq(schema.externalTaskLinks.taskId, created.taskId)).get()!;
    const managedId = ctx.handle.db.select()
      .from(schema.externalTaskLinkManagedReminders)
      .where(eq(schema.externalTaskLinkManagedReminders.externalTaskLinkId, link.id))
      .get()!.reminderId;
    expect(ctx.handle.db.select().from(schema.taskReminders)
      .where(eq(schema.taskReminders.taskId, created.taskId)).all())
      .toEqual([expect.objectContaining({
        id: managedId,
        kind: "deadline_relative",
        daysBefore: 1,
        time: "19:00",
        timezone: "Europe/Berlin",
      })]);

    const manual = ctx.handle.db.insert(schema.taskReminders).values({
      taskId: created.taskId,
      kind: "absolute",
      at: "2026-10-01T08:00:00.000Z",
    }).returning().get();
    syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "deadline-reminder",
      relevant: true,
      deadlineReminder: {
        daysBefore: 2,
        time: "20:00",
        timezone: "Europe/Berlin",
      },
    });
    syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "deadline-reminder",
      relevant: true,
      deadlineReminder: {
        daysBefore: 2,
        time: "20:00",
        timezone: "Europe/Berlin",
      },
    });
    let reminders = ctx.handle.db.select().from(schema.taskReminders)
      .where(eq(schema.taskReminders.taskId, created.taskId)).all();
    expect(reminders).toHaveLength(2);
    expect(reminders).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: managedId,
        daysBefore: 2,
        time: "20:00",
      }),
      expect.objectContaining({ id: manual.id, kind: "absolute" }),
    ]));
    link = ctx.handle.db.select().from(schema.externalTaskLinks)
      .where(eq(schema.externalTaskLinks.taskId, created.taskId)).get()!;
    expect(ctx.handle.db.select()
      .from(schema.externalTaskLinkManagedReminders)
      .where(eq(schema.externalTaskLinkManagedReminders.externalTaskLinkId, link.id))
      .get()?.reminderId).toBe(managedId);

    syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "deadline-reminder",
      relevant: true,
    });
    expect(ctx.handle.db.select().from(schema.taskReminders)
      .where(eq(schema.taskReminders.taskId, created.taskId)).all())
      .toHaveLength(2);

    syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "deadline-reminder",
      relevant: true,
      deadlineReminder: null,
    });
    reminders = ctx.handle.db.select().from(schema.taskReminders)
      .where(eq(schema.taskReminders.taskId, created.taskId)).all();
    expect(reminders).toEqual([expect.objectContaining({ id: manual.id, kind: "absolute" })]);
    expect(ctx.handle.db.select().from(schema.externalTaskLinkManagedReminders)
      .where(eq(schema.externalTaskLinkManagedReminders.externalTaskLinkId, link.id))
      .all()).toHaveLength(0);
  });

  it("recreates a managed reminder after manual deletion", () => {
    const created = syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "recreate-reminder",
      relevant: true,
      title: "Erinnerung",
      deadlineReminder: {
        daysBefore: 1,
        time: "19:00",
        timezone: "Europe/Berlin",
      },
    })!;
    const firstLink = ctx.handle.db.select().from(schema.externalTaskLinks)
      .where(eq(schema.externalTaskLinks.taskId, created.taskId)).get()!;
    const firstMapping = ctx.handle.db.select()
      .from(schema.externalTaskLinkManagedReminders)
      .where(eq(schema.externalTaskLinkManagedReminders.externalTaskLinkId, firstLink.id))
      .get()!;
    ctx.handle.db.delete(schema.taskReminders)
      .where(eq(schema.taskReminders.id, firstMapping.reminderId)).run();

    syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "recreate-reminder",
      relevant: true,
      deadlineReminder: {
        daysBefore: 1,
        time: "19:00",
        timezone: "Europe/Berlin",
      },
    });
    const secondLink = ctx.handle.db.select().from(schema.externalTaskLinks)
      .where(eq(schema.externalTaskLinks.taskId, created.taskId)).get()!;
    const secondMapping = ctx.handle.db.select()
      .from(schema.externalTaskLinkManagedReminders)
      .where(eq(schema.externalTaskLinkManagedReminders.externalTaskLinkId, secondLink.id))
      .get()!;
    expect(secondMapping.reminderId).not.toBe(firstMapping.reminderId);
    expect(ctx.handle.db.select().from(schema.taskReminders)
      .where(eq(schema.taskReminders.taskId, created.taskId)).all()).toHaveLength(1);
  });

  it("reconciles keyed managed reminders without touching manual reminders", () => {
    const created = syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "keyed-reminders",
      relevant: true,
      title: "Mehrere Erinnerungen",
      dueDate: "2026-10-10",
      deadlineReminders: [
        { key: "early", daysBefore: 5, time: "19:00", timezone: "Europe/Berlin" },
        { key: "eve", daysBefore: 1, time: "19:00", timezone: "Europe/Berlin" },
      ],
    })!;
    const link = ctx.handle.db.select().from(schema.externalTaskLinks)
      .where(eq(schema.externalTaskLinks.taskId, created.taskId)).get()!;
    const firstMappings = ctx.handle.db.select()
      .from(schema.externalTaskLinkManagedReminders)
      .where(eq(schema.externalTaskLinkManagedReminders.externalTaskLinkId, link.id))
      .all();
    expect(firstMappings).toHaveLength(2);
    const initialByKey = new Map(firstMappings.map((mapping) => [
      mapping.key,
      ctx.handle.db.select().from(schema.taskReminders)
        .where(eq(schema.taskReminders.id, mapping.reminderId)).get()!,
    ]));
    expect(initialByKey.get("early")).toMatchObject({
      daysBefore: 5,
      time: "19:00",
      timezone: "Europe/Berlin",
    });
    expect(initialByKey.get("eve")).toMatchObject({
      daysBefore: 1,
      time: "19:00",
      timezone: "Europe/Berlin",
    });

    const manual = ctx.handle.db.insert(schema.taskReminders).values({
      taskId: created.taskId,
      kind: "absolute",
      at: "2026-10-01T08:00:00.000Z",
    }).returning().get();

    syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "keyed-reminders",
      relevant: true,
      deadlineReminders: [
        { key: "early", daysBefore: 4, time: "20:00", timezone: "Europe/Berlin" },
        { key: "new", daysBefore: 0, time: "08:00", timezone: "UTC" },
      ],
    });
    const firstUpdatedMappings = ctx.handle.db.select()
      .from(schema.externalTaskLinkManagedReminders)
      .where(eq(schema.externalTaskLinkManagedReminders.externalTaskLinkId, link.id))
      .all();
    const firstNewId = firstUpdatedMappings.find((mapping) => mapping.key === "new")!.reminderId;
    syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "keyed-reminders",
      relevant: true,
      deadlineReminders: [
        { key: "early", daysBefore: 4, time: "20:00", timezone: "Europe/Berlin" },
        { key: "new", daysBefore: 0, time: "08:00", timezone: "UTC" },
      ],
    });

    const secondMappings = ctx.handle.db.select()
      .from(schema.externalTaskLinkManagedReminders)
      .where(eq(schema.externalTaskLinkManagedReminders.externalTaskLinkId, link.id))
      .all();
    const early = secondMappings.find((mapping) => mapping.key === "early")!;
    const createdNew = secondMappings.find((mapping) => mapping.key === "new")!;
    expect(early.reminderId).toBe(
      firstMappings.find((mapping) => mapping.key === "early")!.reminderId,
    );
    expect(secondMappings.find((mapping) => mapping.key === "eve")).toBeUndefined();
    expect(createdNew.reminderId).not.toBe(
      firstMappings.find((mapping) => mapping.key === "eve")!.reminderId,
    );
    expect(createdNew.reminderId).toBe(firstNewId);
    expect(ctx.handle.db.select().from(schema.taskReminders)
      .where(eq(schema.taskReminders.id, createdNew.reminderId)).get())
      .toMatchObject({ daysBefore: 0, time: "08:00", timezone: "UTC" });
    expect(ctx.handle.db.select().from(schema.taskReminders)
      .where(eq(schema.taskReminders.taskId, created.taskId)).all())
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: early.reminderId,
          daysBefore: 4,
          time: "20:00",
        }),
        expect.objectContaining({ id: createdNew.reminderId, daysBefore: 0 }),
        expect.objectContaining({ id: manual.id, kind: "absolute" }),
      ]));

    const deletedManaged = secondMappings.find((mapping) => mapping.key === "new")!;
    ctx.handle.db.delete(schema.taskReminders)
      .where(eq(schema.taskReminders.id, deletedManaged.reminderId)).run();
    syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "keyed-reminders",
      relevant: true,
      deadlineReminders: [
        { key: "early", daysBefore: 4, time: "20:00", timezone: "Europe/Berlin" },
        { key: "new", daysBefore: 0, time: "08:00", timezone: "UTC" },
      ],
    });
    const recreated = ctx.handle.db.select()
      .from(schema.externalTaskLinkManagedReminders)
      .where(eq(schema.externalTaskLinkManagedReminders.externalTaskLinkId, link.id))
      .all()
      .find((mapping) => mapping.key === "new")!;
    expect(recreated.reminderId).not.toBe(deletedManaged.reminderId);

    syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "keyed-reminders",
      relevant: true,
      deadlineReminder: {
        daysBefore: 2,
        time: "18:00",
        timezone: "Europe/Berlin",
      },
    });
    expect(ctx.handle.db.select().from(schema.externalTaskLinkManagedReminders)
      .where(eq(schema.externalTaskLinkManagedReminders.externalTaskLinkId, link.id))
      .all()
      .map((mapping) => mapping.key)
      .sort()).toEqual(["default", "early", "new"]);
    expect(ctx.handle.db.select().from(schema.taskReminders)
      .where(eq(schema.taskReminders.id, early.reminderId)).get())
      .toMatchObject({ daysBefore: 4, time: "20:00" });

    syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "keyed-reminders",
      relevant: true,
      deadlineReminder: null,
    });
    expect(ctx.handle.db.select().from(schema.externalTaskLinkManagedReminders)
      .where(eq(schema.externalTaskLinkManagedReminders.externalTaskLinkId, link.id))
      .all()
      .map((mapping) => mapping.key)
      .sort()).toEqual(["early", "new"]);
  });

  it("preserves non-default managed reminders during legacy singular reconciliation", () => {
    const created = syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "legacy-preservation",
      relevant: true,
      title: "Legacy",
      deadlineReminders: [
        { key: "early", daysBefore: 5, time: "19:00", timezone: "Europe/Berlin" },
        { key: "eve", daysBefore: 1, time: "19:00", timezone: "Europe/Berlin" },
      ],
    })!;
    const link = ctx.handle.db.select().from(schema.externalTaskLinks)
      .where(eq(schema.externalTaskLinks.taskId, created.taskId)).get()!;
    const mappings = ctx.handle.db.select()
      .from(schema.externalTaskLinkManagedReminders)
      .where(eq(schema.externalTaskLinkManagedReminders.externalTaskLinkId, link.id))
      .all();
    const early = mappings.find((mapping) => mapping.key === "early")!;
    const eve = mappings.find((mapping) => mapping.key === "eve")!;
    updateTask(ctx.handle.db, created.taskId, {
      reminders: [
        {
          id: early.reminderId,
          kind: "absolute",
          at: "2026-10-01T08:00:00.000Z",
        },
        {
          id: eve.reminderId,
          kind: "deadline_relative",
          daysBefore: 1,
          time: "19:00",
          timezone: "Europe/Berlin",
        },
      ],
    });

    syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "legacy-preservation",
      relevant: true,
      deadlineReminder: {
        daysBefore: 2,
        time: "18:00",
        timezone: "Europe/Berlin",
      },
    });
    expect(ctx.handle.db.select().from(schema.taskReminders)
      .where(eq(schema.taskReminders.id, early.reminderId)).get())
      .toMatchObject({ id: early.reminderId, kind: "absolute", at: "2026-10-01T08:00:00.000Z" });
    expect(ctx.handle.db.select().from(schema.taskReminders)
      .where(eq(schema.taskReminders.id, eve.reminderId)).get())
      .toMatchObject({ id: eve.reminderId, daysBefore: 1, time: "19:00" });

    syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "legacy-preservation",
      relevant: true,
      deadlineReminder: null,
    });
    expect(ctx.handle.db.select().from(schema.taskReminders)
      .where(eq(schema.taskReminders.id, early.reminderId)).get())
      .toMatchObject({ id: early.reminderId, kind: "absolute", at: "2026-10-01T08:00:00.000Z" });
    expect(ctx.handle.db.select().from(schema.taskReminders)
      .where(eq(schema.taskReminders.id, eve.reminderId)).get())
      .toMatchObject({ id: eve.reminderId, daysBefore: 1, time: "19:00" });
    expect(ctx.handle.db.select().from(schema.externalTaskLinkManagedReminders)
      .where(eq(schema.externalTaskLinkManagedReminders.externalTaskLinkId, link.id))
      .all()).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: "early", reminderId: early.reminderId }),
        expect.objectContaining({ key: "eve", reminderId: eve.reminderId }),
      ]));
  });

  it("applies a managed reminder when reopening a completed task", () => {
    const created = syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "reopen-reminder",
      relevant: true,
      title: "Erledigt",
    })!;
    completeTask(ctx.handle.db, created.taskId, "leave_open");
    syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "reopen-reminder",
      relevant: true,
      reactivateCompleted: true,
      dueDate: "2026-10-20",
      deadlineReminder: {
        daysBefore: 1,
        time: "19:00",
        timezone: "Europe/Berlin",
      },
    });
    expect(ctx.handle.db.select().from(schema.workItems)
      .where(eq(schema.workItems.id, created.taskId)).get())
      .toMatchObject({ status: "active", dueDate: "2026-10-20" });
    expect(ctx.handle.db.select().from(schema.taskReminders)
      .where(eq(schema.taskReminders.taskId, created.taskId)).get())
      .toMatchObject({ kind: "deadline_relative", daysBefore: 1 });
  });

  it("returns no task for an unknown irrelevant source", () => {
    expect(syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "unknown-irrelevant",
      relevant: false,
    })).toBeNull();
    expect(ctx.handle.db.select().from(schema.workItems).all()).toHaveLength(0);
  });

  it("keeps the link stable when Home Assistant is paired again", () => {
    const first = syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "stable",
      relevant: true,
      title: "Stabil",
    })!;
    const secondIntegration = ctx.handle.db.insert(schema.homeAssistantIntegrations)
      .values({
        instanceId: "paired-again",
        tokenHash: "token-2",
        protocolVersion: 1,
        connectedAt: new Date().toISOString(),
      })
      .returning({ id: schema.homeAssistantIntegrations.id }).get().id;
    const second = syncExternalTask(ctx.handle.db, secondIntegration, {
      sourceKey: "stable",
      relevant: true,
    })!;
    expect(second.taskId).toBe(first.taskId);
  });

  it("requires a title only for first creation", () => {
    expect(() => syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "needs-title",
      relevant: true,
    })).toThrowError(/title is required/i);
    const created = syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "needs-title",
      relevant: true,
      title: "Original",
    })!;
    syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "needs-title",
      relevant: true,
      priority: 5,
    });
    const task = ctx.handle.db.select().from(schema.workItems)
      .where(eq(schema.workItems.id, created.taskId)).get()!;
    expect(task.title).toBe("Original");
  });

  it("withdraws full payloads without completion and can reopen", () => {
    const created = syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "chores:bin",
      relevant: true,
      title: "Müll",
    })!;
    syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "chores:bin",
      relevant: false,
      title: "Ignored",
      scheduledDate: "2026-09-23",
      priority: 5,
    });
    let task = ctx.handle.db.select().from(schema.workItems)
      .where(eq(schema.workItems.id, created.taskId)).get()!;
    let link = ctx.handle.db.select().from(schema.externalTaskLinks)
      .where(eq(schema.externalTaskLinks.taskId, created.taskId)).get()!;
    expect(task.status).toBe("cancelled");
    expect(link.state).toBe("withdrawn");
    expect(link.withdrawnTaskRevision).toBe(task.revision);
    expect(ctx.handle.db.select().from(schema.contributionEvents).all()).toHaveLength(0);
    syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "chores:bin",
      relevant: true,
      title: "Müll rausbringen",
    });
    task = ctx.handle.db.select().from(schema.workItems)
      .where(eq(schema.workItems.id, created.taskId)).get()!;
    expect(task.status).toBe("active");
    expect(task.title).toBe("Müll rausbringen");
    link = ctx.handle.db.select().from(schema.externalTaskLinks)
      .where(eq(schema.externalTaskLinks.taskId, created.taskId)).get()!;
    expect(link.state).toBe("active");
    expect(link.withdrawnTaskRevision).toBeNull();
  });

  it("keeps repeated withdrawals idempotent and preserves reopen authority", () => {
    const created = syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "repeated-withdrawal",
      relevant: true,
      title: "Wiederkehrende Aufgabe",
    })!;
    syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "repeated-withdrawal",
      relevant: false,
    });
    const firstTask = ctx.handle.db.select().from(schema.workItems)
      .where(eq(schema.workItems.id, created.taskId)).get()!;
    const firstLink = ctx.handle.db.select().from(schema.externalTaskLinks)
      .where(eq(schema.externalTaskLinks.taskId, created.taskId)).get()!;
    const activityCount = ctx.handle.db.select().from(schema.activityEvents).all().length;
    const contributionCount = ctx.handle.db.select().from(schema.contributionEvents).all().length;

    const repeated = syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "repeated-withdrawal",
      relevant: false,
    })!;
    const secondTask = ctx.handle.db.select().from(schema.workItems)
      .where(eq(schema.workItems.id, created.taskId)).get()!;
    const secondLink = ctx.handle.db.select().from(schema.externalTaskLinks)
      .where(eq(schema.externalTaskLinks.taskId, created.taskId)).get()!;
    expect(repeated).toEqual({ taskId: created.taskId, state: "withdrawn" });
    expect(secondTask.status).toBe("cancelled");
    expect(secondTask.revision).toBe(firstTask.revision);
    expect(secondLink.state).toBe("withdrawn");
    expect(secondLink.withdrawnTaskRevision).toBe(firstLink.withdrawnTaskRevision);
    expect(ctx.handle.db.select().from(schema.activityEvents).all()).toHaveLength(activityCount);
    expect(ctx.handle.db.select().from(schema.contributionEvents).all()).toHaveLength(contributionCount);

    const reopened = syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "repeated-withdrawal",
      relevant: true,
    })!;
    const finalTask = ctx.handle.db.select().from(schema.workItems)
      .where(eq(schema.workItems.id, created.taskId)).get()!;
    const finalLink = ctx.handle.db.select().from(schema.externalTaskLinks)
      .where(eq(schema.externalTaskLinks.taskId, created.taskId)).get()!;
    expect(reopened.taskId).toBe(created.taskId);
    expect(finalTask.status).toBe("active");
    expect(finalLink.state).toBe("active");
    expect(finalLink.withdrawnTaskRevision).toBeNull();
  });

  it("preserves omitted fields and clears explicit nullable fields", () => {
    const created = syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "nullable-fields",
      relevant: true,
      title: "Initial",
      person: "person.hannes",
      scheduledDate: "2026-09-23",
      dueDate: "2026-09-24",
      priority: 1,
      size: "L",
    })!;
    syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "nullable-fields",
      relevant: true,
      title: "Changed",
    });
    let task = ctx.handle.db.select().from(schema.workItems)
      .where(eq(schema.workItems.id, created.taskId)).get()!;
    expect(task).toMatchObject({
      title: "Changed",
      ownerMemberId: memberId,
      scheduledDate: "2026-09-23",
      dueDate: "2026-09-24",
      priority: 1,
      size: "L",
    });
    syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "nullable-fields",
      relevant: true,
      person: null,
      scheduledDate: null,
      dueDate: null,
      priority: null,
      size: null,
    });
    task = ctx.handle.db.select().from(schema.workItems)
      .where(eq(schema.workItems.id, created.taskId)).get()!;
    expect(task.ownerMemberId).toBeNull();
    expect(task.scheduledDate).toBeNull();
    expect(task.dueDate).toBeNull();
    expect(task.priority).toBeNull();
    expect(task.size).toBeNull();
  });

  it("does not overwrite human notes during reconciliation", () => {
    const created = syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "notes",
      relevant: true,
      title: "Notizen",
      notes: "Initial HA note",
    })!;
    updateTask(ctx.handle.db, created.taskId, { notes: "Human note" });
    syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "notes",
      relevant: true,
      notes: "New HA note",
    });
    expect(ctx.handle.db.select().from(schema.workItems)
      .where(eq(schema.workItems.id, created.taskId)).get()?.notes)
      .toBe("Human note");
  });

  it("overwrites, clears, and preserves notes only when explicitly requested", () => {
    const created = syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "overwrite-notes",
      relevant: true,
      title: "Notizen",
      notes: "Initial HA note",
    })!;
    updateTask(ctx.handle.db, created.taskId, { notes: "Human note" });

    syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "overwrite-notes",
      relevant: true,
      notes: "Ignored note",
    });
    expect(ctx.handle.db.select().from(schema.workItems)
      .where(eq(schema.workItems.id, created.taskId)).get()?.notes)
      .toBe("Human note");

    syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "overwrite-notes",
      relevant: true,
      overwriteNotes: true,
      notes: "Replacement",
    });
    expect(ctx.handle.db.select().from(schema.workItems)
      .where(eq(schema.workItems.id, created.taskId)).get()?.notes)
      .toBe("Replacement");

    syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "overwrite-notes",
      relevant: true,
      overwriteNotes: true,
      notes: null,
    });
    expect(ctx.handle.db.select().from(schema.workItems)
      .where(eq(schema.workItems.id, created.taskId)).get()?.notes)
      .toBe("");

    syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "overwrite-notes",
      relevant: true,
      overwriteNotes: true,
    });
    expect(ctx.handle.db.select().from(schema.workItems)
      .where(eq(schema.workItems.id, created.taskId)).get()?.notes)
      .toBe("");
  });

  it("preserves human cancellation and completion", () => {
    const cancelled = syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "human-cancel",
      relevant: true,
      title: "Nicht öffnen",
    })!;
    cancelTask(ctx.handle.db, cancelled.taskId, "leave_open");
    syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "human-cancel",
      relevant: true,
      title: "Neue Version",
    });
    expect(ctx.handle.db.select().from(schema.workItems)
      .where(eq(schema.workItems.id, cancelled.taskId)).get()?.status)
      .toBe("cancelled");

    const completed = syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "human-done",
      relevant: true,
      title: "Erledigt",
    })!;
    completeTask(ctx.handle.db, completed.taskId, "leave_open");
    syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "human-done",
      relevant: true,
      title: "Nicht wieder öffnen",
    });
    const doneLink = ctx.handle.db.select().from(schema.externalTaskLinks)
      .where(eq(schema.externalTaskLinks.taskId, completed.taskId)).get()!;
    expect(ctx.handle.db.select().from(schema.workItems)
      .where(and(eq(schema.workItems.id, completed.taskId), eq(schema.workItems.status, "done")))
      .get()?.title).toBe("Erledigt");
    expect(doneLink.state).toBe("active");
    expect(doneLink.withdrawnTaskRevision).toBeNull();
  });

  it("reactivates completed tasks only when explicitly requested", () => {
    const protectedTask = syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "completed-protected",
      relevant: true,
      title: "Geschützt",
    })!;
    completeTask(ctx.handle.db, protectedTask.taskId, "leave_open");
    syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "completed-protected",
      relevant: true,
      title: "Nicht ändern",
      dueDate: "2026-10-01",
    });
    expect(ctx.handle.db.select().from(schema.workItems)
      .where(eq(schema.workItems.id, protectedTask.taskId)).get())
      .toMatchObject({ status: "done", title: "Geschützt", dueDate: null });

    const reopened = syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "completed-protected",
      relevant: true,
      reactivateCompleted: true,
      dueDate: "2026-10-02",
    })!;
    expect(reopened.taskId).toBe(protectedTask.taskId);
    expect(ctx.handle.db.select().from(schema.workItems)
      .where(eq(schema.workItems.id, protectedTask.taskId)).get())
      .toMatchObject({ status: "active", dueDate: "2026-10-02" });
    expect(ctx.handle.db.select().from(schema.workItems).all()).toHaveLength(1);
  });

  it("does not reactivate manually cancelled tasks", () => {
    const created = syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "cancelled-protected",
      relevant: true,
      title: "Nicht öffnen",
    })!;
    cancelTask(ctx.handle.db, created.taskId, "leave_open");
    syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "cancelled-protected",
      relevant: true,
      reactivateCompleted: true,
      dueDate: "2026-10-03",
    });
    expect(ctx.handle.db.select().from(schema.workItems)
      .where(eq(schema.workItems.id, created.taskId)).get())
      .toMatchObject({ status: "cancelled", dueDate: null });
  });

  it("does not let stale external withdrawal authority reopen a human cancellation", () => {
    const created = syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "stale-withdrawal",
      relevant: true,
      title: "Nicht automatisch öffnen",
    })!;
    syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "stale-withdrawal",
      relevant: false,
    });
    reopenTask(ctx.handle.db, created.taskId);
    cancelTask(ctx.handle.db, created.taskId, "leave_open");

    syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "stale-withdrawal",
      relevant: true,
      title: "Neue Version",
    });

    const task = ctx.handle.db.select().from(schema.workItems)
      .where(eq(schema.workItems.id, created.taskId)).get()!;
    const link = ctx.handle.db.select().from(schema.externalTaskLinks)
      .where(eq(schema.externalTaskLinks.taskId, created.taskId)).get()!;
    expect(task.status).toBe("cancelled");
    expect(task.title).toBe("Nicht automatisch öffnen");
    expect(link.state).toBe("active");
    expect(link.withdrawnTaskRevision).toBeNull();
  });

  it("normalizes withdrawal metadata after human completion", () => {
    const created = syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "completed-after-withdrawal",
      relevant: true,
      title: "Nicht wieder öffnen",
    })!;
    syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "completed-after-withdrawal",
      relevant: false,
    });
    reopenTask(ctx.handle.db, created.taskId);
    completeTask(ctx.handle.db, created.taskId, "leave_open");

    const result = syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "completed-after-withdrawal",
      relevant: true,
    });
    const link = ctx.handle.db.select().from(schema.externalTaskLinks)
      .where(eq(schema.externalTaskLinks.taskId, created.taskId)).get()!;
    expect(result).toEqual({ taskId: created.taskId, state: "active" });
    expect(link.state).toBe("active");
    expect(link.withdrawnTaskRevision).toBeNull();
  });

  it("does not resolve an owner for terminal reconciliation no-ops", () => {
    const created = syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "terminal-owner",
      relevant: true,
      title: "Erledigt",
    })!;
    completeTask(ctx.handle.db, created.taskId, "leave_open");

    expect(() => syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "terminal-owner",
      relevant: true,
      person: "person.unknown",
    })).not.toThrow();
  });

  it("does not resolve an owner for cancelled terminal no-ops", () => {
    const created = syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "cancelled-owner",
      relevant: true,
      title: "Abgebrochen",
    })!;
    cancelTask(ctx.handle.db, created.taskId, "leave_open");
    expect(() => syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "cancelled-owner",
      relevant: true,
      person: "person.unknown",
    })).not.toThrow();
    expect(ctx.handle.db.select().from(schema.workItems)
      .where(eq(schema.workItems.id, created.taskId)).get()?.status)
      .toBe("cancelled");
  });
});
