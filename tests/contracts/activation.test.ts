import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "../../apps/web/src/lib/api";
import { setRequestActorMemberId } from "../../apps/web/src/lib/identityStorage";
import { isStaleWriteConflict } from "../../apps/web/src/lib/errorMessage";
import { closeTestContext, createTestContext, type TestContext } from "../../apps/api/tests/helpers";
import * as schema from "../../apps/api/src/db/schema";
import { enqueueDueReminders } from "../../apps/api/src/notifications/outbox";
import { dispatchNotificationEvents, type PushTransport } from "../../apps/api/src/notifications/delivery";

// Only HTTP transport is replaced: the web client and serialized server are real.
describe("web/API activation contract", () => {
  let ctx: TestContext;
  const databaseHash = () => createHash("sha256").update(ctx.handle.sqlite.serialize()).digest("hex");
  beforeEach(() => {
    ctx = createTestContext();
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      const response = await ctx.app.inject({
        method: init.method as "GET" | "POST" | "PATCH" ?? "GET", url,
        headers: Object.fromEntries(new Headers(init.headers)),
        ...(typeof init.body === "string" ? { payload: init.body } : {}),
      });
      return new Response(response.body, { status: response.statusCode, headers: { "content-type": "application/json" } });
    });
  });
  afterEach(async () => { setRequestActorMemberId(null); vi.unstubAllGlobals(); await closeTestContext(ctx); });

  it("creates and edits planned backlog work without activating or losing its data", async () => {
    const member = await api.createMember({ name: "Mira" });
    setRequestActorMemberId(member.id);
    const project = await api.createProject({ title: "Backlog", notes: "Keep project notes" }, {});
    const task = await api.createTask({
      title: "Planned task", projectId: project.id, status: "someday",
      scheduledDate: "2027-01-15", notes: "Keep task notes",
    }, {});
    expect(task).toMatchObject({ status: "someday", scheduledDate: "2027-01-15", notes: "Keep task notes", executable: false });
    const edited = await api.updateTask(task.id, { dueDate: "2027-02-01", expectedRevision: task.revision });
    expect(edited).toMatchObject({ status: "someday", scheduledDate: "2027-01-15", dueDate: "2027-02-01", notes: "Keep task notes", executable: false });
    expect(await api.getProject(project.id)).toMatchObject({ status: "backlog", notes: "Keep project notes", tasks: [{ id: task.id, status: "someday" }] });
  });

  it("recognizes a serialized stale task write and retries the draft after refreshing", async () => {
    const project = await api.createProject({ title: "Backlog" }, {});
    const task = await api.createTask({ title: "Original", projectId: project.id, status: "someday" }, {});
    await api.updateTask(task.id, { title: "Changed elsewhere", expectedRevision: task.revision });
    const before = databaseHash();
    const error = await api.updateTask(task.id, { title: "Authored draft", scheduledDate: "2027-01-15", expectedRevision: task.revision }).catch(error => error);
    expect(error).toBeInstanceOf(ApiError);
    expect(isStaleWriteConflict(error)).toBe(true);
    expect(databaseHash()).toBe(before);
    const fresh = await api.getTask(task.id);
    const saved = await api.updateTask(task.id, { title: "Authored draft", scheduledDate: "2027-01-15", expectedRevision: fresh.revision });
    expect(saved).toMatchObject({ id: task.id, title: "Authored draft", status: "someday", revision: fresh.revision + 1 });
    expect((await api.getProject(project.id)).status).toBe("backlog");
  });

  it("converts a captured task to a backlog project without losing its identity or authored content", async () => {
    const member = await api.createMember({ name: "Mira" });
    setRequestActorMemberId(member.id);
    const task = await api.createTask({ title: "Captured project", notes: "Authored notes", status: "captured" }, {});
    const project = await api.convertTaskToStory(task.id, {
      status: "backlog", expectedRevision: task.revision, expectedDescendantRevisions: [], dependencyMappings: [],
    });
    expect(project).toMatchObject({ id: task.id, title: "Captured project", notes: "Authored notes", status: "backlog" });
    expect(await api.getProject(project.id)).toMatchObject({ id: task.id, status: "backlog" });
  });

  it("converts owned actionable work to an active project while preserving its action", async () => {
    const member = await api.createMember({ name: "Mira" });
    setRequestActorMemberId(member.id);
    const task = await api.createTask({
      title: "Project-shaped action", status: "actionable", ownerMemberId: member.id, ownerInheritanceMode: "explicit",
    }, {});
    const project = await api.convertTaskToStory(task.id, { status: "active", expectedRevision: task.revision });
    expect(project).toMatchObject({ id: task.id, status: "active", ownerMemberId: member.id });
    expect((await api.getProject(project.id)).tasks).toMatchObject([{ title: "Project-shaped action", status: "actionable" }]);
  });

  it.each(["actionable", "someday"] as const)("enqueues and dispatches reminders for %s work in a backlog project", async status => {
    const member = await api.createMember({ name: "Mira" });
    setRequestActorMemberId(member.id);
    const project = await api.createProject({ title: "Parked project" }, {});
    const task = await api.createTask({
      title: "Remember", projectId: project.id, status, ownerMemberId: member.id, ownerInheritanceMode: "explicit",
      reminders: [{ kind: "absolute", at: "2026-09-01T08:00:00.000Z" }],
    }, {});
    ctx.handle.db.insert(schema.pushSubscriptions).values({
      endpoint: "https://push.example/parked", memberId: member.id, p256dh: "key", auth: "auth", locale: "de",
    }).run();
    const send = vi.fn<PushTransport["send"]>().mockResolvedValue(undefined);
    expect(enqueueDueReminders(ctx.handle.db, new Date("2026-09-01T09:00:00Z"))).toBe(1);
    expect(enqueueDueReminders(ctx.handle.db, new Date("2026-09-01T09:00:00Z"))).toBe(0);
    await dispatchNotificationEvents(ctx.handle.db, { send }, { error: vi.fn() });
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(send.mock.calls[0]![1])).toMatchObject({ kind: "task_reminder", entity: { type: "task", id: task.id } });
    expect(await api.getTask(task.id)).toMatchObject({ status, executable: false });
    expect((await api.getProject(project.id)).status).toBe("backlog");
  });

  it("advances recurring work from its actual completion date while the project remains parked", async () => {
    const project = await api.createProject({ title: "Parked project" }, {});
    const task = await api.createTask({
      title: "Recurring", projectId: project.id, status: "someday", scheduledDate: "2026-08-20",
      repeatAfterDays: 7, allowedDeviationDays: 2,
    }, {});
    const completed = await api.completeTask(task.id, "leave_open", "2026-08-23", task.revision);
    expect(completed).toMatchObject({ id: task.id, status: "someday", scheduledDate: "2026-08-30", dueDate: "2026-09-01", repeatAfterDays: 7, executable: false });
    expect((await api.getProject(project.id)).status).toBe("backlog");
    const history = await api.getTaskRecurrenceHistory(task.id);
    expect(history.occurrences).toEqual(expect.arrayContaining([expect.objectContaining({
      scheduledDate: "2026-08-20", completedOn: "2026-08-23", result: "miss",
    })]));
  });

  it("uses direct readiness and activates only the selected project after stale and missing-decision errors", async () => {
    const member = await api.createMember({ name: "Mira" });
    setRequestActorMemberId(member.id);
    const ancestor = await api.createProject({ title: "Ancestor" }, {});
    const project = await api.createProject({ title: "Selected", parentId: ancestor.id }, {});
    const detail = await api.getProject(project.id);
    expect(detail.activationReadiness.requiredDecisions).toEqual(expect.arrayContaining(["driver", "progressPath"]));
    const before = databaseHash();
    const stale = await api.activateProject(project.id, { expectedRevision: detail.revision + 1, ownerMemberId: member.id, nextActionTitle: "First action" }).catch(error => error);
    expect(stale).toBeInstanceOf(ApiError);
    expect(isStaleWriteConflict(stale)).toBe(true);
    expect(databaseHash()).toBe(before);
    const missingDriver = await api.activateProject(project.id, { expectedRevision: detail.revision }).catch(error => error);
    expect(missingDriver).toMatchObject({ status: 400, code: "project_driver_required" });
    expect(databaseHash()).toBe(before);
    const missingPath = await api.activateProject(project.id, { expectedRevision: detail.revision, ownerMemberId: member.id }).catch(error => error);
    expect(missingPath).toMatchObject({ status: 409, code: "project_activation_not_ready" });
    expect(databaseHash()).toBe(before);
    const saved = await api.activateProject(project.id, { expectedRevision: detail.revision, ownerMemberId: member.id, nextActionTitle: "First action" });
    expect(saved).toMatchObject({ id: project.id, status: "active", ownerMemberId: member.id });
    expect((await api.getProject(ancestor.id)).status).toBe("backlog");
    const activated = await api.getProject(project.id);
    expect(activated.tasks).toMatchObject([{ title: "First action", executable: false }]);
  });

  it("hides private work from another or unknown actor on reads and attempted writes", async () => {
    const owner = await api.createMember({ name: "Owner" });
    const other = await api.createMember({ name: "Other" });
    setRequestActorMemberId(owner.id);
    const project = await api.createProject({ title: "Secret title", scope: "work", ownerMemberId: owner.id }, {});
    const task = await api.createTask({ title: "Secret task", projectId: project.id, status: "someday" }, {});
    const before = databaseHash();
    for (const actor of [other.id, null]) {
      setRequestActorMemberId(actor);
      for (const attempt of [
        () => api.getProject(project.id),
        () => api.createTask({ title: "Unauthorized", projectId: project.id, scheduledDate: "2027-01-15" }, {}),
        () => api.updateTask(task.id, { title: "Unauthorized", expectedRevision: task.revision }),
        () => api.activateProject(project.id, { expectedRevision: project.revision, ownerMemberId: owner.id, nextActionTitle: "Unauthorized" }),
      ]) {
        const error = await attempt().catch(error => error);
        expect(error).toBeInstanceOf(ApiError);
        expect(error.status).toBe(404);
        expect(JSON.stringify(error)).not.toContain("Secret");
      }
    }
    expect(databaseHash()).toBe(before);
  });
});
