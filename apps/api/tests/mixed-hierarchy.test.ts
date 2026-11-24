import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../src/db/schema.js";
import { Graph } from "../src/domain/graph.js";
import { buildAgenda } from "../src/domain/agenda.js";
import { buildReviewItems } from "../src/domain/reviewItems.js";
import { getDirectChildren } from "../src/repo/treeRepo.js";
import { createTestContext, closeTestContext, insertTestProject, insertTestTask, type TestContext } from "./helpers.js";

describe("mixed task/project hierarchy regressions", () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = createTestContext(); });
  afterEach(async () => { await closeTestContext(ctx); });
  const post = (url: string, payload: object) => ctx.app.inject({ method: "POST", url, payload });
  const get = async (url: string) => (await ctx.app.inject({ method: "GET", url })).json();
  async function create(url: string, input: object) {
    const response = await post(url, input);
    expect(response.statusCode, response.body).toBeLessThan(300);
    return response.json();
  }
  const siblings = (parentId: number | null) => getDirectChildren(ctx.handle.db, parentId);
  const state = () => ctx.handle.db.select().from(schema.workItems).all();
  const row = (id: number) => state().find((item) => item.id === id)!;
  async function move(id: number, parentTaskId: number, position?: number) {
    return create(`/api/tasks/${id}/move`, { parentTaskId, expectedRevision: row(id).revision, ...(position === undefined ? {} : { position }) });
  }
  async function mixedGroup() {
    const member = await create("/api/members", { name: "Mira" });
    const parent = await create("/api/tasks", { title: "Parent", status: "actionable", ownerMemberId: member.id, ownerInheritanceMode: "explicit" });
    const a = await create(`/api/tasks/${parent.id}/children`, { title: "A", status: "someday" });
    const b = await create(`/api/tasks/${parent.id}/children`, { title: "B", status: "someday" });
    const c = await create(`/api/tasks/${parent.id}/children`, { title: "C", status: "someday" });
    await create(`/api/tasks/${b.id}/convert-to-story`, { status: "backlog", expectedRevision: b.revision });
    return { parent, a, b, c };
  }
  function expectOrder(parentId: number, ids: number[]) {
    const items = siblings(parentId);
    expect(items.map((item) => item.id)).toEqual(ids);
    expect(items.map((item) => item.position)).toEqual(ids.map((_, i) => i));
  }

  it("reorders, moves into and moves out of mixed groups while invalidating changed sibling revisions", async () => {
    const { parent, a, b, c } = await mixedGroup();
    const pendingProjectMove = await get(`/api/projects/${b.id}`);
    const projectRevision = row(b.id).revision;
    const taskRevision = row(c.id).revision;
    await move(a.id, parent.id);
    expectOrder(parent.id, [b.id, c.id, a.id]);
    expect(row(a.id).revision).toBe(a.revision + 1);
    expect(row(b.id).revision).toBe(projectRevision + 1);
    expect(row(c.id).revision).toBe(taskRevision + 1);
    const before = state();
    const staleTask = await post(`/api/tasks/${c.id}/move`, { parentTaskId: parent.id, position: 0, expectedRevision: taskRevision });
    const staleProject = await post(`/api/projects/${b.id}/convert-to-task`, { expectedRevision: projectRevision });
    expect(staleTask.statusCode).toBe(409);
    expect(staleProject.statusCode).toBe(409);
    const staleProjectMove = await post(`/api/projects/${b.id}/move`, { parentId: null, expectedRevision: projectRevision, expectedHierarchyRevisions: pendingProjectMove.hierarchyRevisions });
    expect(staleProjectMove.statusCode).toBe(409);
    expect(state()).toEqual(before);
    const other = await create("/api/tasks", { title: "Other", status: "actionable" });
    const incoming = await create(`/api/tasks/${other.id}/children`, { title: "Incoming" });
    const unchangedProjectRevision = row(b.id).revision;
    await move(incoming.id, parent.id, 1);
    expectOrder(parent.id, [b.id, incoming.id, c.id, a.id]);
    expect(row(b.id).revision).toBe(unchangedProjectRevision);
    await move(incoming.id, other.id);
    expectOrder(parent.id, [b.id, c.id, a.id]);
    await move(c.id, other.id);
    expectOrder(parent.id, [b.id, a.id]);
    expectOrder(other.id, [incoming.id, c.id]);
    const detail = await get(`/api/tasks/${parent.id}`);
    expect([...detail.children, ...detail.childStories].sort((x, y) => x.position - y.position).map((item) => item.title)).toEqual(["B", "A"]);
  });

  it("allocates new and successor positions after both roles, including top-level items", async () => {
    const { parent, a, b, c } = await mixedGroup();
    const other = await create("/api/tasks", { title: "Other", status: "actionable" });
    await move(c.id, other.id);
    expectOrder(parent.id, [a.id, b.id]);
    const appended = await create(`/api/tasks/${parent.id}/children`, { title: "Appended" });
    expect(appended.position).toBe(2);
    const revision = row(b.id).revision;
    const successor = await create(`/api/tasks/${a.id}/successors`, { title: "Successor" });
    expectOrder(parent.id, [a.id, successor.id, b.id, appended.id]);
    expect(row(b.id).revision).toBe(revision + 1);
    const rootProject = await create("/api/projects", { title: "Root project" });
    const rootTask = await create("/api/tasks", { title: "Root task" });
    expect(rootTask.position).toBe(rootProject.position + 1);
    const roots = siblings(null);
    expect(new Set(roots.map((item) => item.position)).size).toBe(roots.length);
  });

  async function nestedConversion() {
    const member = await create("/api/members", { name: "Mira" });
    const outer = await create("/api/projects", { title: "Outer" });
    const parent = await create("/api/tasks", { title: "Container P", projectId: outer.id });
    const child = await create(`/api/tasks/${parent.id}/children`, { title: "Step C" });
    await create(`/api/projects/${outer.id}/activate`, { expectedRevision: outer.revision, ownerMemberId: member.id });
    expect(Graph.load(ctx.handle.db).nextActionFor(outer.id)?.id).toBe(child.id);
    const converted = await create(`/api/tasks/${child.id}/convert-to-story`, { status: "active", expectedRevision: child.revision });
    const detail = await get(`/api/projects/${converted.id}`);
    return { outer, parent, child, project: detail, step: detail.tasks[0] };
  }
  function todayIds() {
    const agenda = buildAgenda(Graph.load(ctx.handle.db), { today: "2026-10-14", now: "2026-10-14T12:00:00.000Z" });
    return [...agenda.shared, ...agenda.unscheduled, ...agenda.planned].map((task) => task.id);
  }

  it("parks and reactivates a mixed hierarchy through project workflow commands without rewriting descendants", async () => {
    const member = await create("/api/members", { name: "Driver" });
    const outer = insertTestProject(ctx.handle.db, { title: "Outer", status: "active", ownerMemberId: member.id });
    const container = insertTestTask(ctx.handle.db, { title: "Container", projectId: outer.id, notes: "Container notes", taskKind: "action" });
    const progress = insertTestTask(ctx.handle.db, { title: "Outer progress", projectId: outer.id, taskKind: "action" });
    const inner = insertTestProject(ctx.handle.db, { title: "Inner", status: "active", parentId: container.id, ownerMemberId: member.id });
    const open = insertTestTask(ctx.handle.db, { title: "Open", projectId: inner.id, notes: "Keep notes", taskKind: "action" });
    const done = insertTestTask(ctx.handle.db, { title: "Done", projectId: inner.id, status: "done", scheduledDate: "2026-10-14", completedAt: "2026-10-14T09:00:00.000Z", taskKind: "action" });
    const someday = insertTestTask(ctx.handle.db, { title: "Someday", projectId: inner.id, status: "someday", taskKind: "action" });
    const waiting = insertTestTask(ctx.handle.db, { title: "Future revisit", projectId: inner.id, revisitAt: "2099-01-01T09:00:00.000Z", taskKind: "action" });
    ctx.handle.db.insert(schema.taskReminders).values({ taskId: waiting.id, kind: "absolute", at: "2098-12-31T09:00:00.000Z" }).run();
    const descendantIds = [container.id, progress.id, inner.id, open.id, done.id, someday.id, waiting.id];
    const descendants = () => state().filter((item) => descendantIds.includes(item.id));
    const before = descendants();
    const reminders = ctx.handle.db.select().from(schema.taskReminders).all();
    const initial = await get(`/api/projects/${outer.id}`);
    expect(initial.availableActions).toContain("return_to_backlog");
    const agenda = async () => get("/api/agenda/today?scope=all&date=2026-10-14");
    const taskIds = (view: any) => ["planned", "overdue", "dueToday", "dueSoon", "shared", "unscheduled", "revisit"]
      .flatMap((bucket) => view[bucket].map((task: { id: number }) => task.id));
    expect(taskIds(await agenda())).toContain(open.id);

    const stale = await post(`/api/projects/${outer.id}/return-to-backlog`, { expectedRevision: initial.revision + 1 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("stale_write_conflict");
    expect(descendants()).toEqual(before);
    expect(row(outer.id).revision).toBe(initial.revision);
    const parked = await post(`/api/projects/${outer.id}/return-to-backlog`, { expectedRevision: initial.revision });
    expect(parked.statusCode, parked.body).toBe(200);
    expect(parked.json()).toMatchObject({ status: "backlog", revision: initial.revision + 1 });
    expect(descendants()).toEqual(before);
    expect(ctx.handle.db.select().from(schema.taskReminders).all()).toEqual(reminders);
    expect(taskIds(await agenda())).not.toContain(open.id);
    expect(await get(`/api/projects/${inner.id}`)).toMatchObject({ status: "active", effectivelyParked: true, openCount: 3, doneCount: 1 });
    expect(await get(`/api/tasks/${done.id}`)).toMatchObject({ status: "done", scheduledDate: "2026-10-14" });
    expect(await get(`/api/tasks/${someday.id}`)).toMatchObject({ status: "someday" });

    const staleActivation = await post(`/api/projects/${outer.id}/activate`, { expectedRevision: initial.revision, ownerMemberId: member.id });
    expect(staleActivation.statusCode).toBe(409);
    expect(staleActivation.json().error.code).toBe("stale_write_conflict");
    expect(descendants()).toEqual(before);
    const activated = await post(`/api/projects/${outer.id}/activate`, { expectedRevision: parked.json().revision, ownerMemberId: member.id });
    expect(activated.statusCode, activated.body).toBe(200);
    expect(activated.json()).toMatchObject({ status: "active", revision: parked.json().revision + 1 });
    expect(descendants()).toEqual(before);
    expect(ctx.handle.db.select().from(schema.taskReminders).all()).toEqual(reminders);
    expect(taskIds(await agenda())).toContain(open.id);
    expect(await get(`/api/projects/${inner.id}`)).toMatchObject({ status: "active", effectivelyParked: false, openCount: 3, doneCount: 1 });
    expect(await get(`/api/tasks/${done.id}`)).toMatchObject({ status: "done" });
    expect(await get(`/api/tasks/${someday.id}`)).toMatchObject({ status: "someday" });
  });

  it("rejects parking with an execution commitment without changing descendants or reminders", async () => {
    const member = await create("/api/members", { name: "Driver" });
    const project = insertTestProject(ctx.handle.db, { title: "Committed", status: "active", ownerMemberId: member.id });
    const task = insertTestTask(ctx.handle.db, { title: "Scheduled", projectId: project.id, scheduledDate: "2026-10-14", notes: "Keep", taskKind: "action" });
    ctx.handle.db.insert(schema.taskReminders).values({ taskId: task.id, kind: "absolute", at: "2026-10-14T09:00:00.000Z" }).run();
    const before = state();
    const reminders = ctx.handle.db.select().from(schema.taskReminders).all();
    const response = await post(`/api/projects/${project.id}/return-to-backlog`, { expectedRevision: project.revision });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({
      code: "project_commitments_prevent_parking",
      details: { committedTaskIds: [task.id] },
    });
    expect(state()).toEqual(before);
    expect(ctx.handle.db.select().from(schema.taskReminders).all()).toEqual(reminders);
  });

  it("gates scheduled and unscheduled work beneath a backlog project across mixed ancestry without rewriting it", async () => {
    const member = await create("/api/members", { name: "Driver" });
    const outer = insertTestProject(ctx.handle.db, { title: "Outer", status: "active", ownerMemberId: member.id });
    const container = insertTestTask(ctx.handle.db, { title: "Container", projectId: outer.id });
    const inner = insertTestProject(ctx.handle.db, { title: "Inner", status: "active", parentId: container.id, ownerMemberId: member.id, dueDate: "2026-10-14" });
    const scheduled = insertTestTask(ctx.handle.db, { title: "Scheduled", projectId: inner.id, scheduledDate: "2026-10-14", notes: "Keep" });
    const unscheduled = insertTestTask(ctx.handle.db, { title: "Unscheduled", projectId: inner.id, additionalNextAction: true });
    const someday = insertTestTask(ctx.handle.db, { title: "Someday", projectId: inner.id, status: "someday" });
    const progress = insertTestTask(ctx.handle.db, { title: "Outer progress", projectId: outer.id });
    const sibling = insertTestTask(ctx.handle.db, { title: "Standalone" });
    const waiting = insertTestTask(ctx.handle.db, { title: "Waiting", projectId: inner.id });
    const dependent = insertTestTask(ctx.handle.db, { title: "Dependent" });
    ctx.handle.db.insert(schema.taskExternalWaits).values({ taskId: waiting.id, waitingFor: "Reply" }).run();
    ctx.handle.db.insert(schema.taskDependencies).values({ taskId: dependent.id, dependsOnTaskId: unscheduled.id }).run();
    const day = "2026-10-14";
    const readAgenda = async () => {
      const response = await ctx.app.inject({ method: "GET", url: `/api/agenda/today?scope=all&date=${day}` });
      expect(response.statusCode).toBe(200);
      return response.json();
    };
    const taskIds = (agenda: any) => ["planned", "overdue", "dueToday", "dueSoon", "shared", "unscheduled", "revisit"]
      .flatMap((bucket) => agenda[bucket].map((task: { id: number }) => task.id));
    const weekProject = async () => {
      const week = await get(`/api/agenda/week?scope=all&start=${day}&today=${day}`);
      return week.days.flatMap((entry: { items: Array<{ id: number }> }) => entry.items)
        .find((entry: { id: number }) => entry.id === inner.id);
    };

    expect(taskIds(await readAgenda())).toEqual(expect.arrayContaining([scheduled.id, unscheduled.id, sibling.id]));
    expect(await weekProject()).toMatchObject({ executable: true });
    ctx.handle.sqlite.prepare("UPDATE work_items SET status = 'backlog', owner_member_id = NULL WHERE id = ?").run(outer.id);
    const before = state();
    const parked = await readAgenda();
    expect(taskIds(parked)).not.toContain(scheduled.id);
    expect(taskIds(parked)).not.toContain(unscheduled.id);
    expect(taskIds(parked)).toContain(sibling.id);
    expect(parked.projects.map((entry: { project: { id: number } }) => entry.project.id)).not.toContain(inner.id);
    expect(await weekProject()).toMatchObject({ executable: false });
    expect((await get("/api/waiting")).map((entry: { task: { id: number } }) => entry.task.id)).not.toContain(waiting.id);
    expect(Graph.load(ctx.handle.db).blockerAnalysisFor(dependent.id)).toMatchObject({
      blocked: true, healthyProgressPath: false,
      diagnoses: [expect.objectContaining({ reason: "backlog_project", targetTaskId: unscheduled.id })],
    });
    const graph = Graph.load(ctx.handle.db);
    expect(graph.stuckReasonFor(inner.id)).toBeNull();
    expect(await get(`/api/projects/${inner.id}`)).toMatchObject({
      effectivelyParked: true, nextAction: { id: scheduled.id, executable: false },
    });
    expect(buildReviewItems(graph).filter((item) => item.entityId === inner.id && item.entityType === "project")
      .map((item) => item.reason)).not.toContain("no_viable_progress_path");
    const detail = await get(`/api/tasks/${scheduled.id}`);
    expect(detail).toMatchObject({ status: "actionable", executable: false, scheduledDate: day, notes: "Keep" });
    expect((await get(`/api/tasks/${someday.id}`)).status).toBe("someday");
    expect(state()).toEqual(before);

    const activation = await post(`/api/projects/${outer.id}/activate`, { expectedRevision: row(outer.id).revision, ownerMemberId: member.id });
    expect(activation.statusCode, activation.body).toBe(200);
    expect(taskIds(await readAgenda())).toEqual(expect.arrayContaining([scheduled.id, unscheduled.id, progress.id, sibling.id]));
    expect(await weekProject()).toMatchObject({ executable: true });
    expect(await get(`/api/projects/${inner.id}`)).toMatchObject({ effectivelyParked: false });
    expect((await get(`/api/tasks/${someday.id}`)).status).toBe("someday");
    for (const id of [container.id, inner.id, scheduled.id, unscheduled.id, someday.id, progress.id, waiting.id, dependent.id]) {
      expect(row(id)).toEqual(before.find((item) => item.id === id));
    }
  });

  it("keeps a reached revisit structural while Week recognizes a later executable action", async () => {
    const day = "2026-10-14";
    const project = insertTestProject(ctx.handle.db, { title: "Active", status: "active", dueDate: day });
    const reached = insertTestTask(ctx.handle.db, {
      title: "Reached revisit", projectId: project.id, revisitAt: "2020-01-01T12:00:00.000Z",
    });
    insertTestTask(ctx.handle.db, { title: "Later action", projectId: project.id });
    expect(await get(`/api/projects/${project.id}`)).toMatchObject({
      nextAction: { id: reached.id, executable: false },
    });
    const week = await get(`/api/agenda/week?scope=all&start=${day}&today=${day}`);
    const item = week.days.flatMap((entry: { items: Array<{ id: number }> }) => entry.items)
      .find((entry: { id: number }) => entry.id === project.id);
    expect(item).toMatchObject({ executable: true });
  });

  it("does not count a dependency under a different parked ancestor as activation progress", () => {
    const outer = insertTestProject(ctx.handle.db, { title: "Parked ancestor" });
    const middle = insertTestTask(ctx.handle.db, { title: "Container", projectId: outer.id });
    const inner = insertTestProject(ctx.handle.db, { title: "Active nested", status: "active", parentId: middle.id });
    const prerequisite = insertTestTask(ctx.handle.db, { title: "Future prerequisite", projectId: inner.id, scheduledDate: "2099-12-01" });
    const target = insertTestProject(ctx.handle.db, { title: "Target" });
    const dependent = insertTestTask(ctx.handle.db, { title: "Dependent", projectId: target.id });
    ctx.handle.db.insert(schema.taskDependencies).values({ taskId: dependent.id, dependsOnTaskId: prerequisite.id }).run();

    const graph = Graph.load(ctx.handle.db);
    expect(graph.projectWithComputed(target.id)?.activationReadiness.hasHealthyFutureWaiting).toBe(false);
  });

  it("keeps a task with an open project descendant out of next actions and Today through conversion and inverse", async () => {
    const { outer, parent, child, project, step } = await nestedConversion();
    const graph = Graph.load(ctx.handle.db);
    expect(graph.nextActionFor(outer.id)).toBeNull();
    expect(graph.nextActionFor(project.id)?.id).toBe(step.id);
    expect(todayIds()).not.toContain(parent.id);
    expect(todayIds()).toContain(step.id);
    const before = state();
    for (const command of ["complete", "cancel"]) {
      const rejected = await post(`/api/tasks/${parent.id}/${command}`, { expectedRevision: row(parent.id).revision, descendantsPolicy: "complete_children" });
      expect(rejected.statusCode).toBe(409);
      expect(rejected.json().error.details.reason).toBe("project_descendants");
      expect(state()).toEqual(before);
    }
    await create(`/api/projects/${child.id}/convert-to-task`, { expectedRevision: row(child.id).revision });
    expect(Graph.load(ctx.handle.db).nextActionFor(outer.id)?.id).toBe(step.id);
    expect(todayIds()).toContain(step.id);
    await create(`/api/tasks/${step.id}/complete`, { expectedRevision: row(step.id).revision });
    expect(Graph.load(ctx.handle.db).nextActionFor(outer.id)?.id).toBe(child.id);
    await create(`/api/tasks/${child.id}/complete`, { expectedRevision: row(child.id).revision });
    expect(Graph.load(ctx.handle.db).nextActionFor(outer.id)?.id).toBe(parent.id);
    await create(`/api/tasks/${parent.id}/complete`, { expectedRevision: row(parent.id).revision });
  });

  it("also hides standalone containers until their project descendants are terminal", async () => {
    const member = await create("/api/members", { name: "Mira" });
    const parent = await create("/api/tasks", { title: "Standalone", status: "actionable", ownerMemberId: member.id, ownerInheritanceMode: "explicit" });
    const child = await create(`/api/tasks/${parent.id}/children`, { title: "Child" });
    const project = await create(`/api/tasks/${child.id}/convert-to-story`, { status: "active", expectedRevision: child.revision });
    const step = (await get(`/api/projects/${project.id}`)).tasks[0];
    expect(todayIds()).not.toContain(parent.id);
    expect(todayIds()).toContain(step.id);
    await create(`/api/projects/${project.id}/archive`, { expectedRevision: row(project.id).revision });
    expect(todayIds()).toContain(parent.id);
    await create(`/api/tasks/${parent.id}/complete`, { expectedRevision: row(parent.id).revision });
    expect(row(step.id).status).toBe("active");
  });

  it.each([
    ["completed", "complete"], ["completed", "cancel"],
    ["archived", "complete"], ["archived", "cancel"],
  ])("preserves a %s project subtree while allowing the containing task to %s", async (status, command) => {
    const { outer, parent, project, step } = await nestedConversion();
    if (status === "completed") {
      await create(`/api/tasks/${step.id}/complete`, { expectedRevision: row(step.id).revision });
      await create(`/api/projects/${project.id}/complete`, { expectedRevision: row(project.id).revision });
    } else {
      await create(`/api/projects/${project.id}/archive`, { expectedRevision: row(project.id).revision });
    }
    expect(Graph.load(ctx.handle.db).nextActionFor(outer.id)?.id).toBe(parent.id);
    expect(todayIds()).toContain(parent.id);
    expect(todayIds()).not.toContain(step.id);
    const historicalProject = row(project.id);
    const historicalStep = row(step.id);
    await create(`/api/tasks/${parent.id}/${command}`, { expectedRevision: row(parent.id).revision, descendantsPolicy: "complete_children" });
    expect(row(project.id)).toEqual(historicalProject);
    expect(row(step.id)).toEqual(historicalStep);
    expect(row(parent.id).status).toBe(command === "complete" ? "done" : "cancelled");
  });
});
