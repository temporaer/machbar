import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getActivityDigest, acknowledgeActivityDigest } from "../src/activity/digest.js";
import * as schema from "../src/db/schema.js";
import {
  closeTestContext,
  createTestContext,
  insertTestProject,
  insertTestTask,
  type TestContext,
} from "./helpers.js";

describe("activity digest", () => {
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

  it("initializes a new member at the current event high-water mark", () => {
    const viewer = member("Mira");
    ctx.handle.db.insert(schema.activityEvents).values({
      kind: "task_created",
      entityType: "task",
      entityTitle: "Old",
      metadata: { scope: "household" },
    }).run();

    const first = getActivityDigest(ctx.handle.db, viewer.id);
    expect(first.entries).toEqual([]);
    expect(first.acknowledgedThroughEventId).toBe(1);

    ctx.handle.db.insert(schema.activityEvents).values({
      kind: "task_created",
      entityType: "task",
      entityTitle: "New",
      metadata: {
        scope: "household",
        affectedWorkItemId: 99,
        after: { effectiveOwnerId: viewer.id },
      },
    }).run();
    const second = getActivityDigest(ctx.handle.db, viewer.id);
    expect(second.throughEventId).toBe(2);
    expect(second.entries[0]?.kind).toBe("task_assigned");
  });

  it("reduces create, edits, and completion to one progress entry", () => {
    const viewer = member("Mira");
    const actor = member("Sarah");
    const project = insertTestProject(ctx.handle.db, {
      title: "Urlaub",
      status: "active",
    });
    const task = insertTestTask(ctx.handle.db, {
      title: "Hotel buchen",
      projectId: project.id,
      status: "actionable",
    });
    getActivityDigest(ctx.handle.db, viewer.id);
    ctx.handle.db.insert(schema.activityEvents).values([
      {
        kind: "task_created",
        entityType: "task",
        entityId: task.id,
        entityTitle: task.title,
        actorMemberId: actor.id,
        metadata: {
          scope: "household",
          affectedWorkItemId: task.id,
          projectContextId: project.id,
          after: { effectiveOwnerId: null },
        },
      },
      {
        kind: "task_updated",
        entityType: "task",
        entityId: task.id,
        entityTitle: "Hotel buchen",
        actorMemberId: actor.id,
        metadata: {
          scope: "household",
          affectedWorkItemId: task.id,
          projectContextId: project.id,
          changedFields: ["title"],
        },
      },
      {
        kind: "task_status_changed",
        entityType: "task",
        entityId: task.id,
        entityTitle: "Hotel buchen",
        actorMemberId: actor.id,
        metadata: {
          scope: "household",
          affectedWorkItemId: task.id,
          projectContextId: project.id,
          previousStatus: "actionable",
          nextStatus: "done",
        },
      },
    ]).run();

    const digest = getActivityDigest(ctx.handle.db, viewer.id);
    expect(digest.entries).toHaveLength(1);
    expect(digest.entries[0]?.kind).toBe("task_completed");
    expect(digest.entries[0]?.eventIds).toHaveLength(3);
  });

  it("does not report a completion that was reopened", () => {
    const viewer = member("Mira");
    const actor = member("Sarah");
    const task = insertTestTask(ctx.handle.db, {
      title: "Anmeldung",
      status: "actionable",
    });
    getActivityDigest(ctx.handle.db, viewer.id);
    ctx.handle.db.insert(schema.activityEvents).values([
      {
        kind: "task_status_changed",
        entityType: "task",
        entityId: task.id,
        entityTitle: task.title,
        actorMemberId: actor.id,
        metadata: { scope: "household", previousStatus: "actionable", nextStatus: "done" },
      },
      {
        kind: "task_status_changed",
        entityType: "task",
        entityId: task.id,
        entityTitle: task.title,
        actorMemberId: viewer.id,
        metadata: { scope: "household", previousStatus: "done", nextStatus: "actionable" },
      },
    ]).run();
    expect(getActivityDigest(ctx.handle.db, viewer.id).entries).toEqual([]);
  });

  it.each([
    ["created then deleted", ["task_created", "task_deleted"]],
    ["self-created open task", ["task_created"]],
  ])("%s does not become collaborative new work", (_name, kinds) => {
    const viewer = member("Mira");
    const actor = _name === "self-created open task" ? viewer : member("Sarah");
    const task = insertTestTask(ctx.handle.db, {
      title: "Transient",
      status: "actionable",
    });
    getActivityDigest(ctx.handle.db, viewer.id);
    ctx.handle.db.insert(schema.activityEvents).values(
      kinds.map((kind, index) => ({
        kind: kind as "task_created" | "task_deleted",
        entityType: "task" as const,
        entityId: kind === "task_deleted" ? null : task.id,
        entityTitle: task.title,
        actorMemberId: actor.id,
        metadata: {
          scope: "household" as const,
          affectedWorkItemId: task.id,
          ...(kind === "task_deleted"
            ? { before: { status: "actionable" as const } }
            : { after: { status: "actionable" as const } }),
        },
      })),
    ).run();
    expect(getActivityDigest(ctx.handle.db, viewer.id).entries).toEqual([]);
  });

  it("attributes completion to the completing member, not a later editor", () => {
    const viewer = member("Mira");
    const sarah = member("Sarah");
    const hannes = member("Hannes");
    const task = insertTestTask(ctx.handle.db, {
      title: "Hotel buchen",
      status: "done",
    });
    getActivityDigest(ctx.handle.db, viewer.id);
    ctx.handle.db.insert(schema.activityEvents).values([
      {
        kind: "task_status_changed",
        entityType: "task",
        entityId: task.id,
        entityTitle: task.title,
        actorMemberId: sarah.id,
        metadata: {
          scope: "household",
          affectedWorkItemId: task.id,
          previousStatus: "actionable",
          nextStatus: "done",
          after: { status: "done" },
        },
      },
      {
        kind: "task_updated",
        entityType: "task",
        entityId: task.id,
        entityTitle: task.title,
        actorMemberId: hannes.id,
        metadata: {
          scope: "household",
          affectedWorkItemId: task.id,
          changedFields: ["notes"],
          after: { status: "done" },
        },
      },
    ]).run();

    const entry = getActivityDigest(ctx.handle.db, viewer.id).entries[0]!;
    expect(entry.kind).toBe("task_completed");
    expect(entry.actor?.name).toBe("Sarah");
  });

  it("aggregates project task completions with actor counts and references", () => {
    const viewer = member("Mira");
    const sarah = member("Sarah");
    const lars = member("Lars");
    const project = insertTestProject(ctx.handle.db, {
      title: "Urlaub",
      status: "active",
    });
    const hotel = insertTestTask(ctx.handle.db, {
      title: "Hotel buchen",
      projectId: project.id,
      status: "done",
    });
    const tickets = insertTestTask(ctx.handle.db, {
      title: "Zugtickets kaufen",
      projectId: project.id,
      status: "done",
    });
    getActivityDigest(ctx.handle.db, viewer.id);
    ctx.handle.db.insert(schema.activityEvents).values([
      {
        kind: "task_status_changed",
        entityType: "task",
        entityId: hotel.id,
        entityTitle: hotel.title,
        actorMemberId: sarah.id,
        metadata: {
          scope: "household",
          affectedWorkItemId: hotel.id,
          projectContextId: project.id,
          previousStatus: "actionable",
          nextStatus: "done",
          after: { status: "done" },
        },
      },
      {
        kind: "task_status_changed",
        entityType: "task",
        entityId: tickets.id,
        entityTitle: tickets.title,
        actorMemberId: lars.id,
        metadata: {
          scope: "household",
          affectedWorkItemId: tickets.id,
          projectContextId: project.id,
          previousStatus: "actionable",
          nextStatus: "done",
          after: { status: "done" },
        },
      },
    ]).run();

    const entry = getActivityDigest(ctx.handle.db, viewer.id).entries[0]!;
    expect(entry.kind).toBe("project_progress");
    expect(entry.params.count).toBe(2);
    expect(entry.params.titles).toEqual(["Hotel buchen", "Zugtickets kaufen"]);
    expect(entry.params.actorCounts).toEqual(
      expect.arrayContaining([
        { actor: { id: sarah.id, name: "Sarah" }, count: 1 },
        { actor: { id: lars.id, name: "Lars" }, count: 1 },
      ]),
    );
  });

  it("aggregates assignments independently from project progress", () => {
    const viewer = member("Mira");
    const sarah = member("Sarah");
    const project = insertTestProject(ctx.handle.db, {
      title: "Schulanfang",
      status: "active",
    });
    const tasks = [1, 2, 3].map((index) =>
      insertTestTask(ctx.handle.db, {
        title: `Aufgabe ${index}`,
        projectId: project.id,
        ownerMemberId: viewer.id,
        status: "actionable",
      }),
    );
    getActivityDigest(ctx.handle.db, viewer.id);
    ctx.handle.db.insert(schema.activityEvents).values(
      tasks.map((task) => ({
        kind: "task_updated" as const,
        entityType: "task" as const,
        entityId: task.id,
        entityTitle: task.title,
        actorMemberId: sarah.id,
        metadata: {
          scope: "household" as const,
          affectedWorkItemId: task.id,
          projectContextId: project.id,
          changedFields: ["ownerMemberId"],
          before: { effectiveOwnerId: null },
          after: { effectiveOwnerId: viewer.id },
        },
      })),
    ).run();

    const entries = getActivityDigest(ctx.handle.db, viewer.id).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("project_assignment");
    expect(entries[0]?.params.count).toBe(3);
    expect(entries[0]?.related).toHaveLength(3);
  });

  it("does not interpret generic related task references as unlocks", () => {
    const viewer = member("Mira");
    const sarah = member("Sarah");
    const predecessor = insertTestTask(ctx.handle.db, {
      title: "Vorherige Aufgabe",
      status: "done",
    });
    const successor = insertTestTask(ctx.handle.db, {
      title: "Nachfolger",
      ownerMemberId: viewer.id,
      status: "actionable",
    });
    getActivityDigest(ctx.handle.db, viewer.id);
    ctx.handle.db.insert(schema.activityEvents).values({
      kind: "task_created",
      entityType: "task",
      entityId: successor.id,
      entityTitle: successor.title,
      actorMemberId: sarah.id,
      metadata: {
        scope: "household",
        affectedWorkItemId: successor.id,
        relatedTaskIds: [predecessor.id],
        relatedTaskTitles: [predecessor.title],
        after: { effectiveOwnerId: viewer.id, executable: true },
      },
    }).run();

    expect(
      getActivityDigest(ctx.handle.db, viewer.id).entries.some(
        (entry) => entry.kind === "task_executable",
      ),
    ).toBe(false);
  });

  it("reports only explicitly verified task unlocks", () => {
    const viewer = member("Mira");
    const sarah = member("Sarah");
    const task = insertTestTask(ctx.handle.db, {
      title: "Freigewordene Aufgabe",
      ownerMemberId: viewer.id,
      ownerInheritanceMode: "explicit",
      status: "actionable",
    });
    getActivityDigest(ctx.handle.db, viewer.id);
    ctx.handle.db.insert(schema.activityEvents).values({
      kind: "task_status_changed",
      entityType: "task",
      entityId: task.id,
      entityTitle: task.title,
      actorMemberId: sarah.id,
      metadata: {
        scope: "household",
        affectedWorkItemId: task.id,
        newlyExecutableTaskIds: [task.id],
        previousStatus: "done",
        nextStatus: "actionable",
        after: { executable: true, effectiveOwnerId: viewer.id },
      },
    }).run();

    const entry = getActivityDigest(ctx.handle.db, viewer.id).entries[0]!;
    expect(entry.kind).toBe("task_executable");
    expect(entry.priority).toBe(1);
    expect(entry.actor?.name).toBe("Sarah");
  });

  it("prefers one wait-resolution outcome when a wait makes a task executable", () => {
    const viewer = member("Hannes");
    const sarah = member("Sarah");
    const task = insertTestTask(ctx.handle.db, {
      title: "Auf Antwort reagieren",
      ownerMemberId: viewer.id,
      ownerInheritanceMode: "explicit",
      status: "actionable",
    });
    getActivityDigest(ctx.handle.db, viewer.id);
    ctx.handle.db.insert(schema.activityEvents).values({
      kind: "task_external_wait_resolved",
      entityType: "task",
      entityId: task.id,
      entityTitle: task.title,
      actorMemberId: sarah.id,
      metadata: {
        scope: "household",
        affectedWorkItemId: task.id,
        newlyExecutableTaskIds: [task.id],
        changedFields: ["externalWait"],
        after: { executable: true, effectiveOwnerId: viewer.id },
      },
    }).run();

    const entries = getActivityDigest(ctx.handle.db, viewer.id).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("wait_resolved");
    expect(entries[0]?.actor?.name).toBe("Sarah");
  });

  it("keeps an unlock recorded before an unrelated edit", () => {
    const viewer = member("Hannes");
    const sarah = member("Sarah");
    const dependency = insertTestTask(ctx.handle.db, {
      title: "Abhängigkeit",
      status: "done",
    });
    const task = insertTestTask(ctx.handle.db, {
      title: "Freigeschaltete Aufgabe",
      ownerMemberId: viewer.id,
      ownerInheritanceMode: "explicit",
      status: "actionable",
    });
    getActivityDigest(ctx.handle.db, viewer.id);
    ctx.handle.db.insert(schema.activityEvents).values([
      {
        kind: "task_status_changed",
        entityType: "task",
        entityId: dependency.id,
        entityTitle: dependency.title,
        actorMemberId: sarah.id,
        metadata: {
          scope: "household",
          affectedWorkItemId: dependency.id,
          newlyExecutableTaskIds: [task.id],
          previousStatus: "actionable",
          nextStatus: "done",
        },
      },
      {
        kind: "task_updated",
        entityType: "task",
        entityId: dependency.id,
        entityTitle: dependency.title,
        actorMemberId: sarah.id,
        metadata: {
          scope: "household",
          affectedWorkItemId: dependency.id,
          changedFields: ["notes"],
        },
      },
    ]).run();

    const entries = getActivityDigest(ctx.handle.db, viewer.id).entries;
    const unlock = entries.find((entry) => entry.kind === "task_executable");
    expect(unlock).toBeDefined();
    expect(unlock?.primary?.id).toBe(task.id);
  });

  it("attributes a later assignment to the assigning member", () => {
    const viewer = member("Hannes");
    const sarah = member("Sarah");
    const lars = member("Lars");
    const task = insertTestTask(ctx.handle.db, {
      title: "Rechnung prüfen",
      status: "actionable",
    });
    getActivityDigest(ctx.handle.db, viewer.id);
    ctx.handle.db.insert(schema.activityEvents).values([
      {
        kind: "task_created",
        entityType: "task",
        entityId: task.id,
        entityTitle: task.title,
        actorMemberId: sarah.id,
        metadata: {
          scope: "household",
          affectedWorkItemId: task.id,
          after: { effectiveOwnerId: null },
        },
      },
      {
        kind: "task_updated",
        entityType: "task",
        entityId: task.id,
        entityTitle: task.title,
        actorMemberId: lars.id,
        metadata: {
          scope: "household",
          affectedWorkItemId: task.id,
          changedFields: ["ownerMemberId"],
          before: { effectiveOwnerId: null },
          after: { effectiveOwnerId: viewer.id },
        },
      },
    ]).run();

    const entries = getActivityDigest(ctx.handle.db, viewer.id).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("task_assigned");
    expect(entries[0]?.actor?.name).toBe("Lars");
  });

  it("keeps a deadline change after a later unrelated edit and its actor", () => {
    const viewer = member("Mira");
    const sarah = member("Sarah");
    const lars = member("Lars");
    const task = insertTestTask(ctx.handle.db, {
      title: "Anmeldung",
      ownerMemberId: viewer.id,
      status: "actionable",
    });
    const today = new Date();
    const date = (offset: number) => {
      const value = new Date(today);
      value.setUTCDate(value.getUTCDate() + offset);
      return value.toISOString().slice(0, 10);
    };
    getActivityDigest(ctx.handle.db, viewer.id);
    ctx.handle.db.insert(schema.activityEvents).values([
      {
        kind: "task_updated",
        entityType: "task",
        entityId: task.id,
        entityTitle: task.title,
        actorMemberId: sarah.id,
        metadata: {
          scope: "household",
          affectedWorkItemId: task.id,
          changedFields: ["dueDate"],
          before: { dueDate: date(10), effectiveOwnerId: viewer.id },
          after: { dueDate: date(3), effectiveOwnerId: viewer.id },
        },
      },
      {
        kind: "task_updated",
        entityType: "task",
        entityId: task.id,
        entityTitle: task.title,
        actorMemberId: lars.id,
        metadata: {
          scope: "household",
          affectedWorkItemId: task.id,
          changedFields: ["notes"],
          before: { dueDate: date(3), effectiveOwnerId: viewer.id },
          after: { dueDate: date(3), effectiveOwnerId: viewer.id },
        },
      },
    ]).run();

    const entry = getActivityDigest(ctx.handle.db, viewer.id).entries[0]!;
    expect(entry.kind).toBe("plan_changed");
    expect(entry.priority).toBe(1);
    expect(entry.category).toBe("personal");
    expect(entry.actor?.name).toBe("Sarah");
    expect(entry.params.date).toBe(date(3));
  });

  it("attributes a deadline to its field-changing actor", () => {
    const viewer = member("Mira");
    const sarah = member("Sarah");
    const lars = member("Lars");
    const task = insertTestTask(ctx.handle.db, {
      title: "Bescheinigung",
      ownerMemberId: viewer.id,
      ownerInheritanceMode: "explicit",
      status: "actionable",
    });
    const today = new Date();
    const date = (offset: number) => {
      const value = new Date(today);
      value.setUTCDate(value.getUTCDate() + offset);
      return value.toISOString().slice(0, 10);
    };
    getActivityDigest(ctx.handle.db, viewer.id);
    ctx.handle.db.insert(schema.activityEvents).values([
      {
        kind: "task_updated",
        entityType: "task",
        entityId: task.id,
        entityTitle: task.title,
        actorMemberId: sarah.id,
        metadata: {
          scope: "household",
          affectedWorkItemId: task.id,
          changedFields: ["dueDate"],
          before: { dueDate: date(10), effectiveOwnerId: viewer.id },
          after: { dueDate: date(3), effectiveOwnerId: viewer.id },
        },
      },
      {
        kind: "task_updated",
        entityType: "task",
        entityId: task.id,
        entityTitle: task.title,
        actorMemberId: lars.id,
        metadata: {
          scope: "household",
          affectedWorkItemId: task.id,
          changedFields: ["scheduledDate"],
          before: { dueDate: date(3), scheduledDate: date(20), effectiveOwnerId: viewer.id },
          after: { dueDate: date(3), scheduledDate: date(4), effectiveOwnerId: viewer.id },
        },
      },
    ]).run();

    const entry = getActivityDigest(ctx.handle.db, viewer.id).entries[0]!;
    expect(entry.kind).toBe("plan_changed");
    expect(entry.params.dateType).toBe("deadline");
    expect(entry.actor?.name).toBe("Sarah");
  });

  it("does not expose invisible event counts in the digest response", () => {
    const viewer = member("Mira");
    const owner = member("Sarah");
    getActivityDigest(ctx.handle.db, viewer.id);
    ctx.handle.db.insert(schema.activityEvents).values({
      kind: "task_created",
      entityType: "task",
      entityTitle: "Private title",
      actorMemberId: owner.id,
      metadata: {
        scope: "work",
        affectedWorkItemId: 999,
        after: { effectiveOwnerId: owner.id },
      },
    }).run();

    const digest = getActivityDigest(ctx.handle.db, viewer.id);
    expect(digest.entries).toEqual([]);
    expect(digest.totalEntryCount).toBe(0);
    expect(digest.hiddenEntryCount).toBe(0);
  });

  it("hides private work events from other members, including deleted legacy events", () => {
    const viewer = member("Mira");
    const owner = member("Sarah");
    const task = insertTestTask(ctx.handle.db, {
      title: "Privat",
      ownerMemberId: owner.id,
      scope: "work",
      status: "actionable",
    });
    getActivityDigest(ctx.handle.db, viewer.id);
    ctx.handle.db.insert(schema.activityEvents).values({
      kind: "task_status_changed",
      entityType: "task",
      entityId: task.id,
      entityTitle: task.title,
      actorMemberId: owner.id,
      metadata: {
        scope: "work",
        before: { effectiveOwnerId: owner.id },
        after: { effectiveOwnerId: owner.id },
        previousStatus: "actionable",
        nextStatus: "done",
      },
    }).run();
    expect(getActivityDigest(ctx.handle.db, viewer.id).entries).toEqual([]);
  });

  it("acknowledges monotonically and leaves newer events unread", () => {
    const viewer = member("Mira");
    getActivityDigest(ctx.handle.db, viewer.id);
    const first = ctx.handle.db.insert(schema.activityEvents).values({
      kind: "task_created",
      entityType: "task",
      entityTitle: "Erste",
      metadata: { scope: "household" },
    }).returning({ id: schema.activityEvents.id }).get().id;
    const digest = getActivityDigest(ctx.handle.db, viewer.id);
    acknowledgeActivityDigest(ctx.handle.db, viewer.id, digest.throughEventId);
    acknowledgeActivityDigest(ctx.handle.db, viewer.id, first - 1);
    const newer = ctx.handle.db.insert(schema.activityEvents).values({
      kind: "task_created",
      entityType: "task",
      entityTitle: "Zweite",
      metadata: { scope: "household", affectedWorkItemId: 7 },
    }).returning({ id: schema.activityEvents.id }).get().id;
    const after = getActivityDigest(ctx.handle.db, viewer.id);
    expect(after.acknowledgedThroughEventId).toBe(first);
    expect(after.throughEventId).toBe(newer);
  });

  it("exposes a fixed digest snapshot and explicit acknowledgement endpoints", async () => {
    const viewer = member("Mira");
    const actor = member("Sarah");
    const task = insertTestTask(ctx.handle.db, {
      title: "Hotel buchen",
      status: "actionable",
    });
    const baseline = await ctx.app.inject({
      method: "GET",
      url: `/api/activity/digest?memberId=${viewer.id}`,
    });
    expect(baseline.statusCode).toBe(200);
    ctx.handle.db.insert(schema.activityEvents).values({
      kind: "task_status_changed",
      entityType: "task",
      entityId: task.id,
      entityTitle: task.title,
      actorMemberId: actor.id,
      metadata: {
        scope: "household",
        affectedWorkItemId: task.id,
        previousStatus: "actionable",
        nextStatus: "done",
      },
    }).run();
    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/activity/digest?memberId=${viewer.id}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().entries[0].kind).toBe("task_completed");
    const throughEventId = response.json().throughEventId;
    const ack = await ctx.app.inject({
      method: "POST",
      url: "/api/activity/digest/ack",
      payload: { memberId: viewer.id, throughEventId },
    });
    expect(ack.statusCode).toBe(200);
    expect((await ctx.app.inject({
      method: "GET",
      url: `/api/activity/digest?memberId=${viewer.id}`,
    })).json().entries).toEqual([]);
  });
});
