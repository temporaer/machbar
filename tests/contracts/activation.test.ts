import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "../../apps/web/src/lib/api";
import { setRequestActorMemberId } from "../../apps/web/src/lib/identityStorage";
import { isStaleWriteConflict } from "../../apps/web/src/lib/errorMessage";
import { projectActivationPromptFromError, projectActivationPromptFromSnapshot, projectActivationResolutionFromPrompt } from "../../apps/web/src/lib/projectActivationResolution";
import { closeTestContext, createTestContext, type TestContext } from "../../apps/api/tests/helpers";

// Only HTTP transport is replaced. Routing, validation, domain mutations,
// migrations, serialization and the web client's error parsing are all real.
describe("web/API activation contract", () => {
  let ctx: TestContext;
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

  it("uses real missing-driver requirements and commits the proposed task exactly once", async () => {
    const member = await api.createMember({ name: "Mira" });
    const project = await api.createProject({ title: "Actual project" });
    const input = { title: "Actual next step", projectId: project.id, scheduledDate: "2027-01-15" };
    const before = createHash("sha256").update(ctx.handle.sqlite.serialize()).digest("hex");
    const preview = await api.previewTaskCreation(input);
    const prompt = projectActivationPromptFromSnapshot(preview.decision);
    expect(prompt.projects).toMatchObject([{ projectId: project.id, required: ["driver"] }]);
    expect(projectActivationResolutionFromPrompt(prompt)).toBeNull();
    expect(createHash("sha256").update(ctx.handle.sqlite.serialize()).digest("hex")).toEqual(before);
    const conflict = await api.createTask(input).catch(error => error);
    expect(conflict).toBeInstanceOf(ApiError);
    expect(projectActivationPromptFromError(conflict)).toEqual(prompt);
    expect(createHash("sha256").update(ctx.handle.sqlite.serialize()).digest("hex")).toEqual(before);
    const activationResolution = projectActivationResolutionFromPrompt({ ...prompt, selectedDrivers: { [project.id]: member.id } })!;
    const saved = await api.createTask({ ...input, activationResolution });
    expect(saved.title).toBe(input.title);
    const detail = await api.getProject(project.id);
    expect(detail.status).toBe("active");
    expect(detail.tasks.map(task => task.id)).toEqual([saved.id]);
  });

  it("uses the server's conversion progress-path and driver decisions without losing the authored next step", async () => {
    const member = await api.createMember({ name: "Mira" });
    const task = await api.createTask({ title: "Captured project", status: "captured" });
    const input = { status: "active" as const, expectedRevision: task.revision, expectedDescendantRevisions: [], dependencyMappings: [] };
    const before = createHash("sha256").update(ctx.handle.sqlite.serialize()).digest("hex");
    const preview = await api.previewTaskConversion(task.id, input);
    const prompt = projectActivationPromptFromSnapshot(preview.decision);
    expect(prompt.projects).toMatchObject([{ projectId: task.id, required: ["driver", "progressPath"] }]);
    expect(projectActivationResolutionFromPrompt(prompt)).toBeNull();
    expect(createHash("sha256").update(ctx.handle.sqlite.serialize()).digest("hex")).toEqual(before);
    const activationResolution = projectActivationResolutionFromPrompt({ ...prompt, selectedDrivers: { [task.id]: member.id }, nextActionTitle: "Authored next step" })!;
    const project = await api.convertTaskToStory(task.id, { ...input, activationResolution });
    const detail = await api.getProject(project.id);
    expect(detail.status).toBe("active");
    expect(detail.tasks.map(task => task.title)).toEqual(["Authored next step"]);
    expect(project.id).toBe(task.id);
  });

  it("parses a ready preview without inventing required decisions", async () => {
    const member = await api.createMember({ name: "Mira" });
    const project = await api.createProject({ title: "Ready", ownerMemberId: member.id });
    const preview = await api.previewTaskCreation({ title: "Next", projectId: project.id, scheduledDate: "2027-01-15" });
    expect(preview).toEqual({ decision: null, activatingProjects: [{ id: project.id, title: project.title }] });
    expect(projectActivationPromptFromSnapshot(preview.decision).projects).toEqual([]);
    expect((await api.getProject(project.id)).tasks).toEqual([]);
  });

  it("keeps real non-snapshot conflicts distinct from decision prompts", async () => {
    const member = await api.createMember({ name: "Mira" });
    const project = await api.createProject({ title: "Owned", ownerMemberId: member.id });
    const error = await api.previewTaskCreation({ title: "Next", projectId: project.id, scheduledDate: "2027-01-15", activationResolution: {
      expectedProjects: [{ projectId: project.id, revision: project.revision }], drivers: [{ projectId: project.id, ownerMemberId: member.id }],
    } }).catch(error => error);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: "project_commitment_resolution_required", details: { reason: "invalid_project_decision" } });
    expect(projectActivationPromptFromError(error)).toBeNull();
    expect((await api.getProject(project.id)).tasks).toEqual([]);
  });

  it("recognizes a real stale revision and can retry after refreshing without a duplicate", async () => {
    const task = await api.createTask({ title: "Original" });
    await api.updateTask(task.id, { title: "Changed elsewhere", expectedRevision: task.revision });
    const error = await api.previewTaskUpdate(task.id, { title: "Authored draft", expectedRevision: task.revision }).catch(error => error);
    expect(error).toBeInstanceOf(ApiError);
    expect(isStaleWriteConflict(error)).toBe(true);
    expect(projectActivationPromptFromError(error)).toBeNull();
    const fresh = await api.getTask(task.id);
    const saved = await api.updateTask(task.id, { title: "Authored draft", expectedRevision: fresh.revision });
    expect(saved).toMatchObject({ id: task.id, title: "Authored draft", revision: fresh.revision + 1 });
  });

  it("carries the selected actor through the real client and hides another member's work", async () => {
    const owner = await api.createMember({ name: "Owner" });
    const other = await api.createMember({ name: "Other" });
    setRequestActorMemberId(owner.id);
    const project = await api.createProject({ title: "Secret title", scope: "work", ownerMemberId: owner.id });
    const input = { title: "Next", projectId: project.id, scheduledDate: "2027-01-15" };
    const before = createHash("sha256").update(ctx.handle.sqlite.serialize()).digest("hex");
    expect((await api.previewTaskCreation(input)).activatingProjects).toHaveLength(1);
    for (const actor of [other.id, null]) {
      setRequestActorMemberId(actor);
      const error = await api.previewTaskCreation(input).catch(error => error);
      expect(error).toBeInstanceOf(ApiError);
      expect(error.status).toBe(404);
      expect(JSON.stringify(error)).not.toContain(project.title);
      expect(projectActivationPromptFromError(error)).toBeNull();
    }
    expect(createHash("sha256").update(ctx.handle.sqlite.serialize()).digest("hex")).toEqual(before);
  });
});
