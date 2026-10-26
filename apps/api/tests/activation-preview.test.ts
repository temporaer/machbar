import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
});
