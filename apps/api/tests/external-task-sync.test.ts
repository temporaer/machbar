import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "../src/db/schema.js";
import { syncExternalTask } from "../src/domain/externalTaskSync.js";
import { updateTask } from "../src/domain/taskCrud.js";
import { cancelTask, completeTask, reopenTask } from "../src/domain/taskWorkflow.js";
import { createTestDatabase } from "./database.js";

describe("Home Assistant external task reconciliation", () => {
  let handle: ReturnType<typeof createTestDatabase>;
  let integrationId: number;
  let memberId: number;

  beforeEach(() => {
    handle = createTestDatabase();
    handle.sqlite.pragma("reverse_unordered_selects = ON");
    memberId = handle.db.insert(schema.members)
      .values({ name: "Hannes", color: "#123456" })
      .returning({ id: schema.members.id }).get().id;
    integrationId = handle.db.insert(schema.homeAssistantIntegrations)
      .values({
        instanceId: "test",
        tokenHash: "token",
        protocolVersion: 1,
        connectedAt: new Date().toISOString(),
      })
      .returning({ id: schema.homeAssistantIntegrations.id }).get().id;
    handle.db.insert(schema.homeAssistantPeople).values({
      integrationId,
      externalId: "person.hannes",
      name: "Hannes",
      state: "known",
      observedAt: new Date().toISOString(),
    }).run();
    handle.db.insert(schema.homeAssistantMemberMappings).values({
      memberId,
      externalPersonId: "person.hannes",
    }).run();
  });

  afterEach(() => handle.close());

  it("creates idempotently and reconciles only supplied fields", () => {
    const first = syncExternalTask(handle.db, integrationId, {
      sourceKey: "school:lars:sports:2026-09-23",
      relevant: true,
      title: "Sportzeug",
      person: "person.hannes",
      notes: "Von HA",
      priority: 1,
    })!;
    const second = syncExternalTask(handle.db, integrationId, {
      sourceKey: "school:lars:sports:2026-09-23",
      relevant: true,
    })!;
    expect(second.taskId).toBe(first.taskId);
    expect(handle.db.select().from(schema.workItems).all()).toHaveLength(1);
    const task = handle.db.select().from(schema.workItems).get()!;
    expect(task.notes).toBe("Von HA");
    expect(task.priority).toBe(1);
  });

  it("creates and reconciles canonical revisits", () => {
    const created = syncExternalTask(handle.db, integrationId, {
      sourceKey: "availability",
      relevant: true,
      title: "Bücher zurückgeben",
      dueDate: "2026-10-20",
      revisitAt: "2026-10-13T22:00:00.000Z",
    })!;
    let task = handle.db.select().from(schema.workItems)
      .where(eq(schema.workItems.id, created.taskId)).get()!;
    expect(task).toMatchObject({
      scheduledDate: null,
      revisitAt: "2026-10-13T22:00:00.000Z",
    });

    syncExternalTask(handle.db, integrationId, {
      sourceKey: "availability",
      relevant: true,
      scheduledDate: "2026-10-15",
    });
    task = handle.db.select().from(schema.workItems)
      .where(eq(schema.workItems.id, created.taskId)).get()!;
    expect(task).toMatchObject({
      scheduledDate: "2026-10-15",
      revisitAt: null,
    });

    syncExternalTask(handle.db, integrationId, {
      sourceKey: "availability",
      relevant: true,
    });
    task = handle.db.select().from(schema.workItems)
      .where(eq(schema.workItems.id, created.taskId)).get()!;
    expect(task).toMatchObject({
      scheduledDate: "2026-10-15",
      revisitAt: null,
    });

    syncExternalTask(handle.db, integrationId, {
      sourceKey: "availability",
      relevant: true,
      revisitAt: null,
    });
    task = handle.db.select().from(schema.workItems)
      .where(eq(schema.workItems.id, created.taskId)).get()!;
    expect(task).toMatchObject({
      scheduledDate: "2026-10-15",
      revisitAt: null,
    });
  });

  it("clears canonical revisits atomically", () => {
    const created = syncExternalTask(handle.db, integrationId, {
      sourceKey: "availability-mixed",
      relevant: true,
      title: "Nicht anwenden",
      revisitAt: "2026-10-13T22:00:00.000Z",
    })!;
    syncExternalTask(handle.db, integrationId, {
      sourceKey: "availability-mixed",
      relevant: true,
      title: "Nicht anwenden",
      revisitAt: null,
    });
    expect(handle.db.select().from(schema.workItems)
      .where(eq(schema.workItems.id, created.taskId)).get())
      .toMatchObject({
        title: "Nicht anwenden",
        revisitAt: null,
      });
  });

  it("reuses existing availability validation when scheduling before availability", () => {
    expect(() => syncExternalTask(handle.db, integrationId, {
      sourceKey: "availability-schedule-conflict",
      relevant: true,
      title: "Zu früh geplant",
      scheduledDate: "2026-10-13",
      revisitAt: "2026-10-13T22:00:00.000Z",
    })).toThrowError(/both a work plan and a revisit/i);
    expect(handle.db.select().from(schema.workItems).all()).toHaveLength(0);
  });

  it("reconciles one managed deadline reminder without touching manual reminders", () => {
    const created = syncExternalTask(handle.db, integrationId, {
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
    let link = handle.db.select().from(schema.externalTaskLinks)
      .where(eq(schema.externalTaskLinks.taskId, created.taskId)).get()!;
    const managedId = handle.db.select()
      .from(schema.externalTaskLinkManagedReminders)
      .where(eq(schema.externalTaskLinkManagedReminders.externalTaskLinkId, link.id))
      .get()!.reminderId;
    expect(handle.db.select().from(schema.taskReminders)
      .where(eq(schema.taskReminders.taskId, created.taskId)).all())
      .toEqual([expect.objectContaining({
        id: managedId,
        kind: "deadline_relative",
        daysBefore: 1,
        time: "19:00",
        timezone: "Europe/Berlin",
      })]);

    const manual = handle.db.insert(schema.taskReminders).values({
      taskId: created.taskId,
      kind: "absolute",
      at: "2026-10-01T08:00:00.000Z",
    }).returning().get();
    syncExternalTask(handle.db, integrationId, {
      sourceKey: "deadline-reminder",
      relevant: true,
      deadlineReminder: {
        daysBefore: 2,
        time: "20:00",
        timezone: "Europe/Berlin",
      },
    });
    syncExternalTask(handle.db, integrationId, {
      sourceKey: "deadline-reminder",
      relevant: true,
      deadlineReminder: {
        daysBefore: 2,
        time: "20:00",
        timezone: "Europe/Berlin",
      },
    });
    let reminders = handle.db.select().from(schema.taskReminders)
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
    link = handle.db.select().from(schema.externalTaskLinks)
      .where(eq(schema.externalTaskLinks.taskId, created.taskId)).get()!;
    expect(handle.db.select()
      .from(schema.externalTaskLinkManagedReminders)
      .where(eq(schema.externalTaskLinkManagedReminders.externalTaskLinkId, link.id))
      .get()?.reminderId).toBe(managedId);

    syncExternalTask(handle.db, integrationId, {
      sourceKey: "deadline-reminder",
      relevant: true,
    });
    expect(handle.db.select().from(schema.taskReminders)
      .where(eq(schema.taskReminders.taskId, created.taskId)).all())
      .toHaveLength(2);

    syncExternalTask(handle.db, integrationId, {
      sourceKey: "deadline-reminder",
      relevant: true,
      deadlineReminder: null,
    });
    reminders = handle.db.select().from(schema.taskReminders)
      .where(eq(schema.taskReminders.taskId, created.taskId)).all();
    expect(reminders).toEqual([expect.objectContaining({ id: manual.id, kind: "absolute" })]);
    expect(handle.db.select().from(schema.externalTaskLinkManagedReminders)
      .where(eq(schema.externalTaskLinkManagedReminders.externalTaskLinkId, link.id))
      .all()).toHaveLength(0);
  });

  it("recreates a managed reminder after manual deletion", () => {
    const created = syncExternalTask(handle.db, integrationId, {
      sourceKey: "recreate-reminder",
      relevant: true,
      title: "Erinnerung",
      deadlineReminder: {
        daysBefore: 1,
        time: "19:00",
        timezone: "Europe/Berlin",
      },
    })!;
    const firstLink = handle.db.select().from(schema.externalTaskLinks)
      .where(eq(schema.externalTaskLinks.taskId, created.taskId)).get()!;
    const firstMapping = handle.db.select()
      .from(schema.externalTaskLinkManagedReminders)
      .where(eq(schema.externalTaskLinkManagedReminders.externalTaskLinkId, firstLink.id))
      .get()!;
    handle.db.delete(schema.taskReminders)
      .where(eq(schema.taskReminders.id, firstMapping.reminderId)).run();

    syncExternalTask(handle.db, integrationId, {
      sourceKey: "recreate-reminder",
      relevant: true,
      deadlineReminder: {
        daysBefore: 1,
        time: "19:00",
        timezone: "Europe/Berlin",
      },
    });
    const secondLink = handle.db.select().from(schema.externalTaskLinks)
      .where(eq(schema.externalTaskLinks.taskId, created.taskId)).get()!;
    const secondMapping = handle.db.select()
      .from(schema.externalTaskLinkManagedReminders)
      .where(eq(schema.externalTaskLinkManagedReminders.externalTaskLinkId, secondLink.id))
      .get()!;
    expect(secondMapping.reminderId).not.toBe(firstMapping.reminderId);
    expect(handle.db.select().from(schema.taskReminders)
      .where(eq(schema.taskReminders.taskId, created.taskId)).all()).toHaveLength(1);
  });

  it("reconciles keyed managed reminders without touching manual reminders", () => {
    const created = syncExternalTask(handle.db, integrationId, {
      sourceKey: "keyed-reminders",
      relevant: true,
      title: "Mehrere Erinnerungen",
      dueDate: "2026-10-10",
      deadlineReminders: [
        { key: "early", daysBefore: 5, time: "19:00", timezone: "Europe/Berlin" },
        { key: "eve", daysBefore: 1, time: "19:00", timezone: "Europe/Berlin" },
      ],
    })!;
    const link = handle.db.select().from(schema.externalTaskLinks)
      .where(eq(schema.externalTaskLinks.taskId, created.taskId)).get()!;
    const firstMappings = handle.db.select()
      .from(schema.externalTaskLinkManagedReminders)
      .where(eq(schema.externalTaskLinkManagedReminders.externalTaskLinkId, link.id))
      .all();
    expect(firstMappings).toHaveLength(2);
    const initialByKey = new Map(firstMappings.map((mapping) => [
      mapping.key,
      handle.db.select().from(schema.taskReminders)
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

    const manual = handle.db.insert(schema.taskReminders).values({
      taskId: created.taskId,
      kind: "absolute",
      at: "2026-10-01T08:00:00.000Z",
    }).returning().get();

    syncExternalTask(handle.db, integrationId, {
      sourceKey: "keyed-reminders",
      relevant: true,
      deadlineReminders: [
        { key: "early", daysBefore: 4, time: "20:00", timezone: "Europe/Berlin" },
        { key: "new", daysBefore: 0, time: "08:00", timezone: "UTC" },
      ],
    });
    const firstUpdatedMappings = handle.db.select()
      .from(schema.externalTaskLinkManagedReminders)
      .where(eq(schema.externalTaskLinkManagedReminders.externalTaskLinkId, link.id))
      .all();
    const firstNewId = firstUpdatedMappings.find((mapping) => mapping.key === "new")!.reminderId;
    syncExternalTask(handle.db, integrationId, {
      sourceKey: "keyed-reminders",
      relevant: true,
      deadlineReminders: [
        { key: "early", daysBefore: 4, time: "20:00", timezone: "Europe/Berlin" },
        { key: "new", daysBefore: 0, time: "08:00", timezone: "UTC" },
      ],
    });

    const secondMappings = handle.db.select()
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
    expect(handle.db.select().from(schema.taskReminders)
      .where(eq(schema.taskReminders.id, createdNew.reminderId)).get())
      .toMatchObject({ daysBefore: 0, time: "08:00", timezone: "UTC" });
    expect(handle.db.select().from(schema.taskReminders)
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
    handle.db.delete(schema.taskReminders)
      .where(eq(schema.taskReminders.id, deletedManaged.reminderId)).run();
    syncExternalTask(handle.db, integrationId, {
      sourceKey: "keyed-reminders",
      relevant: true,
      deadlineReminders: [
        { key: "early", daysBefore: 4, time: "20:00", timezone: "Europe/Berlin" },
        { key: "new", daysBefore: 0, time: "08:00", timezone: "UTC" },
      ],
    });
    const recreated = handle.db.select()
      .from(schema.externalTaskLinkManagedReminders)
      .where(eq(schema.externalTaskLinkManagedReminders.externalTaskLinkId, link.id))
      .all()
      .find((mapping) => mapping.key === "new")!;
    expect(recreated.reminderId).not.toBe(deletedManaged.reminderId);

    syncExternalTask(handle.db, integrationId, {
      sourceKey: "keyed-reminders",
      relevant: true,
      deadlineReminder: {
        daysBefore: 2,
        time: "18:00",
        timezone: "Europe/Berlin",
      },
    });
    expect(handle.db.select().from(schema.externalTaskLinkManagedReminders)
      .where(eq(schema.externalTaskLinkManagedReminders.externalTaskLinkId, link.id))
      .all()
      .map((mapping) => mapping.key)
      .sort()).toEqual(["default", "early", "new"]);
    expect(handle.db.select().from(schema.taskReminders)
      .where(eq(schema.taskReminders.id, early.reminderId)).get())
      .toMatchObject({ daysBefore: 4, time: "20:00" });

    syncExternalTask(handle.db, integrationId, {
      sourceKey: "keyed-reminders",
      relevant: true,
      deadlineReminder: null,
    });
    expect(handle.db.select().from(schema.externalTaskLinkManagedReminders)
      .where(eq(schema.externalTaskLinkManagedReminders.externalTaskLinkId, link.id))
      .all()
      .map((mapping) => mapping.key)
      .sort()).toEqual(["early", "new"]);
  });

  it("preserves non-default managed reminders during legacy singular reconciliation", () => {
    const created = syncExternalTask(handle.db, integrationId, {
      sourceKey: "legacy-preservation",
      relevant: true,
      title: "Legacy",
      deadlineReminders: [
        { key: "early", daysBefore: 5, time: "19:00", timezone: "Europe/Berlin" },
        { key: "eve", daysBefore: 1, time: "19:00", timezone: "Europe/Berlin" },
      ],
    })!;
    const link = handle.db.select().from(schema.externalTaskLinks)
      .where(eq(schema.externalTaskLinks.taskId, created.taskId)).get()!;
    const mappings = handle.db.select()
      .from(schema.externalTaskLinkManagedReminders)
      .where(eq(schema.externalTaskLinkManagedReminders.externalTaskLinkId, link.id))
      .all();
    const early = mappings.find((mapping) => mapping.key === "early")!;
    const eve = mappings.find((mapping) => mapping.key === "eve")!;
    updateTask(handle.db, created.taskId, {
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

    syncExternalTask(handle.db, integrationId, {
      sourceKey: "legacy-preservation",
      relevant: true,
      deadlineReminder: {
        daysBefore: 2,
        time: "18:00",
        timezone: "Europe/Berlin",
      },
    });
    expect(handle.db.select().from(schema.taskReminders)
      .where(eq(schema.taskReminders.id, early.reminderId)).get())
      .toMatchObject({ id: early.reminderId, kind: "absolute", at: "2026-10-01T08:00:00.000Z" });
    expect(handle.db.select().from(schema.taskReminders)
      .where(eq(schema.taskReminders.id, eve.reminderId)).get())
      .toMatchObject({ id: eve.reminderId, daysBefore: 1, time: "19:00" });

    syncExternalTask(handle.db, integrationId, {
      sourceKey: "legacy-preservation",
      relevant: true,
      deadlineReminder: null,
    });
    expect(handle.db.select().from(schema.taskReminders)
      .where(eq(schema.taskReminders.id, early.reminderId)).get())
      .toMatchObject({ id: early.reminderId, kind: "absolute", at: "2026-10-01T08:00:00.000Z" });
    expect(handle.db.select().from(schema.taskReminders)
      .where(eq(schema.taskReminders.id, eve.reminderId)).get())
      .toMatchObject({ id: eve.reminderId, daysBefore: 1, time: "19:00" });
    expect(handle.db.select().from(schema.externalTaskLinkManagedReminders)
      .where(eq(schema.externalTaskLinkManagedReminders.externalTaskLinkId, link.id))
      .all()).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: "early", reminderId: early.reminderId }),
        expect.objectContaining({ key: "eve", reminderId: eve.reminderId }),
      ]));
  });

  it("applies a managed reminder when reopening a completed task", () => {
    const created = syncExternalTask(handle.db, integrationId, {
      sourceKey: "reopen-reminder",
      relevant: true,
      title: "Erledigt",
    })!;
    completeTask(handle.db, created.taskId, "leave_open");
    syncExternalTask(handle.db, integrationId, {
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
    expect(handle.db.select().from(schema.workItems)
      .where(eq(schema.workItems.id, created.taskId)).get())
      .toMatchObject({ status: "active", dueDate: "2026-10-20" });
    expect(handle.db.select().from(schema.taskReminders)
      .where(eq(schema.taskReminders.taskId, created.taskId)).get())
      .toMatchObject({ kind: "deadline_relative", daysBefore: 1 });
  });

  it("returns no task for an unknown irrelevant source", () => {
    expect(syncExternalTask(handle.db, integrationId, {
      sourceKey: "unknown-irrelevant",
      relevant: false,
    })).toBeNull();
    expect(handle.db.select().from(schema.workItems).all()).toHaveLength(0);
  });

  it("keeps the link stable when Home Assistant is paired again", () => {
    const first = syncExternalTask(handle.db, integrationId, {
      sourceKey: "stable",
      relevant: true,
      title: "Stabil",
    })!;
    const secondIntegration = handle.db.insert(schema.homeAssistantIntegrations)
      .values({
        instanceId: "paired-again",
        tokenHash: "token-2",
        protocolVersion: 1,
        connectedAt: new Date().toISOString(),
      })
      .returning({ id: schema.homeAssistantIntegrations.id }).get().id;
    const second = syncExternalTask(handle.db, secondIntegration, {
      sourceKey: "stable",
      relevant: true,
    })!;
    expect(second.taskId).toBe(first.taskId);
  });

  it("requires a title only for first creation", () => {
    expect(() => syncExternalTask(handle.db, integrationId, {
      sourceKey: "needs-title",
      relevant: true,
    })).toThrowError(/title is required/i);
    const created = syncExternalTask(handle.db, integrationId, {
      sourceKey: "needs-title",
      relevant: true,
      title: "Original",
    })!;
    syncExternalTask(handle.db, integrationId, {
      sourceKey: "needs-title",
      relevant: true,
      priority: 5,
    });
    const task = handle.db.select().from(schema.workItems)
      .where(eq(schema.workItems.id, created.taskId)).get()!;
    expect(task.title).toBe("Original");
  });

  it("withdraws full payloads without completion and can reopen", () => {
    const created = syncExternalTask(handle.db, integrationId, {
      sourceKey: "chores:bin",
      relevant: true,
      title: "Müll",
    })!;
    syncExternalTask(handle.db, integrationId, {
      sourceKey: "chores:bin",
      relevant: false,
      title: "Ignored",
      scheduledDate: "2026-09-23",
      priority: 5,
    });
    let task = handle.db.select().from(schema.workItems)
      .where(eq(schema.workItems.id, created.taskId)).get()!;
    let link = handle.db.select().from(schema.externalTaskLinks)
      .where(eq(schema.externalTaskLinks.taskId, created.taskId)).get()!;
    expect(task.status).toBe("cancelled");
    expect(link.state).toBe("withdrawn");
    expect(link.withdrawnTaskRevision).toBe(task.revision);
    expect(handle.db.select().from(schema.contributionEvents).all()).toHaveLength(0);
    syncExternalTask(handle.db, integrationId, {
      sourceKey: "chores:bin",
      relevant: true,
      title: "Müll rausbringen",
    });
    task = handle.db.select().from(schema.workItems)
      .where(eq(schema.workItems.id, created.taskId)).get()!;
    expect(task.status).toBe("active");
    expect(task.title).toBe("Müll rausbringen");
    link = handle.db.select().from(schema.externalTaskLinks)
      .where(eq(schema.externalTaskLinks.taskId, created.taskId)).get()!;
    expect(link.state).toBe("active");
    expect(link.withdrawnTaskRevision).toBeNull();
  });

  it("keeps repeated withdrawals idempotent and preserves reopen authority", () => {
    const created = syncExternalTask(handle.db, integrationId, {
      sourceKey: "repeated-withdrawal",
      relevant: true,
      title: "Wiederkehrende Aufgabe",
    })!;
    syncExternalTask(handle.db, integrationId, {
      sourceKey: "repeated-withdrawal",
      relevant: false,
    });
    const firstTask = handle.db.select().from(schema.workItems)
      .where(eq(schema.workItems.id, created.taskId)).get()!;
    const firstLink = handle.db.select().from(schema.externalTaskLinks)
      .where(eq(schema.externalTaskLinks.taskId, created.taskId)).get()!;
    const activityCount = handle.db.select().from(schema.activityEvents).all().length;
    const contributionCount = handle.db.select().from(schema.contributionEvents).all().length;

    const repeated = syncExternalTask(handle.db, integrationId, {
      sourceKey: "repeated-withdrawal",
      relevant: false,
    })!;
    const secondTask = handle.db.select().from(schema.workItems)
      .where(eq(schema.workItems.id, created.taskId)).get()!;
    const secondLink = handle.db.select().from(schema.externalTaskLinks)
      .where(eq(schema.externalTaskLinks.taskId, created.taskId)).get()!;
    expect(repeated).toEqual({ taskId: created.taskId, state: "withdrawn" });
    expect(secondTask.status).toBe("cancelled");
    expect(secondTask.revision).toBe(firstTask.revision);
    expect(secondLink.state).toBe("withdrawn");
    expect(secondLink.withdrawnTaskRevision).toBe(firstLink.withdrawnTaskRevision);
    expect(handle.db.select().from(schema.activityEvents).all()).toHaveLength(activityCount);
    expect(handle.db.select().from(schema.contributionEvents).all()).toHaveLength(contributionCount);

    const reopened = syncExternalTask(handle.db, integrationId, {
      sourceKey: "repeated-withdrawal",
      relevant: true,
    })!;
    const finalTask = handle.db.select().from(schema.workItems)
      .where(eq(schema.workItems.id, created.taskId)).get()!;
    const finalLink = handle.db.select().from(schema.externalTaskLinks)
      .where(eq(schema.externalTaskLinks.taskId, created.taskId)).get()!;
    expect(reopened.taskId).toBe(created.taskId);
    expect(finalTask.status).toBe("active");
    expect(finalLink.state).toBe("active");
    expect(finalLink.withdrawnTaskRevision).toBeNull();
  });

  it("preserves omitted fields and clears explicit nullable fields", () => {
    const created = syncExternalTask(handle.db, integrationId, {
      sourceKey: "nullable-fields",
      relevant: true,
      title: "Initial",
      person: "person.hannes",
      scheduledDate: "2026-09-23",
      dueDate: "2026-09-24",
      priority: 1,
      size: "L",
    })!;
    syncExternalTask(handle.db, integrationId, {
      sourceKey: "nullable-fields",
      relevant: true,
      title: "Changed",
    });
    let task = handle.db.select().from(schema.workItems)
      .where(eq(schema.workItems.id, created.taskId)).get()!;
    expect(task).toMatchObject({
      title: "Changed",
      ownerMemberId: memberId,
      scheduledDate: "2026-09-23",
      dueDate: "2026-09-24",
      priority: 1,
      size: "L",
    });
    syncExternalTask(handle.db, integrationId, {
      sourceKey: "nullable-fields",
      relevant: true,
      person: null,
      scheduledDate: null,
      dueDate: null,
      priority: null,
      size: null,
    });
    task = handle.db.select().from(schema.workItems)
      .where(eq(schema.workItems.id, created.taskId)).get()!;
    expect(task.ownerMemberId).toBeNull();
    expect(task.scheduledDate).toBeNull();
    expect(task.dueDate).toBeNull();
    expect(task.priority).toBeNull();
    expect(task.size).toBeNull();
  });

  it("does not overwrite human notes during reconciliation", () => {
    const created = syncExternalTask(handle.db, integrationId, {
      sourceKey: "notes",
      relevant: true,
      title: "Notizen",
      notes: "Initial HA note",
    })!;
    updateTask(handle.db, created.taskId, { notes: "Human note" });
    syncExternalTask(handle.db, integrationId, {
      sourceKey: "notes",
      relevant: true,
      notes: "New HA note",
    });
    expect(handle.db.select().from(schema.workItems)
      .where(eq(schema.workItems.id, created.taskId)).get()?.notes)
      .toBe("Human note");
  });

  it("overwrites, clears, and preserves notes only when explicitly requested", () => {
    const created = syncExternalTask(handle.db, integrationId, {
      sourceKey: "overwrite-notes",
      relevant: true,
      title: "Notizen",
      notes: "Initial HA note",
    })!;
    updateTask(handle.db, created.taskId, { notes: "Human note" });

    syncExternalTask(handle.db, integrationId, {
      sourceKey: "overwrite-notes",
      relevant: true,
      notes: "Ignored note",
    });
    expect(handle.db.select().from(schema.workItems)
      .where(eq(schema.workItems.id, created.taskId)).get()?.notes)
      .toBe("Human note");

    syncExternalTask(handle.db, integrationId, {
      sourceKey: "overwrite-notes",
      relevant: true,
      overwriteNotes: true,
      notes: "Replacement",
    });
    expect(handle.db.select().from(schema.workItems)
      .where(eq(schema.workItems.id, created.taskId)).get()?.notes)
      .toBe("Replacement");

    syncExternalTask(handle.db, integrationId, {
      sourceKey: "overwrite-notes",
      relevant: true,
      overwriteNotes: true,
      notes: null,
    });
    expect(handle.db.select().from(schema.workItems)
      .where(eq(schema.workItems.id, created.taskId)).get()?.notes)
      .toBe("");

    syncExternalTask(handle.db, integrationId, {
      sourceKey: "overwrite-notes",
      relevant: true,
      overwriteNotes: true,
    });
    expect(handle.db.select().from(schema.workItems)
      .where(eq(schema.workItems.id, created.taskId)).get()?.notes)
      .toBe("");
  });

  it("preserves human cancellation and completion", () => {
    const cancelled = syncExternalTask(handle.db, integrationId, {
      sourceKey: "human-cancel",
      relevant: true,
      title: "Nicht öffnen",
    })!;
    cancelTask(handle.db, cancelled.taskId, "leave_open");
    syncExternalTask(handle.db, integrationId, {
      sourceKey: "human-cancel",
      relevant: true,
      title: "Neue Version",
    });
    expect(handle.db.select().from(schema.workItems)
      .where(eq(schema.workItems.id, cancelled.taskId)).get()?.status)
      .toBe("cancelled");

    const completed = syncExternalTask(handle.db, integrationId, {
      sourceKey: "human-done",
      relevant: true,
      title: "Erledigt",
    })!;
    completeTask(handle.db, completed.taskId, "leave_open");
    syncExternalTask(handle.db, integrationId, {
      sourceKey: "human-done",
      relevant: true,
      title: "Nicht wieder öffnen",
    });
    const doneLink = handle.db.select().from(schema.externalTaskLinks)
      .where(eq(schema.externalTaskLinks.taskId, completed.taskId)).get()!;
    expect(handle.db.select().from(schema.workItems)
      .where(and(eq(schema.workItems.id, completed.taskId), eq(schema.workItems.status, "done")))
      .get()?.title).toBe("Erledigt");
    expect(doneLink.state).toBe("active");
    expect(doneLink.withdrawnTaskRevision).toBeNull();
  });

  it("reactivates completed tasks only when explicitly requested", () => {
    const protectedTask = syncExternalTask(handle.db, integrationId, {
      sourceKey: "completed-protected",
      relevant: true,
      title: "Geschützt",
    })!;
    completeTask(handle.db, protectedTask.taskId, "leave_open");
    syncExternalTask(handle.db, integrationId, {
      sourceKey: "completed-protected",
      relevant: true,
      title: "Nicht ändern",
      dueDate: "2026-10-01",
    });
    expect(handle.db.select().from(schema.workItems)
      .where(eq(schema.workItems.id, protectedTask.taskId)).get())
      .toMatchObject({ status: "done", title: "Geschützt", dueDate: null });

    const reopened = syncExternalTask(handle.db, integrationId, {
      sourceKey: "completed-protected",
      relevant: true,
      reactivateCompleted: true,
      dueDate: "2026-10-02",
    })!;
    expect(reopened.taskId).toBe(protectedTask.taskId);
    expect(handle.db.select().from(schema.workItems)
      .where(eq(schema.workItems.id, protectedTask.taskId)).get())
      .toMatchObject({ status: "active", dueDate: "2026-10-02" });
    expect(handle.db.select().from(schema.workItems).all()).toHaveLength(1);
  });

  it("does not reactivate manually cancelled tasks", () => {
    const created = syncExternalTask(handle.db, integrationId, {
      sourceKey: "cancelled-protected",
      relevant: true,
      title: "Nicht öffnen",
    })!;
    cancelTask(handle.db, created.taskId, "leave_open");
    syncExternalTask(handle.db, integrationId, {
      sourceKey: "cancelled-protected",
      relevant: true,
      reactivateCompleted: true,
      dueDate: "2026-10-03",
    });
    expect(handle.db.select().from(schema.workItems)
      .where(eq(schema.workItems.id, created.taskId)).get())
      .toMatchObject({ status: "cancelled", dueDate: null });
  });

  it("does not let stale external withdrawal authority reopen a human cancellation", () => {
    const created = syncExternalTask(handle.db, integrationId, {
      sourceKey: "stale-withdrawal",
      relevant: true,
      title: "Nicht automatisch öffnen",
    })!;
    syncExternalTask(handle.db, integrationId, {
      sourceKey: "stale-withdrawal",
      relevant: false,
    });
    reopenTask(handle.db, created.taskId);
    cancelTask(handle.db, created.taskId, "leave_open");

    syncExternalTask(handle.db, integrationId, {
      sourceKey: "stale-withdrawal",
      relevant: true,
      title: "Neue Version",
    });

    const task = handle.db.select().from(schema.workItems)
      .where(eq(schema.workItems.id, created.taskId)).get()!;
    const link = handle.db.select().from(schema.externalTaskLinks)
      .where(eq(schema.externalTaskLinks.taskId, created.taskId)).get()!;
    expect(task.status).toBe("cancelled");
    expect(task.title).toBe("Nicht automatisch öffnen");
    expect(link.state).toBe("active");
    expect(link.withdrawnTaskRevision).toBeNull();
  });

  it("normalizes withdrawal metadata after human completion", () => {
    const created = syncExternalTask(handle.db, integrationId, {
      sourceKey: "completed-after-withdrawal",
      relevant: true,
      title: "Nicht wieder öffnen",
    })!;
    syncExternalTask(handle.db, integrationId, {
      sourceKey: "completed-after-withdrawal",
      relevant: false,
    });
    reopenTask(handle.db, created.taskId);
    completeTask(handle.db, created.taskId, "leave_open");

    const result = syncExternalTask(handle.db, integrationId, {
      sourceKey: "completed-after-withdrawal",
      relevant: true,
    });
    const link = handle.db.select().from(schema.externalTaskLinks)
      .where(eq(schema.externalTaskLinks.taskId, created.taskId)).get()!;
    expect(result).toEqual({ taskId: created.taskId, state: "active" });
    expect(link.state).toBe("active");
    expect(link.withdrawnTaskRevision).toBeNull();
  });

  it("does not resolve an owner for terminal reconciliation no-ops", () => {
    const created = syncExternalTask(handle.db, integrationId, {
      sourceKey: "terminal-owner",
      relevant: true,
      title: "Erledigt",
    })!;
    completeTask(handle.db, created.taskId, "leave_open");

    expect(() => syncExternalTask(handle.db, integrationId, {
      sourceKey: "terminal-owner",
      relevant: true,
      person: "person.unknown",
    })).not.toThrow();
  });

  it("does not resolve an owner for cancelled terminal no-ops", () => {
    const created = syncExternalTask(handle.db, integrationId, {
      sourceKey: "cancelled-owner",
      relevant: true,
      title: "Abgebrochen",
    })!;
    cancelTask(handle.db, created.taskId, "leave_open");
    expect(() => syncExternalTask(handle.db, integrationId, {
      sourceKey: "cancelled-owner",
      relevant: true,
      person: "person.unknown",
    })).not.toThrow();
    expect(handle.db.select().from(schema.workItems)
      .where(eq(schema.workItems.id, created.taskId)).get()?.status)
      .toBe("cancelled");
  });
});
