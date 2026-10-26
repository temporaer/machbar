import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVITY_ACTOR_HEADER } from "@machbar/shared";
import { ChangeNotifier } from "../src/changeNotifier.js";
import { createSession } from "../src/auth/repository.js";
import { SESSION_COOKIE } from "../src/auth/routes.js";
import { createProject } from "../src/domain/storyCrud.js";
import { createTask } from "../src/domain/taskCrud.js";
import * as schema from "../src/db/schema.js";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

const operations = ["task-update", "task-delete", "task-move", "project-update", "project-delete", "project-move", "move-to-hidden-project", "depend-on-hidden-task"] as const;
const cases = ["work", "private"].flatMap(scope => ["other", "unknown"].flatMap(viewer => operations.map(operation => ({ scope, viewer, operation }))));

describe("hidden work-item writes are rejected before mutation", () => {
  let ctx: TestContext;
  const notified = vi.fn();
  beforeEach(() => { const notifier = new ChangeNotifier(); notifier.subscribe(notified); ctx = createTestContext({ changeNotifier: notifier }); });
  afterEach(async () => closeTestContext(ctx));
  it.each(cases)("$scope / $viewer / $operation", async ({ scope, viewer, operation }) => {
    const member = (name: string) => ctx.handle.db.insert(schema.members).values({ name, color: "#111111" }).returning().get();
    const owner = member("Owner"), other = member("Other");
    const project = createProject(ctx.handle.db, { title: "Hidden", scope: scope === "work" ? "work" : "household", ownerMemberId: owner.id });
    if (scope === "private") ctx.handle.sqlite.prepare("UPDATE work_items SET privacy_owner_member_id = ? WHERE id = ?").run(owner.id, project.id);
    const task = createTask(ctx.handle.db, { title: "Hidden child", projectId: project.id });
    const publicTask = createTask(ctx.handle.db, { title: "Public source" });
    const headers = viewer === "other" ? { [ACTIVITY_ACTOR_HEADER]: String(other.id) } : {};
    const requests = {
      "task-update": { method: "PATCH", url: `/api/tasks/${task.id}`, payload: { title: "Unauthorized", expectedRevision: task.revision } },
      "task-delete": { method: "DELETE", url: `/api/tasks/${task.id}` },
      "task-move": { method: "POST", url: `/api/tasks/${task.id}/move`, payload: { projectId: null, parentTaskId: null, expectedRevision: task.revision } },
      "project-update": { method: "PATCH", url: `/api/projects/${project.id}`, payload: { title: "Unauthorized", expectedRevision: project.revision } },
      "project-delete": { method: "DELETE", url: `/api/projects/${project.id}?deleteTasks=true` },
      "project-move": { method: "POST", url: `/api/projects/${project.id}/move`, payload: { parentId: null, expectedRevision: project.revision, expectedHierarchyRevisions: [{ id: project.id, revision: project.revision }] } },
      "move-to-hidden-project": { method: "POST", url: `/api/tasks/${publicTask.id}/move`, payload: { projectId: project.id, expectedRevision: publicTask.revision } },
      "depend-on-hidden-task": { method: "POST", url: `/api/tasks/${publicTask.id}/dependencies`, payload: { dependsOnTaskId: task.id, expectedRevision: publicTask.revision } },
    } as const;
    const before = createHash("sha256").update(ctx.handle.sqlite.serialize()).digest("hex"); notified.mockClear();
    const response = await ctx.app.inject({ ...requests[operation], headers });
    expect(response.statusCode, response.body).toBe(404);
    expect(createHash("sha256").update(ctx.handle.sqlite.serialize()).digest("hex")).toBe(before);
    expect(notified).not.toHaveBeenCalled();
  });
});

describe("authenticated viewer wins over a spoofed actor", () => {
  let ctx: TestContext;
  afterEach(async () => closeTestContext(ctx));
  it.each(["work", "private"])("protects %s writes using the session identity", async scope => {
    ctx = createTestContext({ oidc: { issuerUrl: "https://id.example", clientId: "test", clientSecret: "test", publicUrl: "https://app.example", sessionTtlDays: 30 } });
    const member = (name: string) => ctx.handle.db.insert(schema.members).values({ name, color: "#111111" }).returning().get();
    const owner = member("Owner"), other = member("Other");
    const task = createTask(ctx.handle.db, { title: "Original", scope: scope === "work" ? "work" : "household", ownerMemberId: owner.id, ownerInheritanceMode: "explicit", ...(scope === "private" ? { privacyOwnerMemberId: owner.id } : {}) });
    const session = createSession(ctx.handle.db, other.id, 30);
    const response = await ctx.app.inject({ method: "PATCH", url: `/api/tasks/${task.id}`, headers: { cookie: `${SESSION_COOKIE}=${session.token}`, origin: "https://app.example", [ACTIVITY_ACTOR_HEADER]: String(owner.id) }, payload: { title: "Spoofed", expectedRevision: task.revision } });
    expect(response.statusCode, response.body).toBe(404);
    expect(ctx.handle.sqlite.prepare("SELECT title, revision FROM work_items WHERE id = ?").get(task.id)).toEqual({ title: "Original", revision: task.revision });
    const ownerSession = createSession(ctx.handle.db, owner.id, 30);
    const allowed = await ctx.app.inject({ method: "PATCH", url: `/api/tasks/${task.id}`, headers: { cookie: `${SESSION_COOKIE}=${ownerSession.token}`, origin: "https://app.example", [ACTIVITY_ACTOR_HEADER]: String(other.id) }, payload: { title: "Owner edit", expectedRevision: task.revision } });
    expect(allowed.statusCode, allowed.body).toBe(200);
    expect(allowed.json().title).toBe("Owner edit");
  });

  describe("task commitments authorize every project they activate", () => {
    let ctx: TestContext;
    afterEach(async () => closeTestContext(ctx));
    it.each([
      { projectOwner: "viewer", ancestorOwner: "viewer", expectedStatus: 200 },
      { projectOwner: "other", ancestorOwner: "viewer", expectedStatus: 404 },
      { projectOwner: "viewer", ancestorOwner: "other", expectedStatus: 404 },
    ])("checks project owner $projectOwner and ancestor owner $ancestorOwner", async ({ projectOwner, ancestorOwner, expectedStatus }) => {
      ctx = createTestContext();
      const member = (name: string) => ctx.handle.db.insert(schema.members).values({ name, color: "#111111" }).returning().get();
      const viewer = member("Viewer"), other = member("Other");
      const ownerId = (owner: string) => owner === "viewer" ? viewer.id : other.id;
      const ancestor = createProject(ctx.handle.db, { title: "Ancestor", scope: "work", ownerMemberId: ownerId(ancestorOwner) });
      const project = createProject(ctx.handle.db, { title: "Project", parentId: ancestor.id, ownerMemberId: ownerId(projectOwner) });
      const task = createTask(ctx.handle.db, {
        title: "Task owned by viewer",
        projectId: project.id,
        ownerMemberId: viewer.id,
        ownerInheritanceMode: "explicit",
      });
      const before = createHash("sha256").update(ctx.handle.sqlite.serialize()).digest("hex");
      const response = await ctx.app.inject({
        method: "PATCH",
        url: `/api/tasks/${task.id}`,
        headers: { [ACTIVITY_ACTOR_HEADER]: String(viewer.id) },
        payload: { scheduledDate: "2026-10-27", expectedRevision: task.revision },
      });
      expect(response.statusCode, response.body).toBe(expectedStatus);
      if (expectedStatus === 404) {
        expect(createHash("sha256").update(ctx.handle.sqlite.serialize()).digest("hex")).toBe(before);
      } else {
        expect(response.json().scheduledDate).toBe("2026-10-27");
      }
    });
  });
});
