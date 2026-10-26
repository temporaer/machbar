import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProject } from "../src/domain/storyCrud.js";
import { createTask } from "../src/domain/taskCrud.js";
import { previewActivation } from "../src/domain/activationPreview.js";
import { AppError } from "../src/errors.js";
import { ChangeNotifier } from "../src/changeNotifier.js";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

describe("canonical activation previews", () => {
  let ctx: TestContext;
  const notified = vi.fn();
  beforeEach(() => { const notifier = new ChangeNotifier(); notifier.subscribe(notified); ctx = createTestContext({ changeNotifier: notifier }); notified.mockClear(); });
  afterEach(async () => closeTestContext(ctx));
  const preview = (url: string, payload: object, method: "POST" | "PATCH" = "POST") => ctx.app.inject({ method, url, payload, headers: { "x-machbar-preview": "activation" } });
  async function project(ownerMemberId?: number) {
    return (await ctx.app.inject({ method: "POST", url: "/api/projects", payload: { title: "Project", ...(ownerMemberId ? { ownerMemberId } : {}) } })).json();
  }
  function snapshot() {
    const tables = ctx.handle.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
    return tables.map(({ name }) => [name, ctx.handle.sqlite.prepare(`SELECT * FROM "${name}"`).all()]);
  }
  it("evaluates proposed batch work before asking only for the missing driver, without writes or notifications", async () => {
    const target = await project();
    const input = { expectedRevision: target.revision, expectedProjectRevisions: [{ projectId: target.id, revision: target.revision }], steps: [{ title: "Actual next action", scheduledDate: "2027-01-15" }, { title: "Second action" }] };
    const before = snapshot(); notified.mockClear();
    const result = await preview(`/api/projects/${target.id}/tasks/batch`, input);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().decision.projects).toMatchObject([{ projectId: target.id, required: ["driver"] }]);
    expect(snapshot()).toEqual(before);
    expect(notified).not.toHaveBeenCalled();
    const member = (await ctx.app.inject({ method: "POST", url: "/api/members", payload: { name: "Mira" } })).json();
    const saved = await ctx.app.inject({ method: "POST", url: `/api/projects/${target.id}/tasks/batch`, payload: { ...input, activationResolution: { expectedProjects: result.json().decision.expectedProjects, drivers: [{ projectId: target.id, ownerMemberId: member.id }] } } });
    expect(saved.statusCode, saved.body).toBe(201);
    expect(saved.json().tasks.map((task: { title: string }) => task.title)).toEqual(["Actual next action", "Second action"]);
    expect(saved.json().project.status).toBe("active");
  });
  it("rolls back a ready preview, including activity and contribution writes, then allows one final creation", async () => {
    const member = (await ctx.app.inject({ method: "POST", url: "/api/members", payload: { name: "Mira" } })).json();
    const target = await project(member.id);
    const input = { title: "Scheduled task", projectId: target.id, scheduledDate: "2027-01-15" };
    const before = snapshot(); notified.mockClear();
    const result = await preview("/api/tasks", input);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toMatchObject({ decision: null, activatingProjects: [{ id: target.id }] });
    expect(snapshot()).toEqual(before); expect(notified).not.toHaveBeenCalled();
    const saved = await ctx.app.inject({ method: "POST", url: "/api/tasks", payload: input });
    expect(saved.statusCode, saved.body).toBe(201);
    const detail = (await ctx.app.inject({ method: "GET", url: `/api/projects/${target.id}` })).json();
    expect(detail.tasks).toHaveLength(1);
    expect(detail.status).toBe("active");
  });
  it("uses current revisions for planning previews and leaves the task unchanged", async () => {
    const target = await project();
    const task = (await ctx.app.inject({ method: "POST", url: "/api/tasks", payload: { title: "Plan me", projectId: target.id } })).json();
    const before = snapshot();
    const result = await preview(`/api/tasks/${task.id}`, { scheduledDate: "2027-01-15", expectedRevision: task.revision }, "PATCH");
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().decision.projects[0].required).toEqual(["driver"]);
    expect(snapshot()).toEqual(before);
    const stale = await preview(`/api/tasks/${task.id}`, { dueDate: "2027-01-15", expectedRevision: 999 }, "PATCH");
    expect(stale.statusCode).toBe(409); expect(stale.json().error.code).toBe("stale_write_conflict");
    expect(snapshot()).toEqual(before);
  });
  it("preserves conversion semantics while previewing the preserved progress step", async () => {
    const task = (await ctx.app.inject({ method: "POST", url: "/api/tasks", payload: { title: "Convert me", status: "actionable" } })).json();
    const before = snapshot();
    const result = await preview(`/api/tasks/${task.id}/convert-to-story`, { status: "active", preservedStepTitle: "Preserved work", expectedRevision: task.revision, expectedDescendantRevisions: [], dependencyMappings: [] });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().decision.projects[0].required).toEqual(["driver"]);
    expect(snapshot()).toEqual(before);
  });
  it("rejects hidden preview destinations and sources without leaking titles or writing", async () => {
    const member = (await ctx.app.inject({ method: "POST", url: "/api/members", payload: { name: "Owner" } })).json();
    const hidden = createProject(ctx.handle.db, { title: "Private work secret", scope: "work", ownerMemberId: member.id });
    const child = createTask(ctx.handle.db, { title: "Private child", projectId: hidden.id });
    const before = snapshot();
    expect((await ctx.app.inject({ method: "GET", url: `/api/projects/${hidden.id}` })).statusCode).toBe(404);
    for (const [url, payload, method] of [
      ["/api/tasks", { title: "New", projectId: hidden.id, scheduledDate: "2027-01-15" }, "POST"],
      [`/api/tasks/${child.id}`, { scheduledDate: "2027-01-15", expectedRevision: child.revision }, "PATCH"],
      [`/api/tasks/${child.id}/children/batch`, { steps: [{ title: "New" }], expectedProjectRevisions: [], expectedRevision: child.revision }, "POST"],
      [`/api/projects/${hidden.id}/tasks/batch`, { steps: [{ title: "New" }], expectedProjectRevisions: [], expectedRevision: hidden.revision }, "POST"],
      [`/api/tasks/${child.id}/convert-to-story`, { status: "active", expectedRevision: child.revision }, "POST"],
    ] as const) {
      const response = await preview(url, payload, method);
      expect(response.statusCode, response.body).toBe(404);
      expect(response.body).not.toContain("Private");
      expect(snapshot()).toEqual(before);
    }
    // Both successful activation output and canonical decision snapshots are guarded,
    // even if a caller omitted an affected ancestor from its source list.
    for (const ownerMemberId of [member.id, undefined]) {
      const target = createProject(ctx.handle.db, { title: "Another secret", scope: "work", ...(ownerMemberId ? { ownerMemberId } : {}) });
      expect(() => previewActivation(ctx.handle.db, () => createTask(ctx.handle.db, {
        title: "Dated", projectId: target.id, scheduledDate: "2027-01-15",
      }), undefined, [])).toThrow(AppError);
    }
  });
  it("returns the same canonical 409 for an unnecessary driver assignment", async () => {
    const member = (await ctx.app.inject({ method: "POST", url: "/api/members", payload: { name: "Mira" } })).json();
    const target = await project(member.id);
    const input = { title: "Dated", projectId: target.id, scheduledDate: "2027-01-15", activationResolution: {
      expectedProjects: [{ projectId: target.id, revision: target.revision }],
      drivers: [{ projectId: target.id, ownerMemberId: member.id }],
    } };
    const before = snapshot();
    const response = await preview("/api/tasks", input);
    const canonical = await ctx.app.inject({ method: "POST", url: "/api/tasks", payload: input });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual(canonical.json());
    expect(response.json().error.details).toEqual({ reason: "invalid_project_decision" });
    expect(snapshot()).toEqual(before);
  });
  it("preserves canonical conflicts without decision snapshot arrays", () => {
    const error = AppError.conflict("project_commitment_resolution_required", "Invalid decision", { reason: "invalid_project_decision" });
    expect(() => previewActivation(ctx.handle.db, () => { throw error; }, undefined, [])).toThrow(error);
  });

});
