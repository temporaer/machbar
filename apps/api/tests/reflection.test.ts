import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { ACTIVITY_ACTOR_HEADER } from "@machbar/shared";
import * as schema from "../src/db/schema.js";
import { convertTaskToStory } from "../src/domain/roleConversion.js";
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
    const occurrences = ctx.handle.db.insert(schema.taskRecurrenceOccurrences).values([
      { taskId: routine.id, scheduledDate: "2025-01-07", deadlineDate: "2025-01-08", completedOn: "2025-01-08", completedAt: "2025-01-08T19:00:00.000Z", result: "hit" },
      { taskId: routine.id, scheduledDate: "2025-01-14", deadlineDate: "2025-01-15", completedOn: "2025-01-15", completedAt: "2025-01-15T19:00:00.000Z", result: "miss" },
    ]).returning().all();
    // Historical occurrences remain reportable even when recurrence has since been disabled.
    ctx.handle.db.update(schema.workItems).set({ repeatAfterDays: null }).where(eq(schema.workItems.id, routine.id)).run();
    event({ kind: "task_status_changed", id: done.id, title: done.title, createdAt: "2025-01-09T02:00:00.000Z", metadata: { scope: "household", previousStatus: "actionable", nextStatus: "done" } });
    for (const occurrence of occurrences) event({ kind: "task_status_changed", id: routine.id, title: routine.title, createdAt: occurrence.completedAt, metadata: { scope: "household", previousStatus: "actionable", nextStatus: "done", recurrenceOccurrenceId: occurrence.id, recurrenceResult: occurrence.result } });
    event({ kind: "task_updated", id: next.id, title: next.title, createdAt: "2025-01-10T20:00:00.000Z", metadata: { scope: "household", changedFields: ["scheduledDate"], before: { scheduledDate: "2025-01-15" }, after: { scheduledDate: "2025-01-20" } } });
    event({ kind: "task_updated", id: next.id, title: next.title, createdAt: "2025-01-12T20:00:00.000Z", metadata: { scope: "household", changedFields: ["scheduledDate"], before: { scheduledDate: "2025-01-20" }, after: { scheduledDate: "2025-01-25" } } });
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
    expect(briefing.history.finiteCompletions).toContainEqual(expect.objectContaining({ id: 999, title: "Gelöschte Erledigung", href: null, currentItemAvailable: false }));
    expect(briefing.history.finiteCompletions.some((item) => item.id === reopened.id)).toBe(false);
    expect(briefing.history.activityCounts.administrative).toBeGreaterThan(0);
    expect(briefing.history.postponements).toHaveLength(2);
    expect(briefing.history.postponements[0]).toMatchObject({ id: next.id, from: "2025-01-15", to: "2025-01-20" });
    expect(briefing.markdown).not.toContain("](#/tasks/");
    expect(briefing.markdown).toContain("Das belegt ein erfasstes Ergebnis, nicht das Erreichen eines übergeordneten Ziels.");
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
    expect(briefing.history.inactiveWork).toContainEqual(expect.objectContaining({ id: task.id, lastOutcomeProgressAt: null, classification: "actionable_no_recorded_progress", evidenceLimitations: expect.arrayContaining([expect.stringContaining("belegt nicht")]) }));
    expect(briefing.history.finiteCompletions).toEqual([]);
  });

  it("separates planning activity, outcome evidence, healthy waits and future plans", () => {
    const mira = member("Mira");
    const old = "2024-01-01T00:00:00.000Z";
    const active = insertTestTask(ctx.handle.db, { title: "Unassigned action", status: "actionable", dueDate: "2025-02-01", createdAt: old, updatedAt: old });
    const future = insertTestTask(ctx.handle.db, { title: "Deliberately later", status: "actionable", scheduledDate: "2025-04-01", createdAt: old, updatedAt: old });
    const waiting = insertTestTask(ctx.handle.db, { title: "Awaiting reply", status: "actionable", createdAt: old, updatedAt: old });
    ctx.handle.db.insert(schema.taskExternalWaits).values({ taskId: waiting.id, waitingFor: "Versicherung antwortet" }).run();
    event({ kind: "task_updated", id: active.id, title: active.title, createdAt: "2025-02-10T12:00:00Z", metadata: { scope: "household", changedFields: ["title"], before: { scheduledDate: null }, after: { scheduledDate: null } } });
    event({ kind: "task_updated", id: active.id, title: active.title, createdAt: "2025-02-11T12:00:00Z", metadata: { scope: "household", changedFields: ["reviewedAt"] } });
    event({ kind: "task_dependencies_changed", id: active.id, title: active.title, createdAt: "2025-02-12T12:00:00Z", metadata: { scope: "household", changedFields: ["dependencies"] } });
    const briefing = buildReflectionBriefing(ctx.handle.db, { subjectMemberId: mira.id, days: 30, scope: "household", now: new Date("2025-03-01T12:00:00Z") });
    expect(briefing.history.progress.lastOutcomeProgressAt).toBeNull();
    expect(briefing.history.progress.lastActivityAt).toBe("2025-02-12T12:00:00Z");
    expect(briefing.history.inactiveWork).toContainEqual(expect.objectContaining({ id: active.id, classification: "actionable_no_recorded_progress", lastOutcomeProgressAt: null, lastActivityAt: "2025-02-12T12:00:00Z" }));
    expect(briefing.history.inactiveWork).toContainEqual(expect.objectContaining({ id: waiting.id, classification: "intentional_wait", waitingReason: "Versicherung antwortet" }));
    expect(briefing.history.inactiveWork).toContainEqual(expect.objectContaining({ id: future.id, classification: "future_planned", scheduledDate: "2025-04-01" }));
    expect(briefing.history.inactiveWork.filter((x) => x.classification === "actionable_no_recorded_progress").map((x) => x.id)).toContain(active.id);
    expect(briefing.markdown).toContain("Unassigned action");
    expect(briefing.markdown).toContain("Awaiting reply");
    expect(briefing.markdown).toContain("Deliberately later");
  });

  it("attributes verified child outcomes to their historical project context", () => {
    const mira = member("Mira");
    const project = insertTestProject(ctx.handle.db, { title: "Backup-Konzept", status: "active", scope: "household" });
    const child = insertTestTask(ctx.handle.db, { title: "Restore testen", projectId: project.id, status: "done" });
    event({ kind: "task_status_changed", id: child.id, title: child.title, createdAt: "2025-02-10T12:00:00Z", metadata: { scope: "household", projectContextId: project.id, previousStatus: "actionable", nextStatus: "done" } });
    event({ kind: "project_acceptance_criterion_checked", id: project.id, title: project.title, type: "project", createdAt: "2025-02-11T12:00:00Z", metadata: { scope: "household", checked: true } });
    const briefing = buildReflectionBriefing(ctx.handle.db, { subjectMemberId: mira.id, days: 30, scope: "household", now: new Date("2025-03-01T12:00:00Z") });
    expect(briefing.history.progress.projectsWithRecordedChildOutcomes).toContainEqual(expect.objectContaining({ id: project.id, childId: child.id, childTitle: "Restore testen" }));
    expect(briefing.history.progress.lastOutcomeProgressAt).toBe("2025-02-11T12:00:00Z");
    expect(briefing.history.progress.checkedAcceptanceCriteria).toContainEqual(expect.objectContaining({ projectId: project.id, projectTitle: project.title, date: "2025-02-11" }));
    expect(briefing.history.finiteCompletions.some((x) => x.type === "project" && x.id === project.id)).toBe(false);
  });

  it("fails historical private visibility closed across transfer, scope change, deletion and missing provenance", () => {
    const mira = member("Mira");
    const sam = member("Sam");
    const transferred = insertTestTask(ctx.handle.db, { title: "Transferiertes Privates", scope: "work", ownerMemberId: sam.id, ownerInheritanceMode: "explicit" });
    // At event time Mira owned it; current ownership belongs to Sam.
    event({ kind: "task_status_changed", id: transferred.id, title: transferred.title, createdAt: "2025-02-10T12:00:00Z", metadata: { scope: "work", before: { effectiveOwnerId: mira.id }, after: { effectiveOwnerId: mira.id }, previousStatus: "actionable", nextStatus: "done" } });
    const changedScope = insertTestTask(ctx.handle.db, { title: "Haushalt wurde privat", scope: "work", ownerMemberId: mira.id, ownerInheritanceMode: "explicit" });
    event({ kind: "task_status_changed", id: changedScope.id, title: changedScope.title, createdAt: "2025-02-11T12:00:00Z", metadata: { scope: "household", previousStatus: "actionable", nextStatus: "done" } });
    event({ kind: "task_status_changed", id: null, title: "Gelöschtes Privates", createdAt: "2025-02-12T12:00:00Z", metadata: { scope: "work", affectedWorkItemId: 99991, before: { effectiveOwnerId: mira.id }, after: { effectiveOwnerId: mira.id }, previousStatus: "actionable", nextStatus: "done" } });
    event({ kind: "task_status_changed", id: null, title: "Fehlender Eigentümer", createdAt: "2025-02-13T12:00:00Z", metadata: { scope: "work", affectedWorkItemId: 99992, previousStatus: "actionable", nextStatus: "done" } });
    event({ kind: "task_status_changed", id: null, title: "Explizit nicht mehr zugewiesen", createdAt: "2025-02-14T12:00:00Z", metadata: { scope: "work", affectedWorkItemId: 99993, before: { effectiveOwnerId: mira.id }, after: { effectiveOwnerId: null }, previousStatus: "actionable", nextStatus: "done" } });
    // A currently private item cannot leak its household-era title to another member.
    event({ kind: "task_status_changed", id: changedScope.id, title: "Haushalt wurde privat", createdAt: "2025-02-09T12:00:00Z", metadata: { scope: "household", changedFields: ["scope"], before: { effectiveOwnerId: null }, previousStatus: "actionable", nextStatus: "done" } });
    const forMira = buildReflectionBriefing(ctx.handle.db, { subjectMemberId: mira.id, days: 30, scope: "all", now: new Date("2025-03-01T12:00:00Z") });
    const forSam = buildReflectionBriefing(ctx.handle.db, { subjectMemberId: sam.id, days: 30, scope: "all", now: new Date("2025-03-01T12:00:00Z") });
    expect(JSON.stringify(forMira)).not.toContain("Transferiertes Privates");
    expect(forSam.history.finiteCompletions.some((x) => x.title === "Transferiertes Privates")).toBe(false);
    expect(JSON.stringify(forSam)).not.toContain("Haushalt wurde privat");
    expect(JSON.stringify(forSam)).not.toContain("Gelöschtes Privates");
    expect(JSON.stringify(forSam)).not.toContain("Fehlender Eigentümer");
    expect(JSON.stringify(forMira)).not.toContain("Explizit nicht mehr zugewiesen");
    expect(JSON.stringify(forMira)).toContain("Gelöschtes Privates");
    expect(forMira.history.evidence.incomplete).toBe(true);
  });

  it("keeps the latest completed cycle and does not invent links for role-converted items", () => {
    const mira = member("Mira");
    const item = insertTestTask(ctx.handle.db, { title: "Abgeschlossen und erneut erledigt", status: "done" });
    event({ kind: "task_status_changed", id: item.id, title: item.title, createdAt: "2025-02-01T10:00:00Z", metadata: { scope: "household", previousStatus: "actionable", nextStatus: "done" } });
    event({ kind: "task_status_changed", id: item.id, title: item.title, createdAt: "2025-02-02T10:00:00Z", metadata: { scope: "household", previousStatus: "done", nextStatus: "actionable" } });
    event({ kind: "task_status_changed", id: item.id, title: item.title, createdAt: "2025-02-03T10:00:00Z", metadata: { scope: "household", previousStatus: "actionable", nextStatus: "done" } });
    const briefing = buildReflectionBriefing(ctx.handle.db, { subjectMemberId: mira.id, days: 30, scope: "household", now: new Date("2025-03-01T12:00:00Z") });
    expect(briefing.history.finiteCompletions.filter((x) => x.id === item.id)).toHaveLength(1);
    expect(briefing.history.finiteCompletions.find((x) => x.id === item.id)?.date).toBe("2025-02-03");
  });

  it("does not reuse a task route after the canonical task-to-project conversion", () => {
    const mira = member("Mira");
    const item = insertTestTask(ctx.handle.db, { title: "Historisch erledigter Entwurf", status: "actionable" });
    event({ kind: "task_status_changed", id: item.id, title: item.title, createdAt: "2025-02-01T10:00:00Z", metadata: { scope: "household", previousStatus: "actionable", nextStatus: "done" } });
    convertTaskToStory(ctx.handle.db, item.id, { status: "backlog" });
    const briefing = buildReflectionBriefing(ctx.handle.db, { subjectMemberId: mira.id, days: 30, scope: "household", now: new Date("2025-03-01T12:00:00Z") });
    expect(briefing.history.finiteCompletions).toContainEqual(expect.objectContaining({ id: item.id, type: "task", href: null, currentItemAvailable: false }));
  });

  it("bounds Markdown examples with total and omitted counts while keeping JSON complete", () => {
    const mira = member("Mira");
    for (let index = 0; index < 15; index++) { const task = insertTestTask(ctx.handle.db, { title: `Ergebnis ${String(index).padStart(2, "0")}`, status: "done" }); event({ kind: "task_status_changed", id: task.id, title: task.title, createdAt: `2025-02-${String(1 + index).padStart(2, "0")}T12:00:00Z`, metadata: { scope: "household", previousStatus: "actionable", nextStatus: "done" } }); }
    const briefing = buildReflectionBriefing(ctx.handle.db, { subjectMemberId: mira.id, days: 30, scope: "household", now: new Date("2025-03-01T12:00:00Z") });
    expect(briefing.history.finiteCompletions).toHaveLength(15);
    expect(briefing.markdown).toContain("Aufgezeichnete endliche Ergebnisse (15)");
    expect(briefing.markdown).toContain("3 weitere Einträge ausgelassen.");
    expect(briefing.markdown.indexOf("Ergebnis 00")).toBeLessThan(briefing.markdown.indexOf("Ergebnis 11"));
    expect(briefing.markdown).not.toContain("](#/");
  });

  it("uses household calendar dates across the daylight-saving boundary", () => {
    const mira = member("Mira");
    ctx.handle.db.insert(schema.householdSettings).values({ key: "timezone", value: "Europe/Berlin" }).onConflictDoUpdate({ target: schema.householdSettings.key, set: { value: "Europe/Berlin" } }).run();
    const task = insertTestTask(ctx.handle.db, { title: "Nach der Zeitumstellung", status: "done" });
    event({ kind: "task_status_changed", id: task.id, title: task.title, createdAt: "2025-03-30T22:30:00.000Z", metadata: { scope: "household", previousStatus: "actionable", nextStatus: "done" } });
    const briefing = buildReflectionBriefing(ctx.handle.db, { subjectMemberId: mira.id, days: 30, scope: "household", now: new Date("2025-03-31T22:30:00.000Z") });
    expect(briefing.history.finiteCompletions).toContainEqual(expect.objectContaining({ id: task.id, date: "2025-03-31" }));
    expect(briefing.window.endDate).toBe("2025-04-01");
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
