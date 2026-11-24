import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { ACTIVITY_ACTOR_HEADER } from "@machbar/shared";
import * as schema from "../src/db/schema.js";
import { buildAgenda } from "../src/domain/agenda.js";
import { Graph } from "../src/domain/graph.js";
import { buildReviewItems } from "../src/domain/reviewItems.js";
import { buildWaitingEntries } from "../src/domain/waiting.js";
import { buildWeekAgenda } from "../src/domain/weekAgenda.js";
import { buildReflectionBriefing } from "../src/reflection/briefing.js";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

const today = "2026-09-07";
const now = `${today}T12:00:00.000Z`;
const available = () => ({ status: "available" as const, availableNow: true, missingContexts: [] });

describe("effective deferral read projections", () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = createTestContext(); });
  afterEach(async () => closeTestContext(ctx));

  it("suppresses work and waiting under mixed-role backlog ancestors while preserving deadlines and stored state", () => {
    const db = ctx.handle.db;
    const member = db.insert(schema.members).values({ name: "Reader", color: "#123456" }).returning().get();
    const parked = db.insert(schema.workItems).values({ role: "task", title: "Parked", status: "backlog" }).returning().get();
    const project = db.insert(schema.workItems).values({ role: "story", title: "Nested", status: "active", parentId: parked.id, ownerMemberId: member.id }).returning().get();
    const child = db.insert(schema.workItems).values({ role: "task", title: "Scheduled", status: "active", parentId: project.id, scheduledDate: today }).returning().get();
    const deadline = db.insert(schema.workItems).values({ role: "task", title: "Deadline", status: "active", parentId: project.id, dueDate: today }).returning().get();
    const waiting = db.insert(schema.workItems).values({ role: "task", title: "Waiting", status: "active", parentId: project.id, revisitAt: now }).returning().get();
    db.insert(schema.taskExternalWaits).values({ taskId: waiting.id, waitingFor: "Response" }).run();
    const reconsider = db.insert(schema.workItems).values({ role: "task", title: "Reconsider", status: "active", parentId: project.id, revisitAt: now }).returning().get();
    const clarify = db.insert(schema.workItems).values({ role: "task", title: "Clarify", status: "captured", needsClarification: true, parentId: project.id, revisitAt: now }).returning().get();
    const recurringRevisit = db.insert(schema.workItems).values({ role: "task", title: "Recurring reconsideration", status: "active", parentId: project.id, scheduledDate: today, dueDate: today, repeatAfterDays: 7, allowedDeviationDays: 0, revisitAt: now }).returning().get();
    const independent = db.insert(schema.workItems).values({ role: "task", title: "Independent", status: "active" }).returning().get();
    const before = ctx.handle.sqlite.serialize();
    const graph = Graph.load(db, today, member.id, now);
    expect(graph.tasksById.get(child.id)?.status).toBe("actionable");
    expect(graph.tasksById.get(child.id)?.executable).toBe(false);
    expect(graph.tasksById.get(independent.id)?.executable).toBe(true);
    const agenda = buildAgenda(graph, { today, now });
    expect(agenda.planned.map((t) => t.id)).not.toContain(child.id);
    expect(agenda.dueToday.map((t) => t.id)).toContain(deadline.id);
    expect(agenda.revisit.map((t) => t.id)).toEqual(expect.arrayContaining([waiting.id, reconsider.id, clarify.id]));
    expect(agenda.dueToday.map((t) => t.id)).toContain(recurringRevisit.id);
    expect([...agenda.shared, ...agenda.unscheduled].map((t) => t.id)).toContain(independent.id);
    expect(buildWaitingEntries(graph, { scope: "all", contextAvailability: available }).map((entry) => entry.task.id)).not.toContain(waiting.id);
    const review = buildReviewItems(graph, { today, now });
    expect(review.filter((item) => item.entityId === waiting.id)).toEqual([]);
    expect(review.filter((item) => item.entityId === project.id && item.reason === "no_viable_progress_path")).toEqual([]);
    const week = buildWeekAgenda(graph, { start: today, today });
    expect(week.days.flatMap((day) => day.items).filter((item) => item.id === child.id)).toEqual([]);
    expect(week.days.flatMap((day) => day.items).map((item) => item.id)).toContain(deadline.id);
    expect(week.days[0]!.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: clarify.id, placement: "revisit" }),
      expect.objectContaining({ id: recurringRevisit.id, placement: "revisit" }),
    ]));
    const briefing = buildReflectionBriefing(db, { subjectMemberId: member.id, days: 30, scope: "household", now: new Date(now) });
    expect(briefing.current.waitingItems.map((item) => item.id)).not.toContain(waiting.id);
    expect(briefing.current.executableNextActions.map((item) => item.id)).not.toContain(child.id);
    expect(ctx.handle.sqlite.serialize()).toEqual(before);
  });

  it("computes selected-project readiness hypothetically without admitting independently parked descendants or prerequisites", () => {
    const db = ctx.handle.db;
    const member = db.insert(schema.members).values({ name: "Driver", color: "#123456" }).returning().get();
    const ancestor = db.insert(schema.workItems).values({ role: "story", title: "Parked ancestor", status: "backlog" }).returning().get();
    const project = db.insert(schema.workItems).values({ role: "story", title: "Target", status: "backlog", parentId: ancestor.id, ownerMemberId: member.id }).returning().get();
    const parked = db.insert(schema.workItems).values({ role: "task", title: "Parked child", status: "backlog", parentId: project.id }).returning().get();
    const child = db.insert(schema.workItems).values({ role: "task", title: "Hidden work", status: "active", parentId: parked.id }).returning().get();
    let graph = Graph.load(db, today, member.id, now);
    expect(graph.projectsById.get(project.id)?.activationReadiness.hasViableProgressPath).toBe(false);
    expect(graph.nextActionFor(project.id)).toBeNull();
    db.insert(schema.workItems).values({ role: "task", title: "Available to target", status: "active", parentId: project.id }).run();
    graph = Graph.load(db, today, member.id, now);
    expect(graph.projectsById.get(project.id)?.activationReadiness.hasViableProgressPath).toBe(true);
    expect(graph.tasksById.get(child.id)?.executable).toBe(false);
    expect(graph.nextActionFor(project.id)).toBeNull();
  });

  it("suppresses missing-driver diagnostics while deferred but keeps activation decisions and reached revisits", () => {
    const db = ctx.handle.db;
    const parked = db.insert(schema.workItems).values({ role: "story", title: "Backlog", status: "backlog" }).returning().get();
    const nested = db.insert(schema.workItems).values({ role: "story", title: "Nested", status: "active", parentId: parked.id, revisitAt: now }).returning().get();
    const active = db.insert(schema.workItems).values({ role: "story", title: "Active", status: "active" }).returning().get();
    const before = ctx.handle.sqlite.serialize();
    const graph = Graph.load(db, today, undefined, now);
    const review = buildReviewItems(graph, { today, now });
    expect(review.filter((item) => item.entityId === parked.id)).toEqual([]);
    expect(review.filter((item) => item.entityId === nested.id).map((item) => item.reason)).toEqual(["project_revisit_reached"]);
    expect(review.filter((item) => item.entityId === active.id).map((item) => item.reason)).toContain("missing_driver");
    expect(graph.projectWithComputed(nested.id)?.stuckReason).toBeNull();
    expect(graph.projectWithComputed(parked.id)?.activationReadiness).toMatchObject({
      hasDriver: false, requiredDecisions: expect.arrayContaining(["driver"]),
    });
    expect(ctx.handle.sqlite.serialize()).toEqual(before);
  });

  it("uses hidden ancestors as a gate without returning their identity", () => {
    const db = ctx.handle.db;
    const owner = db.insert(schema.members).values({ name: "Owner", color: "#123456" }).returning().get();
    const viewer = db.insert(schema.members).values({ name: "Viewer", color: "#654321" }).returning().get();
    const hidden = db.insert(schema.workItems).values({ role: "story", title: "Secret ancestor", status: "backlog", scope: "work", ownerMemberId: owner.id }).returning().get();
    const child = db.insert(schema.workItems).values({ role: "task", title: "Visible child", status: "active", parentId: hidden.id, scope: "work", ownerMemberId: viewer.id, ownerInheritanceMode: "explicit" }).returning().get();
    const graph = Graph.load(db, today, viewer.id, now);
    expect(graph.projectsById.get(hidden.id)).toBeUndefined();
    expect(graph.tasksById.get(child.id)?.executable).toBe(false);
    expect(JSON.stringify(graph.tasksById.get(child.id))).not.toContain("Secret ancestor");
  });

  it("does not reveal a hidden ancestor's status through viewer projections", () => {
    const db = ctx.handle.db;
    const owner = db.insert(schema.members).values({ name: "Owner", color: "#123456" }).returning().get();
    const other = db.insert(schema.members).values({ name: "Other", color: "#654321" }).returning().get();
    const ancestor = db.insert(schema.workItems).values({ role: "story", title: "Hidden", status: "backlog", scope: "work", ownerMemberId: owner.id }).returning().get();
    const child = db.insert(schema.workItems).values({ role: "task", title: "Visible", status: "active", parentId: ancestor.id, scope: "household", dueDate: today }).returning().get();
    const read = (viewer: number | undefined) => {
      const graph = Graph.load(db, today, viewer, now);
      return {
        child: graph.tasksById.get(child.id),
        agenda: buildAgenda(graph, { today, now }),
        waiting: buildWaitingEntries(graph, { scope: "all", contextAvailability: available }),
        review: buildReviewItems(graph, { today, now }),
        week: buildWeekAgenda(graph, { start: today, today }),
      };
    };
    const ownerDeferred = read(owner.id);
    const otherDeferred = read(other.id);
    const unknownDeferred = read(undefined);
    expect(otherDeferred.agenda.dueToday[0]?.effectivelyDeferred).toBeNull();
    expect(ownerDeferred.child?.executable).toBe(false);
    db.update(schema.workItems).set({ status: "active" }).where(eq(schema.workItems.id, ancestor.id)).run();
    expect(read(other.id)).toEqual(otherDeferred);
    expect(read(undefined)).toEqual(unknownDeferred);
    expect(read(owner.id).child?.executable).toBe(true);
    expect(ownerDeferred.child?.executable).toBe(false);
  });

  it("serializes the same visible detail and attention for hidden active and parked ancestors", async () => {
    const db = ctx.handle.db;
    const owner = db.insert(schema.members).values({ name: "Owner", color: "#123456" }).returning().get();
    const other = db.insert(schema.members).values({ name: "Other", color: "#654321" }).returning().get();
    const ancestor = db.insert(schema.workItems).values({ role: "story", title: "Hidden", status: "backlog", scope: "work", ownerMemberId: owner.id }).returning().get();
    const child = db.insert(schema.workItems).values({ role: "task", title: "Visible", status: "active", parentId: ancestor.id, scope: "household", dueDate: today }).returning().get();
    const project = db.insert(schema.workItems).values({ role: "story", title: "Visible project", status: "active", parentId: ancestor.id, scope: "household", revisitAt: "2000-01-01T12:00:00.000Z" }).returning().get();
    const capture = db.insert(schema.workItems).values({ role: "task", title: "Visible capture", status: "captured", needsClarification: true, parentId: project.id, scope: "household", dueDate: today }).returning().get();
    const urls = [`/api/tasks/${child.id}`, `/api/agenda/today?scope=all&date=${today}`, `/api/agenda/week?start=${today}&today=${today}`, "/api/waiting?scope=all", "/api/review"];
    const read = async (viewer?: number) => Promise.all(urls.map(async (url) => {
      const response = await ctx.app.inject({ method: "GET", url, headers: viewer === undefined ? {} : { [ACTIVITY_ACTOR_HEADER]: String(viewer) } });
      expect(response.statusCode).toBe(200);
      return response.json();
    }));
    const otherDeferred = await read(other.id);
    const unknownDeferred = await read();
    expect(otherDeferred[1].dueToday.map((task: { id: number }) => task.id)).toContain(capture.id);
    expect(otherDeferred[2].days[0].items.map((item: { id: number }) => item.id)).toContain(project.id);
    expect(otherDeferred[4]).toContainEqual(expect.objectContaining({ entityId: project.id, reason: "project_revisit_reached" }));
    db.update(schema.workItems).set({ status: "active" }).where(eq(schema.workItems.id, ancestor.id)).run();
    expect(await read(other.id)).toEqual(otherDeferred);
    expect(await read()).toEqual(unknownDeferred);
    db.update(schema.workItems).set({ status: "backlog" }).where(eq(schema.workItems.id, ancestor.id)).run();
    db.update(schema.workItems).set({ reviewedAt: "2000-01-01T12:00:00.000Z" }).where(eq(schema.workItems.id, project.id)).run();
    const otherAcknowledged = await read(other.id);
    const unknownAcknowledged = await read();
    expect(otherAcknowledged[2].days.flatMap((day: { items: { id: number }[] }) => day.items).map((item: { id: number }) => item.id)).not.toContain(project.id);
    expect(otherAcknowledged[4].filter((item: { entityId: number; reason: string }) => item.entityId === project.id && item.reason === "project_revisit_reached")).toEqual([]);
    db.update(schema.workItems).set({ status: "active" }).where(eq(schema.workItems.id, ancestor.id)).run();
    expect(await read(other.id)).toEqual(otherAcknowledged);
    expect(await read()).toEqual(unknownAcknowledged);
  });

  it("keeps actual deadlines and reconsideration, but not past one-off plans", () => {
    const db = ctx.handle.db;
    const parkedProject = db.insert(schema.workItems).values({ role: "story", title: "Parked due", status: "backlog", dueDate: today, revisitAt: now }).returning().get();
    const parkedTask = db.insert(schema.workItems).values({ role: "task", title: "Parked task due", status: "backlog", dueDate: today }).returning().get();
    const recurring = db.insert(schema.workItems).values({ role: "task", title: "Parked recurring", status: "backlog", scheduledDate: today, dueDate: today, repeatAfterDays: 7, allowedDeviationDays: 0 }).returning().get();
    const past = db.insert(schema.workItems).values({ role: "task", title: "Past plan", status: "active", scheduledDate: "2026-09-06" }).returning().get();
    const future = db.insert(schema.workItems).values({ role: "task", title: "Future plan", status: "active", scheduledDate: "2026-09-08" }).returning().get();
    db.update(schema.workItems).set({ status: "backlog" }).where(eq(schema.workItems.id, past.id)).run();
    expect(buildAgenda(Graph.load(db, today, undefined, now), { today, now }).planned.map((task) => task.id)).not.toContain(past.id);
    db.update(schema.workItems).set({ status: "active" }).where(eq(schema.workItems.id, past.id)).run();
    const graph = Graph.load(db, today, undefined, now);
    expect(graph.tasksById.get(past.id)?.scheduledDate).toBe("2026-09-06");
    const agenda = buildAgenda(graph, { today, now });
    expect(agenda.projects.map((entry) => entry.project.id)).toContain(parkedProject.id);
    expect(agenda.projects.find((entry) => entry.project.id === parkedProject.id)?.project.effectivelyDeferred).toBe(true);
    expect(agenda.dueToday.map((task) => task.id)).toContain(parkedTask.id);
    expect(agenda.dueToday.find((task) => task.id === parkedTask.id)?.effectivelyDeferred).toBe(true);
    expect(agenda.dueToday.map((task) => task.id)).toContain(recurring.id);
    expect(agenda.planned.map((task) => task.id)).not.toContain(past.id);
    expect(agenda.shared.map((task) => task.id)).toContain(past.id);
    expect([...agenda.planned, ...agenda.shared].map((task) => task.id)).not.toContain(future.id);
    expect(buildReviewItems(graph, { today, now }).map((item) => item.reason)).toContain("backlog_revisit_reached");
    const week = buildWeekAgenda(graph, { start: today, today });
    expect(week.days[0]!.items).toContainEqual(expect.objectContaining({ id: recurring.id, placement: "due", executable: false }));
    expect(week.days[0]!.items.map((item) => item.id)).not.toContain(past.id);
    expect(week.unplanned.map((item) => item.id)).toContain(past.id);
    expect(week.days[1]!.items.map((item) => item.id)).toContain(future.id);
  });

  it("retains recurring deadlines under direct and inherited deferral without exposing execution", () => {
    const db = ctx.handle.db;
    const parent = db.insert(schema.workItems).values({ role: "story", title: "Parked", status: "backlog" }).returning().get();
    const cases = [
      { title: "Direct overdue", status: "backlog" as const, dueDate: "2026-09-06", bucket: "overdue" as const },
      { title: "Inherited today", status: "active" as const, parentId: parent.id, dueDate: today, bucket: "dueToday" as const },
      { title: "Inherited soon", status: "active" as const, parentId: parent.id, dueDate: "2026-09-08", bucket: "dueSoon" as const },
      { title: "Captured recurring", status: "captured" as const, needsClarification: true, parentId: parent.id, dueDate: "2026-09-09", bucket: "dueSoon" as const },
    ].map(({ bucket, ...values }) => ({
      bucket,
      dueDate: values.dueDate,
      row: db.insert(schema.workItems).values({ role: "task", ...values, scheduledDate: "2026-09-10", repeatAfterDays: 7, allowedDeviationDays: 0 }).returning().get(),
    }));
    const before = ctx.handle.sqlite.serialize();
    const graph = Graph.load(db, today, undefined, now);
    const agenda = buildAgenda(graph, { today, now });
    const week = buildWeekAgenda(graph, { start: today, today });
    const weekItems = week.days.flatMap(day => day.items);
    for (const { row, bucket, dueDate } of cases) {
      expect(agenda[bucket].filter(task => task.id === row.id)).toEqual([
        expect.objectContaining({ id: row.id, dueDate: row.dueDate, executable: false, effectivelyDeferred: true }),
      ]);
      expect([...agenda.planned, ...agenda.revisit, ...agenda.shared, ...agenda.unscheduled].map(task => task.id)).not.toContain(row.id);
      expect(weekItems.filter(item => item.id === row.id)).toEqual([
        expect.objectContaining({ id: row.id, placement: "due", attentionDate: dueDate < today ? today : dueDate, executable: false }),
      ]);
      expect(week.unplanned.map(item => item.id)).not.toContain(row.id);
    }
    expect(ctx.handle.sqlite.serialize()).toEqual(before);
  });

  it("preserves baseline nondeferred revisit eligibility while retaining deferred reconsideration", () => {
    const db = ctx.handle.db;
    const parked = db.insert(schema.workItems).values({ role: "story", title: "Parked", status: "backlog" }).returning().get();
    const activeProject = db.insert(schema.workItems).values({ role: "story", title: "Active", status: "active" }).returning().get();
    const captured = db.insert(schema.workItems).values({ role: "task", title: "Captured", status: "captured", revisitAt: now }).returning().get();
    const clarification = db.insert(schema.workItems).values({ role: "task", title: "Needs clarification", status: "active", needsClarification: true, parentId: activeProject.id, revisitAt: now }).returning().get();
    const ordinary = db.insert(schema.workItems).values({ role: "task", title: "Ordinary", status: "active", revisitAt: now }).returning().get();
    const future = db.insert(schema.workItems).values({ role: "task", title: "Future plan", status: "active", revisitAt: now, scheduledDate: "2026-09-08" }).returning().get();
    const wait = db.insert(schema.workItems).values({ role: "task", title: "Wait", status: "active", needsClarification: true, revisitAt: now, scheduledDate: "2026-09-08" }).returning().get();
    db.insert(schema.taskExternalWaits).values({ taskId: wait.id, waitingFor: "Response" }).run();
    const deferredCaptured = db.insert(schema.workItems).values({ role: "task", title: "Deferred captured", status: "captured", needsClarification: true, parentId: parked.id, revisitAt: now, scheduledDate: "2026-09-08" }).returning().get();
    const unavailableWindow = { kind: "weekly" as const, match: "inside" as const, windows: [{ weekdays: [1], start: "00:00", end: "01:00" }] };
    const deferredActive = db.insert(schema.workItems).values({ role: "task", title: "Deferred active", status: "active", needsClarification: true, parentId: parked.id, revisitAt: now, scheduledDate: "2026-09-08", availabilityRule: unavailableWindow }).returning().get();
    const deferredWait = db.insert(schema.workItems).values({ role: "task", title: "Deferred wait", status: "active", parentId: parked.id, revisitAt: now, scheduledDate: "2026-09-08" }).returning().get();
    db.insert(schema.taskExternalWaits).values({ taskId: deferredWait.id, waitingFor: "Response" }).run();
    const window = db.insert(schema.workItems).values({ role: "task", title: "Unavailable", status: "active", revisitAt: now, availabilityRule: unavailableWindow }).returning().get();
    const capturedDue = db.insert(schema.workItems).values({ role: "task", title: "Captured with deadline", status: "captured", dueDate: "2026-09-08", revisitAt: now }).returning().get();
    const graph = Graph.load(db, today, undefined, now);
    const agenda = buildAgenda(graph, { today, now });
    const revisitIds = agenda.revisit.map(task => task.id);
    expect(revisitIds).toEqual(expect.arrayContaining([ordinary.id, wait.id, deferredCaptured.id, deferredActive.id, deferredWait.id]));
    for (const id of [captured.id, capturedDue.id, clarification.id, future.id, window.id]) {
      expect(revisitIds).not.toContain(id);
    }
    const week = buildWeekAgenda(graph, { start: today, today });
    const weekItems = week.days.flatMap(day => day.items);
    expect(weekItems.map(item => item.id)).not.toContain(captured.id);
    expect(weekItems.map(item => item.id)).not.toContain(clarification.id);
    expect(weekItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: deferredCaptured.id, placement: "revisit", executable: false }),
      expect.objectContaining({ id: deferredActive.id, placement: "revisit", executable: false }),
      expect.objectContaining({ id: deferredWait.id, placement: "revisit", executable: false }),
      expect.objectContaining({ id: wait.id, placement: "revisit" }),
      expect.objectContaining({ id: capturedDue.id, placement: "due", attentionDate: "2026-09-08" }),
    ]));
  });

  it("does not count a parked dependency as healthy target readiness", () => {
    const db = ctx.handle.db;
    const member = db.insert(schema.members).values({ name: "Driver", color: "#123456" }).returning().get();
    const project = db.insert(schema.workItems).values({ role: "story", title: "Target", status: "backlog", ownerMemberId: member.id }).returning().get();
    const task = db.insert(schema.workItems).values({ role: "task", title: "Dependent", status: "active", parentId: project.id }).returning().get();
    const parked = db.insert(schema.workItems).values({ role: "task", title: "Parked prerequisite", status: "backlog" }).returning().get();
    db.insert(schema.taskDependencies).values({ taskId: task.id, dependsOnTaskId: parked.id }).run();
    const graph = Graph.load(db, today, member.id, now);
    expect(graph.projectsById.get(project.id)?.activationReadiness).toMatchObject({
      hasViableProgressPath: false, hasHealthyFutureWaiting: false, ready: false,
    });
  });

  it("retains terminal-project rules rather than treating an archived backlog row as parked", () => {
    const db = ctx.handle.db;
    const project = db.insert(schema.workItems).values({ role: "story", title: "Archived", status: "backlog", archivedAt: now, dueDate: today }).returning().get();
    const task = db.insert(schema.workItems).values({ role: "task", title: "Open under archived", status: "active", parentId: project.id, dueDate: today }).returning().get();
    const graph = Graph.load(db, today, undefined, now);
    expect(graph.effectiveDeferralFor(project.id)).toBe(false);
    const agenda = buildAgenda(graph, { today, now });
    expect(agenda.projects.map((entry) => entry.project.id)).not.toContain(project.id);
    expect(agenda.dueToday.map((item) => item.id)).not.toContain(task.id);
    expect(buildReviewItems(graph, { today, now })).toContainEqual(expect.objectContaining({ entityId: project.id, reason: "completed_project_open_work" }));
  });

  it("projects an arbitrarily deep mixed-role lineage without rewriting descendants", () => {
    const db = ctx.handle.db;
    const root = db.insert(schema.workItems).values({ role: "story", title: "Root", status: "backlog" }).returning().get();
    let parentId = root.id;
    for (let index = 0; index < 180; index++) {
      parentId = db.insert(schema.workItems).values({ role: index % 2 ? "story" : "task", title: `Level ${index}`, status: "active", parentId }).returning().get().id;
    }
    const leaf = db.insert(schema.workItems).values({ role: "task", title: "Leaf", status: "active", parentId }).returning().get();
    const graph = Graph.load(db, today, undefined, now);
    expect(graph.tasksById.get(leaf.id)).toMatchObject({ status: "actionable", executable: false });
    expect(graph.effectiveDeferralFor(leaf.id)).toBe(true);
  });

  it("surfaces captured real deadlines without treating the work as executable", () => {
    const db = ctx.handle.db;
    const parent = db.insert(schema.workItems).values({ role: "story", title: "Backlog", status: "backlog" }).returning().get();
    const standalone = db.insert(schema.workItems).values({ role: "task", title: "Captured standalone", status: "captured", needsClarification: true, dueDate: today }).returning().get();
    const nested = db.insert(schema.workItems).values({ role: "task", title: "Captured nested", status: "captured", needsClarification: true, parentId: parent.id, dueDate: today }).returning().get();
    const cancelled = db.insert(schema.workItems).values({ role: "task", title: "Cancelled", status: "cancelled", dueDate: today }).returning().get();
    const archived = db.insert(schema.workItems).values({ role: "story", title: "Archived", status: "backlog", archivedAt: now }).returning().get();
    const terminalChild = db.insert(schema.workItems).values({ role: "task", title: "Archived child", status: "captured", needsClarification: true, parentId: archived.id, dueDate: today }).returning().get();
    const before = ctx.handle.sqlite.serialize();
    const graph = Graph.load(db, today, undefined, now);
    const agenda = buildAgenda(graph, { today, now });
    expect(agenda.dueToday.map((task) => task.id)).toEqual(expect.arrayContaining([standalone.id, nested.id]));
    expect(agenda.dueToday.map((task) => task.id)).not.toContain(cancelled.id);
    expect(agenda.dueToday.map((task) => task.id)).not.toContain(terminalChild.id);
    expect(agenda.dueToday.find((task) => task.id === nested.id)).toMatchObject({ status: "captured", executable: false, effectivelyDeferred: true });
    const week = buildWeekAgenda(graph, { start: today, today });
    const weekIds = week.days[0]!.items.map((item) => item.id);
    expect(weekIds).toEqual(expect.arrayContaining([standalone.id, nested.id]));
    expect(weekIds).not.toContain(terminalChild.id);
    expect(ctx.handle.sqlite.serialize()).toEqual(before);
  });

  it("returns a newly captured deadline through the real Today and Week routes", async () => {
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { title: "Captured with deadline", status: "captured", dueDate: today },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().status).toBe("captured");
    const id = created.json().id;
    const before = ctx.handle.sqlite.serialize();
    const agenda = await ctx.app.inject({ method: "GET", url: `/api/agenda/today?scope=all&date=${today}` });
    const week = await ctx.app.inject({ method: "GET", url: `/api/agenda/week?start=${today}&today=${today}&scope=all` });
    expect(agenda.statusCode).toBe(200);
    expect(week.statusCode).toBe(200);
    expect(agenda.json().dueToday).toContainEqual(expect.objectContaining({ id, status: "captured", executable: false }));
    expect(week.json().days[0].items).toContainEqual(expect.objectContaining({ id, placement: "due", executable: false }));
    expect(ctx.handle.sqlite.serialize()).toEqual(before);
  });

  it("preserves child-project revisit attention under parked ancestry without execution diagnostics", () => {
    const db = ctx.handle.db;
    const parent = db.insert(schema.workItems).values({ role: "task", title: "Parked", status: "backlog" }).returning().get();
    const reached = db.insert(schema.workItems).values({ role: "story", title: "Reached child", status: "active", parentId: parent.id, revisitAt: now }).returning().get();
    const future = db.insert(schema.workItems).values({ role: "story", title: "Future child", status: "active", parentId: parent.id, revisitAt: "2026-09-08T12:00:00.000Z" }).returning().get();
    const terminal = db.insert(schema.workItems).values({ role: "story", title: "Archived child", status: "backlog", parentId: parent.id, archivedAt: now, revisitAt: now }).returning().get();
    const before = ctx.handle.sqlite.serialize();
    const graph = Graph.load(db, today, undefined, now);
    const week = buildWeekAgenda(graph, { start: today, today });
    expect(week.days[0]!.items).toContainEqual(expect.objectContaining({ id: reached.id, placement: "revisit" }));
    expect(week.days[1]!.items).toContainEqual(expect.objectContaining({ id: future.id, placement: "revisit" }));
    expect(week.days.flatMap((day) => day.items).map((item) => item.id)).not.toContain(terminal.id);
    const review = buildReviewItems(graph, { today, now });
    expect(review).toContainEqual(expect.objectContaining({ entityId: reached.id, category: "reconsider", reason: "project_revisit_reached", suggestedAction: { code: "review_project" } }));
    expect(review.filter((item) => item.entityId === future.id)).toEqual([]);
    expect(review.filter((item) => item.entityId === reached.id && item.category === "clarification_repair")).toEqual([]);
    expect(ctx.handle.sqlite.serialize()).toEqual(before);
  });

  it("acknowledges a reached child-project revisit without changing lifecycle and resurfaces a later revisit", async () => {
    vi.setSystemTime(new Date(now));
    try {
      const db = ctx.handle.db;
      const owner = db.insert(schema.members).values({ name: "Driver", color: "#123456" }).returning().get();
      const parent = db.insert(schema.workItems).values({ role: "task", title: "Parked", status: "backlog" }).returning().get();
      const project = db.insert(schema.workItems).values({ role: "story", title: "Child", status: "active", ownerMemberId: owner.id, parentId: parent.id, revisitAt: now }).returning().get();
      db.insert(schema.workItems).values({ role: "task", title: "Progress", status: "active", parentId: project.id }).run();
      const readReview = async () => {
        const response = await ctx.app.inject({ method: "GET", url: "/api/review" });
        expect(response.statusCode).toBe(200);
        return response.json().filter((item: { entityId: number; reason: string }) =>
          item.entityId === project.id && item.reason === "project_revisit_reached");
      };
      const readWeek = async () => {
        const response = await ctx.app.inject({ method: "GET", url: `/api/agenda/week?start=${today}&today=${today}&scope=all` });
        expect(response.statusCode).toBe(200);
        return response.json().days.flatMap((day: { items: { id: number }[] }) => day.items)
          .filter((item: { id: number }) => item.id === project.id);
      };
      expect(await readReview()).toHaveLength(1);
      expect(await readWeek()).toContainEqual(expect.objectContaining({ placement: "revisit" }));
      const stale = await ctx.app.inject({ method: "POST", url: `/api/projects/${project.id}/review`, payload: { expectedRevision: project.revision + 1 } });
      expect(stale.statusCode).toBe(409);
      expect(await readReview()).toHaveLength(1);
      expect(await readWeek()).toContainEqual(expect.objectContaining({ placement: "revisit" }));
      const acknowledged = await ctx.app.inject({ method: "POST", url: `/api/projects/${project.id}/review`, payload: { expectedRevision: project.revision } });
      expect(acknowledged.statusCode).toBe(200);
      expect(acknowledged.json()).toMatchObject({ status: "active", revisitAt: now, reviewedAt: now });
      expect(await readReview()).toEqual([]);
      expect(await readWeek()).toEqual([]);
      expect(db.select().from(schema.workItems).where(eq(schema.workItems.id, parent.id)).get()?.status).toBe("backlog");

      const later = "2026-09-08T12:00:00.000Z";
      const beforeRejectedPatch = ctx.handle.sqlite.serialize();
      const updated = await ctx.app.inject({ method: "PATCH", url: `/api/projects/${project.id}`, payload: { expectedRevision: acknowledged.json().revision, revisitAt: later } });
      expect(updated.statusCode).toBe(409);
      expect(updated.json()).toMatchObject({ error: { code: "project_transition_invalid" } });
      expect(ctx.handle.sqlite.serialize()).toEqual(beforeRejectedPatch);

      // Model a newer persisted legacy revisit; active projects cannot set one by PATCH.
      db.update(schema.workItems).set({ revisitAt: later }).where(eq(schema.workItems.id, project.id)).run();
      expect(await readReview()).toEqual([]);
      expect(await readWeek()).toContainEqual(expect.objectContaining({ placement: "revisit", attentionDate: "2026-09-08" }));
      vi.setSystemTime(new Date(later));
      expect(await readReview()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses instant ordering for acknowledged project revisits and retains deadline placement", () => {
    const db = ctx.handle.db;
    const parent = db.insert(schema.workItems).values({ role: "story", title: "Parked", status: "backlog" }).returning().get();
    const cases = [
      { title: "Unreviewed", reviewedAt: null, placement: "revisit" },
      { title: "Older review", reviewedAt: "2026-09-07T11:59:59.000Z", placement: "revisit" },
      { title: "Same instant", reviewedAt: "2026-09-07T14:00:00.000+02:00", placement: null },
      { title: "Later review", reviewedAt: "2026-09-07T12:01:00.000Z", placement: null },
      { title: "Deadline", reviewedAt: now, dueDate: "2026-09-08", placement: "due" },
    ] as const;
    const projects = cases.map(({ title, reviewedAt, ...rest }) => ({
      ...rest,
      id: db.insert(schema.workItems).values({ role: "story", title, status: "active", parentId: parent.id, revisitAt: now, reviewedAt, dueDate: "dueDate" in rest ? rest.dueDate : null }).returning().get().id,
    }));
    const before = ctx.handle.sqlite.serialize();
    const week = buildWeekAgenda(Graph.load(db, today, undefined, now), { start: today, today });
    const items = week.days.flatMap((day) => day.items);
    for (const project of projects) {
      const matches = items.filter((item) => item.id === project.id);
      if (project.placement === null) expect(matches).toEqual([]);
      else expect(matches).toContainEqual(expect.objectContaining({ placement: project.placement }));
    }
    expect(ctx.handle.sqlite.serialize()).toEqual(before);
  });

  it("does not reveal hidden ancestor status through captured deadlines or project reconsideration", () => {
    const db = ctx.handle.db;
    const owner = db.insert(schema.members).values({ name: "Owner", color: "#123456" }).returning().get();
    const other = db.insert(schema.members).values({ name: "Other", color: "#654321" }).returning().get();
    const hidden = db.insert(schema.workItems).values({ role: "story", title: "Hidden", status: "backlog", scope: "work", ownerMemberId: owner.id }).returning().get();
    const project = db.insert(schema.workItems).values({ role: "story", title: "Visible project", status: "active", parentId: hidden.id, scope: "household", revisitAt: now }).returning().get();
    const captured = db.insert(schema.workItems).values({ role: "task", title: "Visible capture", status: "captured", needsClarification: true, parentId: project.id, scope: "household", dueDate: today }).returning().get();
    const read = (viewer?: number) => {
      const graph = Graph.load(db, today, viewer, now);
      return {
        agenda: buildAgenda(graph, { today, now }),
        week: buildWeekAgenda(graph, { start: today, today }),
        review: buildReviewItems(graph, { today, now }),
      };
    };
    const otherParked = read(other.id);
    const unknownParked = read();
    expect(otherParked.agenda.dueToday).toContainEqual(expect.objectContaining({ id: captured.id, effectivelyDeferred: null }));
    expect(otherParked.week.days[0]!.items.map((item) => item.id)).toContain(project.id);
    expect(otherParked.review).toContainEqual(expect.objectContaining({ entityId: project.id, reason: "project_revisit_reached" }));
    db.update(schema.workItems).set({ status: "active" }).where(eq(schema.workItems.id, hidden.id)).run();
    expect(read(other.id)).toEqual(otherParked);
    expect(read()).toEqual(unknownParked);
    db.update(schema.workItems).set({ status: "backlog" }).where(eq(schema.workItems.id, hidden.id)).run();
    db.update(schema.workItems).set({ reviewedAt: now }).where(eq(schema.workItems.id, project.id)).run();
    const otherAcknowledged = read(other.id);
    const unknownAcknowledged = read();
    expect(otherAcknowledged.week.days.flatMap((day) => day.items).map((item) => item.id)).not.toContain(project.id);
    expect(otherAcknowledged.review.filter((item) => item.entityId === project.id && item.reason === "project_revisit_reached")).toEqual([]);
    db.update(schema.workItems).set({ status: "active" }).where(eq(schema.workItems.id, hidden.id)).run();
    expect(read(other.id)).toEqual(otherAcknowledged);
    expect(read()).toEqual(unknownAcknowledged);
  });

  it("exposes canonical nullable deferral in viewer-scoped project and task inventory reads", async () => {
    const db = ctx.handle.db;
    const owner = db.insert(schema.members).values({ name: "Owner", color: "#123456" }).returning().get();
    const viewer = db.insert(schema.members).values({ name: "Viewer", color: "#654321" }).returning().get();
    const hidden = db.insert(schema.workItems).values({
      role: "story",
      title: "Hidden ancestor",
      status: "backlog",
      scope: "work",
      ownerMemberId: owner.id,
    }).returning().get();
    const project = db.insert(schema.workItems).values({
      role: "story",
      title: "Visible descendant project",
      status: "active",
      parentId: hidden.id,
      scope: "household",
    }).returning().get();
    const task = db.insert(schema.workItems).values({
      role: "task",
      title: "Visible descendant task",
      status: "active",
      parentId: project.id,
      scope: "household",
    }).returning().get();

    const read = async (memberId?: number) => {
      const headers = memberId === undefined
        ? {}
        : { [ACTIVITY_ACTOR_HEADER]: String(memberId) };
      const [projects, tasks] = await Promise.all([
        ctx.app.inject({ method: "GET", url: "/api/projects", headers }),
        ctx.app.inject({ method: "GET", url: "/api/search?includeTerminal=true", headers }),
      ]);
      expect(projects.statusCode).toBe(200);
      expect(tasks.statusCode).toBe(200);
      return {
        projects: projects.json() as Array<{ id: number; title: string; effectivelyDeferred?: boolean | null }>,
        tasks: tasks.json() as Array<{ id: number; title: string; effectivelyDeferred?: boolean | null }>,
      };
    };

    const visibleToOther = await read(viewer.id);
    expect(visibleToOther.projects.find((item) => item.id === project.id))
      .toMatchObject({ title: "Visible descendant project", effectivelyDeferred: null });
    expect(visibleToOther.tasks.find((item) => item.id === task.id))
      .toMatchObject({ title: "Visible descendant task", effectivelyDeferred: null });
    expect(JSON.stringify(visibleToOther)).not.toContain("Hidden ancestor");

    const visibleToOwner = await read(owner.id);
    expect(visibleToOwner.projects.find((item) => item.id === project.id))
      .toMatchObject({ effectivelyDeferred: true });
    expect(visibleToOwner.tasks.find((item) => item.id === task.id))
      .toMatchObject({ effectivelyDeferred: true });
  });
});
