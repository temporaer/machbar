import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { AvailabilityRule, Task } from "@machbar/shared";
import { buildAgenda, type BuildAgendaOptions } from "../src/domain/agenda.js";
import { buildWeekAgenda } from "../src/domain/weekAgenda.js";
import { Graph } from "../src/domain/graph.js";
import * as schema from "../src/db/schema.js";
import { closeTestContext, createTestContext, insertTestProject, insertTestTask, type TestContext } from "./helpers.js";

const today = "2026-07-13";
const tomorrow = "2026-07-14";
const now = "2026-07-13T10:00:00Z";
const inside: AvailabilityRule = {
  kind: "weekly", match: "inside",
  windows: [{ weekdays: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" }],
};
const outside: AvailabilityRule = { ...inside, match: "outside" };
const flatten = (tasks: Task[]): Task[] => tasks.flatMap(task => [task, ...flatten(task.children)]);
const roots = (agenda: ReturnType<typeof buildAgenda>) =>
  [agenda.overdue, agenda.dueToday, agenda.planned, agenda.revisit, agenda.dueSoon, agenda.shared, agenda.unscheduled].flat();
const ids = (agenda: ReturnType<typeof buildAgenda>) => flatten(roots(agenda)).map(task => task.id);

// These are compiled read invariants: fixture rows deliberately include states
// unavailable to execution, without changing their structural/domain readiness.
describe("Today execution eligibility across task and project containers", () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = createTestContext(); });
  afterEach(async () => { await closeTestContext(ctx); });
  const graph = (instant = now, viewer?: number) => Graph.load(ctx.handle.db, instant, viewer);
  const compile = (options: BuildAgendaOptions = {}) => buildAgenda(graph(options.now ?? now, options.memberId), {
    now, today, householdTimezone: "Europe/Berlin", ...options,
  });
  const task = (values: Parameters<typeof insertTestTask>[1]) => insertTestTask(ctx.handle.db, values);
  const project = (values: Parameters<typeof insertTestProject>[1]) => insertTestProject(ctx.handle.db, values);
  const state = () => ctx.handle.db.select().from(schema.workItems).all();

  it.each([false, true])("suppresses an undated parent with only future work (project=%s)", inProject => {
    const story = inProject ? project({ title: "Project", status: "active" }) : null;
    const parent = task({ title: "Prepare submission", projectId: story?.id });
    const child = task({ title: "Submit document", parentTaskId: parent.id, scheduledDate: tomorrow });
    const before = state();
    expect(ids(compile())).toEqual([]);
    expect(graph().taskContainsUnfinishedWork(parent.id)).toBe(true);
    if (story) expect(graph().nextActionFor(story.id)?.id).toBe(child.id);
    expect(state()).toEqual(before);
  });

  it.each([false, true])("selects ready alternatives without offering the parent (project=%s)", inProject => {
    const story = inProject ? project({ title: "Project", status: "active", dueDate: today }) : null;
    const parent = task({ title: "Prepare", projectId: story?.id });
    const future = task({ title: "Future first", parentTaskId: parent.id, scheduledDate: tomorrow, position: 0 });
    const ready = task({ title: "Ready second", parentTaskId: parent.id, position: 1 });
    const agenda = compile();
    expect(ids(agenda)).toEqual([ready.id]);
    expect(roots(agenda)[0]).toMatchObject({ id: ready.id, parentTaskId: parent.id, position: 1 });
    expect(ids(agenda)).not.toContain(future.id);
    if (story) {
      expect(graph().nextActionFor(story.id)?.id).toBe(future.id);
      expect(agenda.projects[0]?.nextAction?.id).toBe(ready.id);
      expect(agenda.projects[0]?.project.nextAction?.id).toBe(ready.id);
      expect(agenda.projects[0]?.stuck).toBeNull();
    }
  });

  it.each(["scheduled", "revisit", "window", "waiting", "dependency", "clarification", "parked", "context"])(
    "does not leak %s descendants through attention parents, while deeper ready work remains reachable", reason => {
      const parent = task({ title: "Deadline parent", dueDate: today });
      const unavailable = task({
        title: "Unavailable", parentTaskId: parent.id,
        ...(reason === "scheduled" ? { scheduledDate: tomorrow } : {}),
        ...(reason === "revisit" ? { revisitAt: "2026-07-13T10:01:00Z" } : {}),
        ...(reason === "window" ? { availabilityRule: outside } : {}),
        ...(reason === "clarification" ? { status: "captured" as const } : {}),
        ...(reason === "parked" ? { status: "someday" as const } : {}),
      });
      if (reason === "waiting") ctx.handle.db.insert(schema.taskExternalWaits).values({ taskId: unavailable.id, waitingFor: "Reply" }).run();
      if (reason === "dependency") {
        const blocker = task({ title: "Blocker", status: "captured" });
        ctx.handle.db.insert(schema.taskDependencies).values({ taskId: unavailable.id, dependsOnTaskId: blocker.id }).run();
      }
      const reference = task({ title: "Reference", parentTaskId: unavailable.id, taskKind: "reference" });
      const ready = task({ title: "Independent deeper action", parentTaskId: reference.id, position: 2 });
      const agenda = compile({ contextAvailability: item => ({
        status: reason === "context" && item.id === unavailable.id ? "unavailable" : "available",
        availableNow: item.id !== unavailable.id, missingContexts: [],
      }) });
      expect(agenda.dueToday[0]).toMatchObject({ id: parent.id, children: [{ id: ready.id, parentTaskId: reference.id, position: 2 }] });
      expect(ids(agenda)).toEqual([parent.id, ready.id]);
      expect(agenda.shared).toEqual([]);
    },
  );

  it("filters leaf eligibility as well as containers and preserves embedded order", () => {
    const parent = task({ title: "Attention", dueDate: today });
    const first = task({ title: "Z first", parentTaskId: parent.id, position: 0 });
    task({ title: "Future", parentTaskId: parent.id, position: 1, scheduledDate: tomorrow });
    task({ title: "Revisit", parentTaskId: parent.id, position: 2, revisitAt: "2026-07-13T10:01:00Z" });
    task({ title: "Outside", parentTaskId: parent.id, position: 3, availabilityRule: outside });
    const waiting = task({ title: "Waiting", parentTaskId: parent.id, position: 4 });
    ctx.handle.db.insert(schema.taskExternalWaits).values({ taskId: waiting.id, waitingFor: "Reply" }).run();
    const last = task({ title: "A last", parentTaskId: parent.id, position: 5 });
    expect(ids(compile())).toEqual([parent.id, first.id, last.id]);
  });

  it("filters blocked, parked, captured and unavailable-context leaf rows beneath attention", () => {
    const parent = task({ title: "Attention", dueDate: today });
    const blocker = task({ title: "Prerequisite", status: "captured" });
    const blocked = task({ title: "Dependency leaf", parentTaskId: parent.id });
    ctx.handle.db.insert(schema.taskDependencies).values({ taskId: blocked.id, dependsOnTaskId: blocker.id }).run();
    task({ title: "Captured leaf", parentTaskId: parent.id, status: "captured" });
    task({ title: "Parked leaf", parentTaskId: parent.id, status: "someday" });
    const context = task({ title: "Unavailable context leaf", parentTaskId: parent.id });
    const agenda = compile({ contextAvailability: item => ({
      status: item.id === context.id ? "unavailable" : "available",
      availableNow: item.id !== context.id, missingContexts: [],
    }) });
    expect(ids(agenda)).toEqual([parent.id]);
    expect(agenda.dueToday[0]?.children).toEqual([]);
  });

  it("promotes descendants in branch order while retaining their original positions", () => {
    const parent = task({ title: "Attention parent", dueDate: today });
    const hidden = task({ title: "Future branch", parentTaskId: parent.id, scheduledDate: tomorrow, position: 0 });
    const promoted = task({ title: "Promoted action", parentTaskId: hidden.id, position: 7 });
    const direct = task({ title: "Direct action", parentTaskId: parent.id, position: 1 });
    const before = state();
    expect(compile().dueToday[0]?.children.map(({ id, position, parentTaskId }) => ({ id, position, parentTaskId }))).toEqual([
      { id: promoted.id, position: 7, parentTaskId: hidden.id },
      { id: direct.id, position: 1, parentTaskId: parent.id },
    ]);
    expect(state()).toEqual(before);
  });

  it("keeps separately qualified child attention and its work unique", () => {
    const parent = task({ title: "Parent deadline", dueDate: today });
    const child = task({ title: "Child overdue", parentTaskId: parent.id, dueDate: "2026-07-12", scheduledDate: tomorrow });
    const ready = task({ title: "Ready", parentTaskId: child.id });
    const agenda = compile();
    expect(agenda.dueToday[0]?.children).toEqual([]);
    expect(agenda.overdue[0]?.children.map(item => item.id)).toEqual([ready.id]);
    expect(ids(agenda)).toEqual([child.id, ready.id, parent.id]);
    expect(new Set(ids(agenda)).size).toBe(ids(agenda).length);
  });

  it.each(["2026-07-12", today, tomorrow])("retains a parent's own %s deadline with deferred children", dueDate => {
    const parent = task({ title: "Own deadline", dueDate, availabilityRule: outside });
    task({ title: "Future", parentTaskId: parent.id, scheduledDate: tomorrow });
    expect(ids(compile())).toEqual([parent.id]);
    expect(roots(compile())[0]?.children).toEqual([]);
  });

  it("preserves reached external-wait follow-up precedence outside the execution window", () => {
    const parent = task({ title: "Follow up", revisitAt: now, availabilityRule: outside });
    ctx.handle.db.insert(schema.taskExternalWaits).values({ taskId: parent.id, waitingFor: "Reply" }).run();
    task({ title: "Future step", parentTaskId: parent.id, scheduledDate: tomorrow });
    expect(compile().revisit.map(item => item.id)).toEqual([parent.id]);
    expect(ids(compile())).toEqual([parent.id]);
  });

  it("does not let future revisits, parked or captured action leaves make the parent ready", () => {
    for (const status of ["captured", "someday"] as const) {
      const parent = task({ title: status });
      task({ title: "Unfinished", parentTaskId: parent.id, status });
      expect(graph().taskContainsUnfinishedWork(parent.id)).toBe(true);
    }
    const parent = task({ title: "Deferred" });
    task({ title: "Later", parentTaskId: parent.id, revisitAt: "2026-07-13T10:01:00Z" });
    expect(ids(compile())).toEqual([]);
  });

  it("treats references as transparent and lets the parent return after terminal work without completing it", () => {
    const parent = task({ title: "Wrap up" });
    const reference = task({ title: "Material", parentTaskId: parent.id, taskKind: "reference" });
    const child = task({ title: "Step", parentTaskId: reference.id, scheduledDate: tomorrow });
    expect(ids(compile())).toEqual([]);
    ctx.handle.db.update(schema.workItems).set({ status: "done" }).where(eq(schema.workItems.id, child.id)).run();
    const cancelled = task({ title: "Cancelled", parentTaskId: reference.id, status: "cancelled" });
    const before = state();
    expect(ids(compile())).toEqual([parent.id]);
    expect(graph().taskContainsUnfinishedWork(parent.id)).toBe(false);
    expect(state()).toEqual(before);
    expect(state().find(item => item.id === parent.id)?.status).toBe("active");
    expect(graph().tasksById.get(cancelled.id)?.status).toBe("cancelled");
  });

  it.each(["active", "completed", "archived"] as const)("reuses mixed-role facts around %s project subtrees", status => {
    const parent = task({ title: "Task container" });
    const nested = project({ title: "Nested project", parentId: parent.id, status });
    const child = task({ title: "Project action", projectId: nested.id, scheduledDate: tomorrow });
    const before = state();
    expect(graph().taskContainsOpenProject(parent.id)).toBe(status === "active");
    expect(graph().taskContainsUnfinishedWork(parent.id)).toBe(status === "active");
    expect(ids(compile())).toEqual(status === "active" ? [] : [parent.id]);
    ctx.handle.db.update(schema.workItems).set({ scheduledDate: null }).where(eq(schema.workItems.id, child.id)).run();
    expect(ids(compile())).toEqual(status === "active" ? [child.id] : [parent.id]);
    expect(state().find(item => item.id === nested.id)).toEqual(before.find(item => item.id === nested.id));
  });

  it("filters embedded effective owners and private scope using the viewer graph", () => {
    const [anna, ben] = ctx.handle.db.insert(schema.members).values([{ name: "Anna", color: "#123456" }, { name: "Ben", color: "#654321" }]).returning().all();
    const parent = task({ title: "Shared deadline", dueDate: today });
    const own = task({ title: "Own child", parentTaskId: parent.id, ownerMemberId: anna!.id, ownerInheritanceMode: "explicit" });
    task({ title: "Other child", parentTaskId: parent.id, ownerMemberId: ben!.id, ownerInheritanceMode: "explicit" });
    const privateParent = task({ title: "Private", dueDate: today, scope: "work", ownerMemberId: anna!.id, ownerInheritanceMode: "explicit" });
    const privateChild = task({ title: "Private ready", parentTaskId: privateParent.id, scope: "work" });
    task({ title: "Private future", parentTaskId: privateParent.id, scope: "work", scheduledDate: tomorrow });
    expect(ids(compile({ memberId: anna!.id, scope: "mine" }))).toEqual([parent.id, own.id]);
    expect(ids(compile({ memberId: anna!.id, scope: "work" }))).toEqual([privateParent.id, privateChild.id]);
    expect(ids(compile({ memberId: ben!.id, scope: "work" }))).toEqual([]);
  });

  it("keeps full detail and Week structure and evaluates clock/date boundaries without writes", async () => {
    const parent = task({ title: "Deadline context", dueDate: today });
    const child = task({ title: "Scheduled call", parentTaskId: parent.id, scheduledDate: tomorrow, availabilityRule: inside });
    const revisit = task({ title: "Exact revisit", parentTaskId: parent.id, revisitAt: "2026-07-13T10:01:00Z", availabilityRule: inside });
    const before = state();
    const activityBefore = ctx.handle.db.select().from(schema.activityEvents).all();
    expect(ids(compile())).toEqual([parent.id]);
    expect(ids(compile({ now: "2026-07-13T10:01:00Z" }))).toEqual([parent.id, revisit.id]);
    expect(ids(compile({ now: "2026-07-13T16:00:00Z" }))).toEqual([parent.id]);
    expect(ids(compile({ today: tomorrow, now: "2026-07-14T10:00:00Z" }))).toEqual([parent.id, child.id, revisit.id]);
    const detail = await ctx.app.inject({ method: "GET", url: `/api/tasks/${parent.id}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().children.map((item: Task) => item.id)).toEqual([child.id, revisit.id]);
    expect(detail.json().children[0].scheduledDate).toBe(tomorrow);
    const week = buildWeekAgenda(graph(), { start: today, today });
    expect(JSON.stringify(week)).toContain("Scheduled call");
    expect(state()).toEqual(before);
    expect(ctx.handle.db.select().from(schema.activityEvents).all()).toEqual(activityBefore);
  });
});
