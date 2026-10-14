import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACTIVITY_ACTOR_HEADER } from "@machbar/shared";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema.js";
import { createTestContext, closeTestContext, type TestContext } from "./helpers.js";

describe("phase 6a parent-preserving structure", () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = createTestContext(); });
  afterEach(async () => { await closeTestContext(ctx); });
  const post = (url: string, payload: object) => ctx.app.inject({ method: "POST", url, payload });
  const get = async (url: string) => (await ctx.app.inject({ method: "GET", url })).json();
  const rows = () => ctx.handle.db.select().from(schema.workItems).all();
  async function project(title: string, parentId: number | null = null) {
    return (await post("/api/projects", { title, parentId })).json();
  }
  async function moveInput(id: number, parentId: number | null) {
    const source = await get(`/api/projects/${id}`);
    const destination = parentId === null ? null : await get(`/api/projects/${parentId}`);
    const revisions = new Map<number, number>(source.hierarchyRevisions.map((entry: { id: number; revision: number }) => [entry.id, entry.revision]));
    for (const item of [destination, ...(destination?.ancestors ?? [])]) if (item) revisions.set(item.id, item.revision);
    return { parentId, expectedRevision: source.revision, expectedHierarchyRevisions: [...revisions].map(([id, revision]) => ({ id, revision })) };
  }

  it.each(["project", "task"])("converts a task under a %s and back with its identity, placement, material, ownership and descendants", async (role) => {
    const member = (await post("/api/members", { name: "Mira" })).json();
    const parent = role === "project"
      ? (await post("/api/projects", { title: "Parent", ownerMemberId: member.id })).json()
      : (await post("/api/tasks", { title: "Parent", status: "actionable", ownerMemberId: member.id, ownerInheritanceMode: "explicit" })).json();
    const destination = role === "project" ? { projectId: parent.id } : { parentTaskId: parent.id };
    const child = (await post("/api/tasks", { title: "Child", notes: "Authored material", status: "someday", ...destination })).json();
    const sibling = (await post("/api/tasks", { title: "Sibling", status: "someday", ...destination })).json();
    const grandchild = (await post(`/api/tasks/${child.id}/children`, { title: "Existing step" })).json();
    const before = rows().find((row) => row.id === child.id)!;
    const snapshot = await get(`/api/tasks/${child.id}`);
    const response = await post(`/api/tasks/${child.id}/convert-to-story`, { status: "backlog", expectedRevision: snapshot.revision, expectedHierarchyRevisions: snapshot.hierarchyRevisions });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({ id: child.id, parentId: parent.id, position: before.position, notes: before.notes });
    const converted = await get(`/api/projects/${child.id}`);
    expect(converted.ancestors.map((item: { id: number }) => item.id)).toContain(parent.id);
    expect(converted.tasks[0]).toMatchObject({ id: grandchild.id, projectId: child.id, effectiveOwnerId: member.id });
    if (role === "task") {
      const parentDetail = await get(`/api/tasks/${parent.id}`);
      expect(parentDetail.childStories.map((item: { id: number }) => item.id)).toContain(child.id);
      const committed = rows();
      const completion = await post(`/api/tasks/${parent.id}/complete`, { expectedRevision: parentDetail.revision, descendantsPolicy: "complete_children" });
      expect(completion.statusCode).toBe(409);
      expect(completion.json().error.details.reason).toBe("project_descendants");
      expect(rows()).toEqual(committed);
    }
    const inverse = await post(`/api/projects/${child.id}/convert-to-task`, { expectedRevision: converted.revision, expectedHierarchyRevisions: converted.hierarchyRevisions });
    expect(inverse.statusCode, inverse.body).toBe(201);
    expect(inverse.json()).toMatchObject({ id: child.id, position: before.position, notes: before.notes });
    expect(rows().find((row) => row.id === child.id)?.parentId).toBe(parent.id);
    expect((await get(`/api/tasks/${sibling.id}`)).position).toBe(sibling.position);
  });

  it("moves a whole subtree and rejects stale descendant and ancestor snapshots without writes", async () => {
    const source = await project("Source");
    const moving = await project("Moving", source.id);
    const nested = await project("Nested", moving.id);
    const target = await project("Target");
    const task = (await post("/api/tasks", { title: "Material", kind: "reference", projectId: nested.id })).json();
    for (const id of [task.id, source.id, target.id]) {
      const input = await moveInput(moving.id, target.id);
      ctx.handle.db.update(schema.workItems).set({ revision: rows().find((row) => row.id === id)!.revision + 1 }).where(eq(schema.workItems.id, id)).run();
      const changed = rows();
      const stale = await post(`/api/projects/${moving.id}/move`, input);
      expect(stale.statusCode).toBe(409);
      expect(rows()).toEqual(changed);
    }
    const accepted = await post(`/api/projects/${moving.id}/move`, await moveInput(moving.id, target.id));
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json().parentId).toBe(target.id);
    expect((await get(`/api/projects/${nested.id}`)).parentId).toBe(moving.id);
    expect((await get(`/api/tasks/${task.id}`)).projectId).toBe(nested.id);
    const standalone = await post(`/api/projects/${moving.id}/move`, await moveInput(moving.id, null));
    expect(standalone.statusCode).toBe(200);
    expect(standalone.json().parentId).toBeNull();
  });

  it("rejects cycles, task destinations, cross-scope movement and incomplete snapshots", async () => {
    const moving = await project("Moving");
    const nested = await project("Nested", moving.id);
    const task = (await post("/api/tasks", { title: "Task destination" })).json();
    const member = (await post("/api/members", { name: "Mira" })).json();
    const work = await project("Private");
    ctx.handle.db.update(schema.workItems).set({ scope: "work", ownerMemberId: member.id }).where(eq(schema.workItems.id, work.id)).run();
    for (const parentId of [moving.id, nested.id, task.id, work.id]) {
      const before = rows();
      const response = await post(`/api/projects/${moving.id}/move`, { ...(await moveInput(moving.id, null)), parentId });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(rows()).toEqual(before);
    }
    const scopeResponse = await ctx.app.inject({ method: "POST", url: `/api/projects/${moving.id}/move`, headers: { [ACTIVITY_ACTOR_HEADER]: String(member.id) }, payload: { ...(await moveInput(moving.id, null)), parentId: work.id } });
    expect(scopeResponse.statusCode, scopeResponse.body).toBe(409);
    expect(scopeResponse.json().error.code).toBe("scope_mismatch");
    const before = rows();
    const incomplete = await post(`/api/projects/${moving.id}/move`, { ...(await moveInput(moving.id, null)), expectedHierarchyRevisions: [] });
    expect(incomplete.statusCode).toBe(409);
    expect(rows()).toEqual(before);
  });

  it("collects activation decisions inside a committed subtree move", async () => {
    const member = (await post("/api/members", { name: "Mira" })).json();
    const source = (await post("/api/projects", { title: "Moving", ownerMemberId: member.id })).json();
    await post("/api/tasks", { title: "Dated step", projectId: source.id, scheduledDate: "2026-12-01" });
    const target = await project("Destination");
    const input = await moveInput(source.id, target.id);
    const before = rows();
    const response = await post(`/api/projects/${source.id}/move`, input);
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().error.code).toBe("project_commitment_resolution_required");
    expect(rows()).toEqual(before);
    const snapshot = response.json().error.details;
    expect(snapshot.projects.every((entry: { required: string[] }) => !entry.required.includes("progressPath"))).toBe(true);
    const accepted = await post(`/api/projects/${source.id}/move`, { ...input, activationResolution: { expectedProjects: snapshot.expectedProjects, drivers: snapshot.projects.map((entry: { projectId: number }) => ({ projectId: entry.projectId, ownerMemberId: member.id })) } });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect((await get(`/api/projects/${target.id}`)).status).toBe("active");
    expect((await get(`/api/projects/${source.id}`)).parentId).toBe(target.id);
  });

  it("preserves nested recurrence, reminders, dependency direction and inherited material", async () => {
    const member = (await post("/api/members", { name: "Mira" })).json();
    const context = ctx.handle.db.insert(schema.physicalContexts).values({ name: "Home", source: "home_assistant", externalId: "home" }).returning().get();
    const tag = (await post("/api/tags", { name: "Material", kind: "plain" })).json();
    const parent = (await post("/api/tasks", { title: "Parent", status: "actionable", ownerMemberId: member.id, ownerInheritanceMode: "explicit", contextInheritanceMode: "explicit", contextIds: [context.id], tagIds: [tag.id] })).json();
    const availabilityRule = { kind: "weekly", match: "inside", windows: [{ weekdays: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" }] };
    const response = await post("/api/tasks", { availabilityRule, title: "Recurring", parentTaskId: parent.id, status: "actionable", dueDate: "2026-09-17", scheduledDate: "2026-09-15", repeatAfterDays: 7, allowedDeviationDays: 2, reminders: [{ kind: "absolute", at: "2026-12-09T09:00:00.000Z" }] });
    expect(response.statusCode, response.body).toBe(201);
    const task = response.json();
    const dependent = (await post("/api/tasks", { title: "Depends on recurring" })).json();
    const edge = await post(`/api/tasks/${dependent.id}/dependencies`, { dependsOnTaskId: task.id, expectedRevision: dependent.revision });
    expect(edge.statusCode, edge.body).toBe(201);
    ctx.handle.db.insert(schema.taskRecurrenceOccurrences).values({ taskId: task.id, scheduledDate: "2026-09-01", deadlineDate: "2026-09-08", completedOn: "2026-09-01", completedAt: "2026-09-01T09:00:00.000Z", result: "hit" }).run();
    const snapshot = await get(`/api/tasks/${task.id}`);
    const converted = await post(`/api/tasks/${task.id}/convert-to-story`, { status: "backlog", expectedRevision: snapshot.revision, expectedHierarchyRevisions: snapshot.hierarchyRevisions });
    expect(converted.statusCode, converted.body).toBe(201);
    const detail = await get(`/api/projects/${task.id}`);
    const retained = detail.tasks[0];
    expect(detail).toMatchObject({ parentId: parent.id, ownerMemberId: member.id, tags: [expect.objectContaining({ id: tag.id })], contexts: [expect.objectContaining({ id: context.id })] });
    expect(retained).toMatchObject({ availabilityRule, dueDate: "2026-09-17", scheduledDate: "2026-09-15", repeatAfterDays: 7, effectiveOwnerId: member.id, reminders: [expect.objectContaining({ id: task.reminders[0].id })] });
    expect(ctx.handle.db.select().from(schema.taskRecurrenceOccurrences).where(eq(schema.taskRecurrenceOccurrences.taskId, retained.id)).all()).toHaveLength(1);
    expect((await get(`/api/tasks/${dependent.id}`)).dependencies[0].dependsOnTaskId).toBe(retained.id);
    const before = rows();
    const cycle = await post(`/api/tasks/${parent.id}/move`, { projectId: task.id, parentTaskId: null, expectedRevision: (await get(`/api/tasks/${parent.id}`)).revision });
    expect(cycle.statusCode).toBe(409);
    expect(rows()).toEqual(before);
  });

  it("rejects stale nested conversion ancestry and new descendants before writing", async () => {
    const parent = (await post("/api/tasks", { title: "Parent", status: "actionable" })).json();
    const task = (await post(`/api/tasks/${parent.id}/children`, { title: "Child" })).json();
    const snapshot = await get(`/api/tasks/${task.id}`);
    ctx.handle.db.update(schema.workItems).set({ revision: parent.revision + 1 }).where(eq(schema.workItems.id, parent.id)).run();
    const before = rows();
    const stale = await post(`/api/tasks/${task.id}/convert-to-story`, { status: "backlog", expectedRevision: snapshot.revision, expectedHierarchyRevisions: snapshot.hierarchyRevisions });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("stale_write_conflict");
    expect(rows()).toEqual(before);
    const fresh = await get(`/api/tasks/${task.id}`);
    await post(`/api/tasks/${task.id}/children`, { title: "New child" });
    const changed = rows();
    const membership = await post(`/api/tasks/${task.id}/convert-to-story`, { status: "backlog", expectedRevision: fresh.revision, expectedHierarchyRevisions: fresh.hierarchyRevisions });
    expect(membership.statusCode).toBe(409);
    expect(rows()).toEqual(changed);
  });

  it("activates a required project ancestor across an intervening task parent", async () => {
    const member = (await post("/api/members", { name: "Mira" })).json();
    const outer = (await post("/api/projects", { title: "Outer", ownerMemberId: member.id })).json();
    const parent = (await post("/api/tasks", { title: "Task parent", projectId: outer.id, status: "someday" })).json();
    const task = (await post(`/api/tasks/${parent.id}/children`, { title: "Convert nested child" })).json();
    const snapshot = await get(`/api/tasks/${task.id}`);
    const before = rows();
    const input = { status: "active", expectedRevision: snapshot.revision, expectedHierarchyRevisions: snapshot.hierarchyRevisions };
    const required = await post(`/api/tasks/${task.id}/convert-to-story`, input);
    expect(required.statusCode, required.body).toBe(409);
    expect(required.json().error.code).toBe("project_commitment_resolution_required");
    expect(rows()).toEqual(before);
    const response = await post(`/api/tasks/${task.id}/convert-to-story`, { ...input, activationResolution: { expectedProjects: required.json().error.details.expectedProjects, drivers: [], nextActionTitle: "Reviewed next step" } });
    expect(response.statusCode, response.body).toBe(201);
    expect((await get(`/api/projects/${outer.id}`)).status).toBe("active");
    expect(response.json().ancestors.map((entry: { id: number }) => entry.id)).toEqual([outer.id, parent.id]);
  });

  it("moves historical projects without activating old deadlines or reviving work", async () => {
    const historical = await project("Completed");
    const destination = await project("Backlog destination");
    ctx.handle.db.update(schema.workItems).set({ status: "done", dueDate: "2026-01-01", completedAt: "2026-01-01T12:00:00.000Z" }).where(eq(schema.workItems.id, historical.id)).run();
    const response = await post(`/api/projects/${historical.id}/move`, await moveInput(historical.id, destination.id));
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().status).toBe("completed");
    expect((await get(`/api/projects/${destination.id}`)).status).toBe("backlog");
  });

  it("keeps inverse child-project descendants explicitly unsupported", async () => {
    const parent = await project("Parent");
    await project("Nested", parent.id);
    const before = rows();
    const response = await post(`/api/projects/${parent.id}/convert-to-task`, { expectedRevision: parent.revision });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.details.reason).toBe("nested_projects");
    expect(rows()).toEqual(before);
  });
});
