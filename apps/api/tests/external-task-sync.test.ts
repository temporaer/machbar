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
