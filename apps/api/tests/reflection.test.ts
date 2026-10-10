import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACTIVITY_ACTOR_HEADER } from "@machbar/shared";
import * as schema from "../src/db/schema.js";
import { buildReflectionBriefing } from "../src/reflection/briefing.js";
import { closeTestContext, createTestContext, insertTestProject, insertTestTask, type TestContext } from "./helpers.js";

describe("historical reflection briefing", () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = createTestContext(); });
  afterEach(async () => { await closeTestContext(ctx); });

  function member(name: string) {
    return ctx.handle.db.insert(schema.members).values({ name, color: "#123456" }).returning().get();
  }

  function event(values: {
    kind: (typeof schema.activityEvents.kind.enumValues)[number];
    title: string;
    id: number | null;
    type?: "task" | "project";
    createdAt: string;
    metadata?: typeof schema.activityEvents.$inferInsert.metadata;
  }) {
    ctx.handle.db.insert(schema.activityEvents).values({
      kind: values.kind, entityType: values.type ?? "task", entityId: values.id,
      entityTitle: values.title, createdAt: values.createdAt, metadata: values.metadata ?? { scope: "household" },
    }).run();
  }

  it("returns stable household facts with timezone boundaries, completions, postponements, waits and recurrence separated", () => {
    const mira = member("Mira");
    ctx.handle.db.insert(schema.householdSettings).values({ key: "timezone", value: "America/Los_Angeles" }).onConflictDoUpdate({ target: schema.householdSettings.key, set: { value: "America/Los_Angeles" } }).run();
    const project = insertTestProject(ctx.handle.db, { title: "Küche renovieren", status: "active", scope: "household" });
    const next = insertTestTask(ctx.handle.db, { title: "Fliesenmuster auswählen", projectId: project.id, status: "actionable", scheduledDate: "2025-01-15" });
    const waiting = insertTestTask(ctx.handle.db, { title: "Versicherung anrufen", status: "actionable" });
    const parent = insertTestTask(ctx.handle.db, { title: "Bad renovieren", status: "done" });
    const reopened = insertTestTask(ctx.handle.db, { title: "Abmeldung prüfen", status: "actionable" });
    ctx.handle.db.insert(schema.taskExternalWaits).values({ taskId: waiting.id, waitingFor: "Rückmeldung der Versicherung" }).run();
    const done = insertTestTask(ctx.handle.db, { title: "Kostenvoranschlag einholen", status: "done", completedAt: "2025-01-08T18:00:00.000Z" });
    const routine = insertTestTask(ctx.handle.db, { title: "Wöchentliches Backup prüfen", status: "actionable", repeatAfterDays: 7 });
    ctx.handle.db.insert(schema.taskRecurrenceOccurrences).values([
      { taskId: routine.id, scheduledDate: "2025-01-07", deadlineDate: "2025-01-08", completedOn: "2025-01-08", completedAt: "2025-01-08T19:00:00.000Z", result: "hit" },
      { taskId: routine.id, scheduledDate: "2025-01-14", deadlineDate: "2025-01-15", completedOn: "2025-01-15", completedAt: "2025-01-15T19:00:00.000Z", result: "miss" },
    ]).run();
    event({ kind: "task_status_changed", id: done.id, title: done.title, createdAt: "2025-01-09T02:00:00.000Z", metadata: { scope: "household", previousStatus: "actionable", nextStatus: "done" } });
    event({ kind: "task_updated", id: next.id, title: next.title, createdAt: "2025-01-10T20:00:00.000Z", metadata: { scope: "household", changedFields: ["scheduledDate"], before: { scheduledDate: "2025-01-15" }, after: { scheduledDate: "2025-01-20" } } });
    event({ kind: "task_updated", id: next.id, title: next.title, createdAt: "2025-01-11T20:00:00.000Z", metadata: { scope: "household", changedFields: ["scheduledDate"], recurrenceOccurrenceId: 44, nextScheduledDate: "2025-01-27", before: { scheduledDate: "2025-01-20" }, after: { scheduledDate: "2025-01-27" } } });
    event({ kind: "task_descendants_status_changed", id: parent.id, title: parent.title, type: "task", createdAt: "2025-01-12T20:00:00.000Z", metadata: { scope: "household", nextStatus: "done", affectedCount: 3 } });
    event({ kind: "task_status_changed", id: null, title: "Gelöschte Erledigung", createdAt: "2025-01-13T20:00:00.000Z", metadata: { scope: "household", affectedWorkItemId: 999, previousStatus: "actionable", nextStatus: "done" } });
    event({ kind: "task_status_changed", id: reopened.id, title: reopened.title, createdAt: "2025-01-14T10:00:00.000Z", metadata: { scope: "household", previousStatus: "actionable", nextStatus: "done" } });
    event({ kind: "task_status_changed", id: reopened.id, title: reopened.title, createdAt: "2025-01-14T11:00:00.000Z", metadata: { scope: "household", previousStatus: "done", nextStatus: "actionable" } });
    event({ kind: "task_updated", id: reopened.id, title: reopened.title, createdAt: "2025-01-14T12:00:00.000Z", metadata: { scope: "household", changedFields: ["reviewedAt"] } });

    const briefing = buildReflectionBriefing(ctx.handle.db, { subjectMemberId: mira.id, days: 30, scope: "household", now: new Date("2025-01-20T12:00:00.000Z") });
    expect(briefing.window).toEqual({ days: 30, startDate: "2024-12-22", endDate: "2025-01-20" });
    expect(briefing.timezone).toBe("America/Los_Angeles");
    expect(briefing.current.activeProjects.map((item) => item.title)).toContain("Küche renovieren");
    expect(briefing.current.executableNextActions.map((item) => item.id)).toContain(next.id);
    expect(briefing.current.waitingItems.map((item) => item.waitingFor)).toContain("Rückmeldung der Versicherung");
    expect(briefing.history.finiteCompletions).toContainEqual(expect.objectContaining({ id: done.id, title: done.title, date: "2025-01-08" }));
    expect(briefing.history.recurringWork).toContainEqual(expect.objectContaining({ taskId: routine.id, completed: 1, missed: 1 }));
    expect(briefing.history.bulkCompletionGroups).toContainEqual(expect.objectContaining({ id: parent.id, count: 3 }));
    expect(briefing.history.finiteCompletions).toContainEqual(expect.objectContaining({ id: 999, title: "Gelöschte Erledigung", href: "#/tasks/999" }));
    expect(briefing.history.finiteCompletions.some((item) => item.id === reopened.id)).toBe(false);
    expect(briefing.history.activityCounts.administrative).toBeGreaterThan(0);
    expect(briefing.history.postponements).toHaveLength(1);
    expect(briefing.history.postponements[0]).toMatchObject({ id: next.id, from: "2025-01-15", to: "2025-01-20" });
    expect(briefing.markdown).toContain("[Fliesenmuster auswählen](#/tasks/");
  });

  it("omits other members' private work and rejects cross-member work-scope requests", async () => {
    const mira = member("Mira");
    const sam = member("Sam");
    insertTestTask(ctx.handle.db, { title: "Miras privat", scope: "work", ownerMemberId: mira.id, ownerInheritanceMode: "explicit" });
    insertTestTask(ctx.handle.db, { title: "Sams privat", scope: "work", ownerMemberId: sam.id, ownerInheritanceMode: "explicit" });
    insertTestTask(ctx.handle.db, { title: "Gemeinsam", scope: "household" });

    const work = buildReflectionBriefing(ctx.handle.db, { subjectMemberId: mira.id, days: 90, scope: "work", now: new Date("2025-03-01T12:00:00Z") });
    expect(JSON.stringify(work)).toContain("Miras privat");
    expect(JSON.stringify(work)).not.toContain("Sams privat");
    expect(JSON.stringify(work)).not.toContain("Gemeinsam");

    const response = await ctx.app.inject({ method: "GET", url: `/api/reflection/briefing?memberId=${sam.id}&scope=work`, headers: { [ACTIVITY_ACTOR_HEADER]: String(mira.id) } });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("reflection_work_scope_forbidden");
  });

  it("returns explicit lack-of-evidence markers rather than using updatedAt as progress", () => {
    const mira = member("Mira");
    const task = insertTestTask(ctx.handle.db, { title: "Einkaufsliste", status: "actionable", createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:00:00.000Z" });
    const briefing = buildReflectionBriefing(ctx.handle.db, { subjectMemberId: mira.id, days: 30, scope: "household", now: new Date("2025-03-01T12:00:00Z") });
    expect(briefing.history.inactiveWork).toContainEqual(expect.objectContaining({ id: task.id, lastMeaningfulProgressAt: null, evidence: "no_recorded_progress" }));
    expect(briefing.history.finiteCompletions).toEqual([]);
  });

  it("validates lookback and provides an empty briefing for an empty household", async () => {
    const mira = member("Mira");
    const empty = buildReflectionBriefing(ctx.handle.db, { subjectMemberId: mira.id, days: 180, scope: "household", now: new Date("2025-03-01T12:00:00Z") });
    expect(empty.current.activeProjects).toEqual([]);
    expect(empty.history.finiteCompletions).toEqual([]);
    const bad = await ctx.app.inject({ method: "GET", url: `/api/reflection/briefing?memberId=${mira.id}&days=45` });
    expect(bad.statusCode).toBe(400);
  });
});
