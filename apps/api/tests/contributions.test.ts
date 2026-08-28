import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACTIVITY_ACTOR_HEADER } from "@machbar/shared";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema.js";
import {
  cancelTask,
  completeTask,
  createTask,
  deleteTask,
  reopenTask,
  updateTask,
} from "../src/domain/mutations.js";
import {
  getContributionSummary,
  recordContribution,
} from "../src/repo/contributionRepo.js";
import {
  closeTestContext,
  createTestContext,
  type TestContext,
} from "./helpers.js";

describe("contribution scoring", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await closeTestContext(ctx);
  });

  function member(name: string) {
    return ctx.handle.db
      .insert(schema.members)
      .values({ name, color: "#123456" })
      .returning()
      .get();
  }

  it("credits own and shared work personally but cross-owner completion only jointly", () => {
    const mira = member("Mira");
    const lea = member("Lea");
    const own = createTask(ctx.handle.db, {
      title: "Eigen",
      status: "actionable",
      ownerMemberId: mira.id,
      ownerInheritanceMode: "explicit",
    });
    const other = createTask(ctx.handle.db, {
      title: "Fremd",
      status: "actionable",
      ownerMemberId: lea.id,
      ownerInheritanceMode: "explicit",
    });

    completeTask(ctx.handle.db, own.id, undefined, {
      actorMemberId: mira.id,
    });
    completeTask(ctx.handle.db, other.id, undefined, {
      actorMemberId: mira.id,
    });

    const summary = getContributionSummary(ctx.handle.db);
    expect(summary.sharedTotal).toBe(4);
    expect(summary.sharedOnlyTotal).toBe(2);
    expect(summary.members.find((row) => row.member.id === mira.id)).toMatchObject({
      total: 2,
      categories: { completion: 2, planning: 0 },
    });
    expect(summary.members.find((row) => row.member.id === lea.id)?.total).toBe(0);
  });

  it("neutralizes completion when the task is reopened", () => {
    const mira = member("Mira");
    const task = createTask(ctx.handle.db, {
      title: "Wieder offen",
      status: "actionable",
    });
    completeTask(ctx.handle.db, task.id, undefined, {
      actorMemberId: mira.id,
    });
    reopenTask(ctx.handle.db, task.id, { actorMemberId: mira.id });

    expect(getContributionSummary(ctx.handle.db).sharedTotal).toBe(0);
    expect(
      ctx.handle.db.select().from(schema.contributionEvents).get()?.neutralizedAt,
    ).not.toBeNull();
  });

  it("uses ownership from before a combined owner-and-completion edit", () => {
    const mira = member("Mira");
    const lea = member("Lea");
    const task = createTask(ctx.handle.db, {
      title: "Leas Aufgabe",
      status: "actionable",
      ownerMemberId: lea.id,
      ownerInheritanceMode: "explicit",
    });

    updateTask(
      ctx.handle.db,
      task.id,
      {
        status: "done",
        ownerInheritanceMode: "none",
        ownerMemberId: null,
      },
      { actorMemberId: mira.id },
    );

    const summary = getContributionSummary(ctx.handle.db);
    expect(summary.sharedTotal).toBe(2);
    expect(summary.sharedOnlyTotal).toBe(2);
    expect(summary.members.find((row) => row.member.id === mira.id)?.total).toBe(0);
  });

  it("neutralizes completion when a done task is cancelled or deleted", () => {
    const mira = member("Mira");
    const cancelled = createTask(ctx.handle.db, {
      title: "Abgebrochen",
      status: "actionable",
    });
    completeTask(ctx.handle.db, cancelled.id, undefined, {
      actorMemberId: mira.id,
    });
    cancelTask(ctx.handle.db, cancelled.id, undefined, {
      actorMemberId: mira.id,
    });

    const deleted = createTask(ctx.handle.db, {
      title: "Gelöscht",
      status: "actionable",
    });
    completeTask(ctx.handle.db, deleted.id, undefined, {
      actorMemberId: mira.id,
    });
    deleteTask(ctx.handle.db, deleted.id, { actorMemberId: mira.id });

    expect(getContributionSummary(ctx.handle.db).sharedTotal).toBe(0);
  });

  it("treats subtree completion as one contribution", () => {
    const mira = member("Mira");
    const root = createTask(ctx.handle.db, {
      title: "Root",
      status: "actionable",
    });
    createTask(ctx.handle.db, {
      title: "Child",
      status: "actionable",
      parentTaskId: root.id,
    });

    completeTask(ctx.handle.db, root.id, "complete_children", {
      actorMemberId: mira.id,
    });

    expect(getContributionSummary(ctx.handle.db).sharedTotal).toBe(2);
    expect(ctx.handle.db.select().from(schema.contributionEvents).all()).toHaveLength(1);
  });

  it("rewards semantic planning improvements but not unattributed changes", () => {
    const mira = member("Mira");
    const task = createTask(ctx.handle.db, {
      title: "Klären",
      status: "captured",
    });

    updateTask(
      ctx.handle.db,
      task.id,
      { status: "actionable" },
      { actorMemberId: mira.id },
    );
    updateTask(ctx.handle.db, task.id, { size: "M" });

    const rows = ctx.handle.db.select().from(schema.contributionEvents).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      reason: "task_clarified",
      sharedPoints: 1,
      personalPoints: 1,
    });
  });

  it("deduplicates entity reasons and enforces rolling category and total caps", () => {
    const mira = member("Mira");
    const now = new Date("2026-08-28T10:00:00.000Z");

    const award = (
      entityId: number,
      reason: "task_completed" | "task_estimated",
      category: "completion" | "planning",
    ) => {
      const activity = ctx.handle.db
        .insert(schema.activityEvents)
        .values({
          createdAt: now.toISOString(),
          actorMemberId: mira.id,
          kind: "task_updated",
          entityType: "task",
          entityTitle: `Task ${entityId}`,
          metadata: {},
        })
        .returning()
        .get();
      return recordContribution(ctx.handle.db, {
        activityEventId: activity.id,
        actorMemberId: mira.id,
        category,
        reason,
        entityType: "task",
        entityId,
        personalEligible: true,
        now,
      });
    };

    expect(award(1, "task_completed", "completion")?.sharedPoints).toBe(2);
    expect(award(1, "task_completed", "completion")).toBeNull();
    expect(award(2, "task_completed", "completion")?.sharedPoints).toBe(2);
    expect(award(3, "task_completed", "completion")?.sharedPoints).toBe(0);
    expect(award(4, "task_estimated", "planning")?.sharedPoints).toBe(1);
    expect(award(5, "task_estimated", "planning")?.sharedPoints).toBe(1);
    expect(award(6, "task_estimated", "planning")?.sharedPoints).toBe(0);
  });

  it("uses an exact trailing-seven-day window", () => {
    const mira = member("Mira");
    const now = new Date("2026-08-28T10:00:00.000Z");
    const activity = ctx.handle.db
      .insert(schema.activityEvents)
      .values({
        createdAt: now.toISOString(),
        actorMemberId: mira.id,
        kind: "task_status_changed",
        entityType: "task",
        entityTitle: "Grenze",
        metadata: { previousStatus: "actionable", nextStatus: "done" },
      })
      .returning()
      .get();
    ctx.handle.db.insert(schema.contributionEvents).values([
      {
        createdAt: "2026-08-21T10:00:00.000Z",
        activityEventId: activity.id,
        actorMemberId: mira.id,
        category: "completion",
        reason: "task_completed",
        entityType: "task",
        entityId: 1,
        policyPoints: 2,
        sharedPoints: 2,
        personalPoints: 2,
      },
    ]).run();

    expect(getContributionSummary(ctx.handle.db, now).sharedTotal).toBe(2);
    expect(
      getContributionSummary(
        ctx.handle.db,
        new Date("2026-08-28T10:00:00.001Z"),
      ).sharedTotal,
    ).toBe(0);
  });

  it("moves a deleted member's former personal points into shared-only", () => {
    const mira = member("Mira");
    const task = createTask(ctx.handle.db, {
      title: "Danach gelöscht",
      status: "actionable",
    });
    completeTask(ctx.handle.db, task.id, undefined, {
      actorMemberId: mira.id,
    });
    ctx.handle.db
      .delete(schema.members)
      .where(eq(schema.members.id, mira.id))
      .run();

    const summary = getContributionSummary(ctx.handle.db);
    expect(summary.sharedTotal).toBe(2);
    expect(summary.sharedOnlyTotal).toBe(2);
    expect(summary.members).toEqual([]);
  });

  it("exposes the shared summary route", async () => {
    const mira = member("Mira");
    const task = createTask(ctx.handle.db, {
      title: "API",
      status: "actionable",
    });
    await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/complete`,
      headers: { [ACTIVITY_ACTOR_HEADER]: String(mira.id) },
      payload: {},
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/contributions/summary",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      sharedTotal: 2,
      sharedOnlyTotal: 0,
      sharedCategories: { completion: 2, planning: 0 },
      members: [
        {
          member: { id: mira.id, name: "Mira" },
          total: 2,
          categories: { completion: 2, planning: 0 },
        },
      ],
    });
  });
});
