import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AvailabilityRule, Task } from "@machbar/shared";
import { isTaskAvailableInWindow } from "../src/domain/taskAvailability.js";
import { buildAgenda } from "../src/domain/agenda.js";
import { buildWeekAgenda } from "../src/domain/weekAgenda.js";
import { Graph } from "../src/domain/graph.js";
import * as schema from "../src/db/schema.js";
import { closeTestContext, createTestContext, insertTestProject, insertTestTask, type TestContext } from "./helpers.js";

const inside: AvailabilityRule = {
  kind: "weekly", match: "inside",
  windows: [{ weekdays: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" }],
};
const outside: AvailabilityRule = { ...inside, match: "outside" };

// The server clock is UTC; evaluation must use household wall-clock time.
describe("weekly execution windows", () => {
  it.each([
    ["2026-01-12T07:59:00Z", false], ["2026-01-12T08:00:00Z", true],
    ["2026-01-12T15:59:59Z", true], ["2026-01-12T16:00:00Z", false],
    ["2026-07-13T06:59:00Z", false], ["2026-07-13T07:00:00Z", true],
    ["2026-07-13T14:59:59Z", true], ["2026-07-13T15:00:00Z", false],
    ["2026-07-17T18:00:00Z", false], ["2026-07-18T10:00:00Z", false],
    ["2026-07-19T10:00:00Z", false],
  ])("inside/outside are complementary at %s", (now, available) => {
    expect(isTaskAvailableInWindow(inside, now, "Europe/Berlin")).toBe(available);
    expect(isTaskAvailableInWindow(outside, now, "Europe/Berlin")).toBe(!available);
    expect(isTaskAvailableInWindow(null, now, "Europe/Berlin")).toBe(true);
  });
  it("uses the supplied household timezone rather than a fixed offset", () => {
    expect(isTaskAvailableInWindow(inside, "2026-07-13T07:00:00Z", "America/New_York")).toBe(false);
    expect(isTaskAvailableInWindow(inside, "2026-07-13T13:00:00Z", "America/New_York")).toBe(true);
  });
});

describe("availability persistence and Today compilation", () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = createTestContext(); });
  afterEach(async () => { await closeTestContext(ctx); });
  const today = "2026-07-13";
  const now = "2026-07-13T16:00:00Z";
  const compile = (instant = now) => buildAgenda(Graph.load(ctx.handle.db, instant), {
    now: instant, today, householdTimezone: "Europe/Berlin",
  });
  const rowIds = (agenda: ReturnType<typeof compile>) =>
    [agenda.planned, agenda.overdue, agenda.dueToday, agenda.dueSoon, agenda.revisit, agenda.shared, agenda.unscheduled].flat().map(t => t.id);
  async function create(payload: Record<string, unknown>): Promise<Task> {
    const response = await ctx.app.inject({ method: "POST", url: "/api/tasks", payload });
    expect(response.statusCode).toBe(201);
    return response.json();
  }
  async function patch(task: Task, payload: Record<string, unknown>): Promise<Task> {
    const response = await ctx.app.inject({ method: "PATCH", url: `/api/tasks/${task.id}`, payload: { ...payload, expectedRevision: task.revision } });
    expect(response.statusCode).toBe(200);
    return response.json();
  }

  it("persists both modes, preserves omitted values, clears null, and retains revision checks", async () => {
    const defaults = await create({ title: "Default" });
    expect(defaults.availabilityRule).toBeNull();
    let task = await create({ title: "Call", status: "actionable", availabilityRule: inside, scheduledDate: today, dueDate: "2026-07-14" });
    expect(task.availabilityRule).toEqual(inside);
    task = await patch(task, { notes: "Keep window" });
    expect(task.availabilityRule).toEqual(inside);
    task = await patch(task, { availabilityRule: outside });
    expect(task).toMatchObject({ availabilityRule: outside, scheduledDate: today, dueDate: "2026-07-14", status: "actionable" });
    const stale = await ctx.app.inject({ method: "PATCH", url: `/api/tasks/${task.id}`, payload: { availabilityRule: null, expectedRevision: task.revision - 1 } });
    expect(stale.statusCode).toBe(409);
    task = await patch(task, { availabilityRule: null });
    const read = await ctx.app.inject({ method: "GET", url: `/api/tasks/${task.id}` });
    expect(read.json()).toMatchObject({ availabilityRule: null, scheduledDate: today, dueDate: "2026-07-14" });
  });

  it("does not activate captured/backlog work or rewrite revisit, waits or reminders", async () => {
    for (const status of ["captured", "someday"]) {
      let task = await create({ title: status, status });
      task = await patch(task, { availabilityRule: inside });
      expect(task.status).toBe(status);
    }
    let task = await create({ title: "Waiting", status: "actionable", revisitAt: "2026-07-13T06:00:00Z", reminders: [{ kind: "absolute", at: "2026-07-14T06:00:00Z" }] });
    task = await patch(task, { externalWait: { waitingFor: "Business" } });
    const baseline = task;
    task = await patch(task, { availabilityRule: inside });
    expect(task).toMatchObject({ revisitAt: baseline.revisitAt, reminders: baseline.reminders, externalWait: baseline.externalWait, status: baseline.status });
  });

  it("rejects unsupported schedule presets at the existing transport boundary", async () => {
    const response = await ctx.app.inject({ method: "POST", url: "/api/tasks", payload: { title: "Invalid", availabilityRule: { ...inside, windows: [{ weekdays: [1], start: "22:00", end: "01:00" }] } } });
    expect(response.statusCode).toBe(400);
  });

  it("filters planned, ordinary, and reached revisit execution while keeping deadline/wait attention", () => {
    const db = ctx.handle.db;
    const planned = insertTestTask(db, { title: "Planned", scheduledDate: today, availabilityRule: inside });
    const ordinary = insertTestTask(db, { title: "Ordinary", availabilityRule: inside });
    const revisit = insertTestTask(db, { title: "Revisit", revisitAt: "2026-07-13T06:00:00Z", availabilityRule: inside });
    const deadlineIds = ["2026-07-12", today, "2026-07-14"].map(dueDate => insertTestTask(db, { title: dueDate, dueDate, availabilityRule: inside }).id);
    const wait = insertTestTask(db, { title: "Wait", revisitAt: "2026-07-13T06:00:00Z", availabilityRule: inside });
    db.insert(schema.taskExternalWaits).values({ taskId: wait.id, waitingFor: "Reply" }).run();
    const anytime = insertTestTask(db, { title: "Anytime" });
    const agenda = compile();
    expect(rowIds(agenda)).toEqual(expect.arrayContaining([...deadlineIds, wait.id, anytime.id]));
    for (const task of [planned, ordinary, revisit]) expect(rowIds(agenda)).not.toContain(task.id);
    expect(agenda.revisit.map(t => t.id)).toContain(wait.id);
    expect(new Set(rowIds(agenda)).size).toBe(rowIds(agenda).length);
    expect(rowIds(compile("2026-07-13T07:00:00Z"))).toEqual(expect.arrayContaining([planned.id, ordinary.id, revisit.id]));
  });

  it("selects available project alternatives, removes nested bypasses, and never marks projects stuck", () => {
    const db = ctx.handle.db;
    const project = insertTestProject(db, { title: "Project", status: "active", dueDate: today });
    const first = insertTestTask(db, { title: "Call first", projectId: project.id, availabilityRule: inside, position: 0 });
    const alternative = insertTestTask(db, { title: "Write instead", projectId: project.id, position: 1 });
    const container = insertTestTask(db, { title: "Deadline container", dueDate: today });
    const nested = insertTestTask(db, { title: "Nested call", parentTaskId: container.id, availabilityRule: inside });
    const agenda = compile();
    expect(agenda.projects[0]?.nextAction?.id).toBe(alternative.id);
    expect(agenda.projects[0]?.project.nextAction?.id).toBe(alternative.id);
    expect(agenda.projects[0]?.stuck).toBeNull();
    expect(rowIds(agenda)).not.toContain(first.id);
    expect(rowIds(agenda)).not.toContain(nested.id);
    expect(agenda.dueToday.find(t => t.id === container.id)?.children).toEqual([]);
    const graph = Graph.load(db, now);
    expect(graph.nextActionFor(project.id)?.id).toBe(first.id);
    expect(graph.stuckReasonFor(project.id)).toBeNull();
    expect(graph.tasksById.get(nested.id)).toBeDefined();
  });

  it("keeps a project structurally ready when all current suggestions are outside their windows", () => {
    const db = ctx.handle.db;
    const project = insertTestProject(db, { title: "Calls", status: "active", dueDate: today });
    insertTestTask(db, { title: "Call", projectId: project.id, availabilityRule: inside });
    const entry = compile().projects[0]!;
    expect(entry.nextAction).toBeNull();
    expect(entry.project.nextAction).toBeNull();
    expect(entry.additionalNextActions).toEqual([]);
    expect(entry.stuck).toBeNull();
    expect(Graph.load(db, now).stuckReasonFor(project.id)).toBeNull();
  });

  it("combines future one-time deferral with the weekly window", () => {
    const db = ctx.handle.db;
    const task = insertTestTask(db, {
      title: "Call later", availabilityRule: inside, revisitAt: "2026-07-13T10:00:00Z",
    });
    expect(rowIds(compile("2026-07-13T07:00:00Z"))).not.toContain(task.id);
    expect(rowIds(compile("2026-07-13T10:00:00Z"))).toContain(task.id);
    expect(rowIds(compile("2026-07-13T15:00:00Z"))).not.toContain(task.id);
    expect(Graph.load(db, now).tasksById.get(task.id)?.revisitAt).toBe("2026-07-13T10:00:00Z");
  });

  it("evaluates refresh boundaries without writes, and keeps Week accessible", () => {
    const db = ctx.handle.db;
    const task = insertTestTask(db, { title: "Call", availabilityRule: inside, scheduledDate: today });
    const before = db.select().from(schema.workItems).all();
    const activityBefore = db.select().from(schema.activityEvents).all();
    expect(rowIds(compile("2026-07-13T14:59:59Z"))).toContain(task.id);
    expect(rowIds(compile("2026-07-13T15:00:00Z"))).not.toContain(task.id);
    expect(db.select().from(schema.workItems).all()).toEqual(before);
    expect(db.select().from(schema.activityEvents).all()).toEqual(activityBefore);
    const week = buildWeekAgenda(Graph.load(db, now), { start: today, today });
    expect(JSON.stringify(week)).toContain('"Call"');
  });
});
