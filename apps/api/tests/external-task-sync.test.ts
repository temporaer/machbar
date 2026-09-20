import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "../src/db/schema.js";
import { syncExternalTask } from "../src/domain/externalTaskSync.js";
import { completeTask } from "../src/domain/taskWorkflow.js";
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
    memberId = ctx.handle.db
      .insert(schema.members)
      .values({ name: "Hannes", color: "#123456" })
      .returning({ id: schema.members.id })
      .get().id;
    integrationId = ctx.handle.db
      .insert(schema.homeAssistantIntegrations)
      .values({
        instanceId: "test",
        tokenHash: "token",
        protocolVersion: 1,
        connectedAt: new Date().toISOString(),
      })
      .returning({ id: schema.homeAssistantIntegrations.id })
      .get().id;
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
    });
    const second = syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "school:lars:sports:2026-09-23",
      relevant: true,
    });
    expect(second.taskId).toBe(first.taskId);
    expect(ctx.handle.db.select().from(schema.workItems).all()).toHaveLength(1);
    const task = ctx.handle.db.select().from(schema.workItems).get()!;
    expect(task.notes).toBe("Von HA");
    expect(task.priority).toBe(1);
  });

  it("withdraws without completion and reopens only its own withdrawal", () => {
    const created = syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "chores:bin",
      relevant: true,
      title: "Müll",
    });
    syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "chores:bin",
      relevant: false,
    });
    let task = ctx.handle.db
      .select()
      .from(schema.workItems)
      .where(eq(schema.workItems.id, created.taskId))
      .get()!;
    expect(task.status).toBe("cancelled");
    expect(ctx.handle.db.select().from(schema.contributionEvents).all()).toHaveLength(0);
    syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "chores:bin",
      relevant: true,
      title: "Müll rausbringen",
    });
    task = ctx.handle.db
      .select()
      .from(schema.workItems)
      .where(eq(schema.workItems.id, created.taskId))
      .get()!;
    expect(task.status).toBe("active");
    expect(task.title).toBe("Müll rausbringen");
  });

  it("does not reopen a completed linked task", () => {
    const created = syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "done:task",
      relevant: true,
      title: "Erledigt",
    });
    completeTask(ctx.handle.db, created.taskId, "leave_open");
    syncExternalTask(ctx.handle.db, integrationId, {
      sourceKey: "done:task",
      relevant: true,
      title: "Nicht wieder öffnen",
    });
    const task = ctx.handle.db
      .select()
      .from(schema.workItems)
      .where(and(eq(schema.workItems.id, created.taskId), eq(schema.workItems.status, "done")))
      .get();
    expect(task).toBeDefined();
    expect(task?.title).toBe("Erledigt");
  });
});
