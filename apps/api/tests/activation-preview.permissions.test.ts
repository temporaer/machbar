import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVITY_ACTOR_HEADER } from "@machbar/shared";
import { ChangeNotifier } from "../src/changeNotifier.js";
import { createProject } from "../src/domain/storyCrud.js";
import { createTask } from "../src/domain/taskCrud.js";
import * as schema from "../src/db/schema.js";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

const operations = ["create", "plan", "split", "project-batch", "convert"] as const;
const scopes = ["household", "work", "private"] as const;
const viewers = ["owner", "other", "unknown"] as const;
const modes = ["preview", "commit"] as const;
const cases = modes.flatMap(mode => scopes.flatMap(scope => viewers.flatMap(viewer => operations.map(operation => ({ mode, scope, viewer, operation })))));

describe("activation preview authorization contract", () => {
  let ctx: TestContext;
  const notified = vi.fn();
  beforeEach(() => {
    const notifier = new ChangeNotifier(); notifier.subscribe(notified);
    ctx = createTestContext({ changeNotifier: notifier });
    notified.mockClear();
  });
  afterEach(async () => closeTestContext(ctx));

  it.each(cases)("$mode $operation: $scope / $viewer enforces visibility before any side effects", async ({ mode, scope, viewer, operation }) => {
    const owner = ctx.handle.db.insert(schema.members).values({ name: "Owner", color: "#111111" }).returning().get();
    const other = ctx.handle.db.insert(schema.members).values({ name: "Other", color: "#222222" }).returning().get();
    const project = createProject(ctx.handle.db, {
      title: "Confidential project title", scope: scope === "work" ? "work" : "household",
      // Privacy and driver are deliberately different for durable private work.
      ownerMemberId: scope === "private" ? other.id : owner.id,
    });
    if (scope === "private") ctx.handle.sqlite.prepare("UPDATE work_items SET privacy_owner_member_id = ? WHERE id = ?").run(owner.id, project.id);
    const task = createTask(ctx.handle.db, { title: "Confidential task title", projectId: project.id });
    const actor = viewer === "owner" ? owner.id : viewer === "other" ? other.id : undefined;
    const headers = actor === undefined ? {} : { [ACTIVITY_ACTOR_HEADER]: String(actor) };
    const allowed = scope === "household" || viewer === "owner";
    const source = operation === "create" || operation === "project-batch" ? `/api/projects/${project.id}` : `/api/tasks/${task.id}`;
    expect((await ctx.app.inject({ method: "GET", url: source, headers })).statusCode).toBe(allowed ? 200 : 404);
    const expectedProjectRevisions = [{ projectId: project.id, revision: project.revision }];
    const request = {
      create: { method: "POST", url: "/api/tasks", payload: { title: "New task", projectId: project.id, scheduledDate: "2027-01-15" } },
      plan: { method: "PATCH", url: `/api/tasks/${task.id}`, payload: { expectedRevision: task.revision, scheduledDate: "2027-01-15" } },
      split: { method: "POST", url: `/api/tasks/${task.id}/children/batch`, payload: { expectedRevision: task.revision, expectedProjectRevisions, steps: [{ title: "New step", scheduledDate: "2027-01-15" }] } },
      "project-batch": { method: "POST", url: `/api/projects/${project.id}/tasks/batch`, payload: { expectedRevision: project.revision, expectedProjectRevisions, steps: [{ title: "New step", scheduledDate: "2027-01-15" }] } },
      convert: { method: "POST", url: `/api/tasks/${task.id}/convert-to-story`, payload: { status: "active", expectedRevision: task.revision, expectedDescendantRevisions: [], expectedHierarchyRevisions: [{ id: project.id, revision: project.revision }, { id: task.id, revision: task.revision }] } },
    }[operation] as { method: "POST" | "PATCH"; url: string; payload: object };
    const before = createHash("sha256").update(ctx.handle.sqlite.serialize()).digest("hex");
    notified.mockClear();
    const response = await ctx.app.inject({ ...request, headers: { ...headers, ...(mode === "preview" ? { "x-machbar-preview": "activation" } : {}) } });
    expect(response.statusCode, response.body).toBe(allowed ? mode === "preview" || operation === "plan" ? 200 : 201 : 404);
    if (!allowed) expect(response.body).not.toContain("Confidential");
    if (mode === "preview" || !allowed) {
      expect(createHash("sha256").update(ctx.handle.sqlite.serialize()).digest("hex")).toEqual(before);
      expect(notified).not.toHaveBeenCalled();
    } else expect(notified).toHaveBeenCalledTimes(1);
  });
});
