import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeTestContext, createTestContext, insertTestProject, insertTestTask, type TestContext } from "./helpers.js";

describe("explicit deferral contract", () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = createTestContext(); });
  afterEach(async () => { await closeTestContext(ctx); });

  it("parks a project without changing commitments or descendants, and checks its revision", async () => {
    const member = (await ctx.app.inject({ method: "POST", url: "/api/members", payload: { name: "Driver" } })).json();
    const project = insertTestProject(ctx.handle.db, { title: "Project", status: "active", ownerMemberId: member.id, dueDate: "2027-01-10", revisitAt: "2027-01-01T10:00:00.000Z" });
    const created = await ctx.app.inject({ method: "POST", url: "/api/tasks", payload: {
      title: "Task", projectId: project.id, status: "actionable", dueDate: "2027-01-09",
      scheduledDate: "2027-01-05", reminders: [{ kind: "absolute", at: "2027-01-01T10:00:00.000Z" }],
    } });
    expect(created.statusCode).toBe(201);
    const wait = await ctx.app.inject({ method: "PUT", url: `/api/tasks/${created.json().id}/external-wait`, payload: { waitingFor: "Supplier", expectedRevision: created.json().revision } });
    expect(wait.statusCode).toBe(200);
    const task = wait.json();
    const stale = await ctx.app.inject({ method: "POST", url: `/api/projects/${project.id}/return-to-backlog`, payload: { expectedRevision: project.revision + 1 } });
    expect(stale.statusCode).toBe(409);
    const parked = await ctx.app.inject({ method: "POST", url: `/api/projects/${project.id}/return-to-backlog`, payload: { expectedRevision: project.revision } });
    expect(parked.statusCode).toBe(200);
    expect(parked.json()).toMatchObject({ status: "backlog", ownerMemberId: null, dueDate: "2027-01-10", revisitAt: "2027-01-01T10:00:00.000Z" });
    const child = await ctx.app.inject({ method: "GET", url: `/api/tasks/${task.id}` });
    expect(child.json()).toMatchObject({ status: "actionable", dueDate: "2027-01-09", scheduledDate: "2027-01-05", revision: task.revision, externalWait: { waitingFor: "Supplier" }, reminders: [{ kind: "absolute", at: "2027-01-01T10:00:00.000Z" }] });
  });

  it("keeps a task's external wait and metadata when explicitly parked", async () => {
    const created = await ctx.app.inject({ method: "POST", url: "/api/tasks", payload: { title: "Waiting", status: "actionable", dueDate: "2027-02-01" } });
    const task = created.json();
    const wait = await ctx.app.inject({ method: "PUT", url: `/api/tasks/${task.id}/external-wait`, payload: { waitingFor: "Reply", expectedRevision: task.revision } });
    expect(wait.statusCode).toBe(200);
    const parked = await ctx.app.inject({ method: "PATCH", url: `/api/tasks/${task.id}`, payload: { status: "someday", expectedRevision: wait.json().revision } });
    expect(parked.statusCode).toBe(200);
    expect(parked.json()).toMatchObject({ status: "someday", dueDate: "2027-02-01", externalWait: { waitingFor: "Reply" } });
    const changed = await ctx.app.inject({ method: "PUT", url: `/api/tasks/${task.id}/external-wait`, payload: { waitingFor: "Updated reply", expectedRevision: parked.json().revision } });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ status: "someday", externalWait: { waitingFor: "Updated reply" } });
    const followed = await ctx.app.inject({ method: "POST", url: `/api/tasks/${task.id}/external-wait/follow-up`, payload: { action: "continue", content: "Asked again", expectedRevision: changed.json().revision } });
    expect(followed.statusCode).toBe(200);
    expect(followed.json()).toMatchObject({ status: "someday", externalWait: { waitingFor: "Updated reply" } });
    const beforeStale = ctx.handle.sqlite.prepare("SELECT count(*) AS count FROM activity_events").get();
    const stale = await ctx.app.inject({ method: "PATCH", url: `/api/tasks/${task.id}`, payload: { title: "stale", expectedRevision: parked.json().revision } });
    expect(stale.statusCode).toBe(409);
    expect(ctx.handle.sqlite.prepare("SELECT count(*) AS count FROM activity_events").get()).toEqual(beforeStale);
    const current = await ctx.app.inject({ method: "GET", url: `/api/tasks/${task.id}` });
    expect(current.json()).toMatchObject({ title: "Waiting", status: "someday", externalWait: { waitingFor: "Updated reply" } });
  });

  it("completes a parked recurrence relative to completion and clears only its occurrence revisit", async () => {
    const created = await ctx.app.inject({ method: "POST", url: "/api/tasks", payload: {
      title: "Recurring", status: "someday", scheduledDate: "2027-01-01",
      repeatAfterDays: 7, allowedDeviationDays: 2, revisitAt: "2027-01-02T10:00:00.000Z",
      needsClarification: true,
    } });
    expect(created.statusCode).toBe(201);
    const marked = await ctx.app.inject({ method: "POST", url: `/api/tasks/${created.json().id}/clarification-revisit`, payload: {
      clarificationRevisitDate: "2999-01-04", expectedRevision: created.json().revision,
    } });
    expect(marked.statusCode).toBe(200);
    expect(marked.json().clarificationRevisitDate).toBe("2999-01-04");
    const task = marked.json();
    const result = await ctx.app.inject({ method: "PATCH", url: `/api/tasks/${task.id}`, payload: {
      status: "done", completedOn: "2027-01-03", expectedRevision: task.revision,
    } });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      status: "someday", scheduledDate: "2027-01-10", dueDate: "2027-01-12",
      revisitAt: null, clarificationRevisitDate: "2999-01-04",
    });
  });

  it("records plans without promoting a task or its backlog project", async () => {
    const project = insertTestProject(ctx.handle.db, { title: "Backlog", status: "backlog" });
    const task = insertTestTask(ctx.handle.db, { title: "Later", projectId: project.id, status: "someday" });
    const result = await ctx.app.inject({ method: "PATCH", url: `/api/tasks/${task.id}`, payload: { dueDate: "2027-02-01", expectedRevision: task.revision } });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ status: "someday", dueDate: "2027-02-01" });
    const projectResult = await ctx.app.inject({ method: "GET", url: `/api/projects/${project.id}` });
    expect(projectResult.json().status).toBe("backlog");
  });

  it("rejects obsolete preview requests without writing", async () => {
    const response = await ctx.app.inject({ method: "POST", url: "/api/tasks", headers: { "x-machbar-preview": "activation" }, payload: { title: "Not created" } });
    expect(response.statusCode).toBe(400);
    expect(ctx.handle.sqlite.prepare("SELECT count(*) AS count FROM work_items").get()).toMatchObject({ count: 0 });
  });

  it("requires reopening terminal work before adding a reminder even with a revisit", async () => {
    const task = insertTestTask(ctx.handle.db, { title: "Done", status: "done", revisitAt: "2027-01-02T10:00:00.000Z" });
    const response = await ctx.app.inject({ method: "PATCH", url: `/api/tasks/${task.id}`, payload: {
      expectedRevision: task.revision, reminders: [{ kind: "absolute", at: "2027-01-03T10:00:00.000Z" }],
    } });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("task_reopen_required");
    expect(ctx.handle.sqlite.prepare("SELECT count(*) AS count FROM task_reminders WHERE task_id = ?").get(task.id)).toMatchObject({ count: 0 });
  });

  it("activates only the selected project with an atomic chosen next action", async () => {
    const member = (await ctx.app.inject({ method: "POST", url: "/api/members", payload: { name: "Driver" } })).json();
    const ancestor = insertTestProject(ctx.handle.db, { title: "Ancestor" });
    const project = insertTestProject(ctx.handle.db, { title: "Selected", parentId: ancestor.id, revisitAt: "2027-01-01T10:00:00.000Z" });
    const url = `/api/projects/${project.id}/activate`;
    const stale = await ctx.app.inject({ method: "POST", url, payload: { expectedRevision: project.revision + 1, ownerMemberId: member.id, nextActionTitle: "First action" } });
    expect(stale.statusCode).toBe(409);
    const result = await ctx.app.inject({ method: "POST", url, payload: { expectedRevision: project.revision, ownerMemberId: member.id, nextActionTitle: "First action" } });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ status: "active", ownerMemberId: member.id, revisitAt: "2027-01-01T10:00:00.000Z" });
    expect(ctx.handle.sqlite.prepare("SELECT status FROM work_items WHERE id = ?").get(ancestor.id)).toMatchObject({ status: "backlog" });
    expect(ctx.handle.sqlite.prepare("SELECT count(*) AS count FROM work_items WHERE parent_id = ? AND title = ?").get(project.id, "First action")).toMatchObject({ count: 1 });
  });
});
