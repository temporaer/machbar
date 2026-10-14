import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../src/db/schema.js";
import { Graph } from "../src/domain/graph.js";
import { buildAgenda } from "../src/domain/agenda.js";
import { getDirectChildren } from "../src/repo/treeRepo.js";
import { createTestContext, closeTestContext, type TestContext } from "./helpers.js";

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
    const outer = await create("/api/projects", { title: "Outer", ownerMemberId: member.id });
    const parent = await create("/api/tasks", { title: "Container P", projectId: outer.id });
    const child = await create(`/api/tasks/${parent.id}/children`, { title: "Step C" });
    await create(`/api/projects/${outer.id}/activate`, { expectedRevision: outer.revision });
    expect(Graph.load(ctx.handle.db).nextActionFor(outer.id)?.id).toBe(child.id);
    const converted = await create(`/api/tasks/${child.id}/convert-to-story`, { status: "active", expectedRevision: child.revision });
    const detail = await get(`/api/projects/${converted.id}`);
    return { outer, parent, child, project: detail, step: detail.tasks[0] };
  }
  function todayIds() {
    const agenda = buildAgenda(Graph.load(ctx.handle.db), { today: "2026-10-14", now: "2026-10-14T12:00:00.000Z" });
    return [...agenda.shared, ...agenda.unscheduled, ...agenda.planned].map((task) => task.id);
  }

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
