import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACTIVITY_ACTOR_HEADER } from "@machbar/shared";
import * as schema from "../src/db/schema.js";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

describe("creation receipt transaction and authorization", () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = createTestContext(); });
  afterEach(async () => closeTestContext(ctx));
  const digest = () => createHash("sha256").update(ctx.handle.sqlite.serialize()).digest("hex");
  it.each(["tasks", "projects"])("does not resurrect deleted %s or reuse a key for changed content", async route => {
    const request = { method: "POST" as const, url: `/api/${route}`, headers: { "idempotency-key": `receipt_${route}_0001` }, payload: { title: "Original" } };
    const created = await ctx.app.inject(request); expect(created.statusCode).toBe(201);
    const before = digest();
    const changed = await ctx.app.inject({ ...request, payload: { title: "Changed" } });
    expect(changed.statusCode).toBe(409); expect(digest()).toBe(before);
    expect((await ctx.app.inject({ method: "DELETE", url: `/api/${route}/${created.json().id}` })).statusCode).toBe(204);
    const deleted = digest();
    const retry = await ctx.app.inject(request);
    expect(retry.statusCode).toBe(404);
    expect(retry.json().error.code).toBe(route === "projects" ? "project_not_found" : "task_not_found");
    expect(digest()).toBe(deleted);
  });
  it.each(["tasks", "projects"])("does not commit an invisible root %s creation or a receipt", async route => {
    const owner = ctx.handle.db.insert(schema.members).values({ name: "Owner", color: "#111111" }).returning().get();
    const before = digest();
    const response = await ctx.app.inject({ method: "POST", url: `/api/${route}`, headers: { "idempotency-key": "invisible_root_0001" }, payload: { title: "Hidden", scope: "work", ownerMemberId: owner.id, ...(route === "tasks" ? { ownerInheritanceMode: "explicit" } : {}) } });
    expect(response.statusCode).toBe(404); expect(digest()).toBe(before);
  });
  it("reauthorizes an existing receipt if the item becomes invisible", async () => {
    const owner = ctx.handle.db.insert(schema.members).values({ name: "Owner", color: "#111111" }).returning().get();
    const request = { method: "POST" as const, url: "/api/tasks", headers: { "idempotency-key": "visibility_request_0001" }, payload: { title: "Original" } };
    const created = await ctx.app.inject(request);
    const update = await ctx.app.inject({ method: "PATCH", url: `/api/tasks/${created.json().id}`, headers: { [ACTIVITY_ACTOR_HEADER]: String(owner.id) }, payload: { scope: "work", ownerMemberId: owner.id, ownerInheritanceMode: "explicit", expectedRevision: created.json().revision } });
    expect(update.statusCode).toBe(200);
    const before = digest();
    expect((await ctx.app.inject(request)).statusCode).toBe(404); expect(digest()).toBe(before);
  });
  it("does not retain a receipt for a failed canonical creation", async () => {
    const response = await ctx.app.inject({ method: "POST", url: "/api/tasks", headers: { "idempotency-key": "invalid_request_0001" }, payload: { title: "Bad", projectId: 9999 } });
    expect(response.statusCode).toBe(404);
    expect(ctx.handle.sqlite.prepare("SELECT count(*) AS n FROM creation_receipts").get()).toEqual({ n: 0 });
  });
  it("returns the committed projection for scheduled project work with inherited and explicit metadata", async () => {
    const owner = ctx.handle.db.insert(schema.members).values({ name: "Owner", color: "#111111" }).returning().get();
    const inheritedTag = ctx.handle.db.insert(schema.tags).values({ name: "Inherited" }).returning().get();
    const taskTag = ctx.handle.db.insert(schema.tags).values({ name: "Task" }).returning().get();
    const context = ctx.handle.db.insert(schema.physicalContexts).values({ source: "home_assistant", externalId: "room", name: "Room" }).returning().get();
    const projectResponse = await ctx.app.inject({ method: "POST", url: "/api/projects", payload: { title: "Project", ownerMemberId: owner.id, tagIds: [inheritedTag.id] } });
    expect(projectResponse.statusCode, projectResponse.body).toBe(201);
    const project = projectResponse.json();
    const request = {
      method: "POST" as const, url: "/api/tasks",
      headers: { "idempotency-key": "scheduled_task_0001" },
      payload: { title: "Scheduled", projectId: project.id, status: "someday", tagIds: [taskTag.id], contextIds: [context.id], contextInheritanceMode: "explicit", scheduledDate: "2027-01-15", reminders: [{ kind: "absolute", at: "2027-01-15T09:00:00.000Z" }] },
    };
    const created = await ctx.app.inject(request);
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({
      status: "actionable", scheduledDate: "2027-01-15", effectiveOwnerId: owner.id,
      effectiveTags: expect.arrayContaining([expect.objectContaining({ id: inheritedTag.id }), expect.objectContaining({ id: taskTag.id })]),
      effectiveContexts: [expect.objectContaining({ id: context.id })],
      reminders: [expect.objectContaining({ at: "2027-01-15T09:00:00.000Z" })],
    });
    expect((await ctx.app.inject({ method: "GET", url: `/api/projects/${project.id}` })).json().status).toBe("active");
    const read = await ctx.app.inject({ method: "GET", url: `/api/tasks/${created.json().id}` });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json()).toEqual(created.json());
    const replay = await ctx.app.inject(request);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toEqual(read.json());
  });
  it.each(["tasks", "projects"])("rejects a %s receipt after role conversion without side effects", async route => {
    const request = { method: "POST" as const, url: `/api/${route}`, headers: { "idempotency-key": `converted_${route}_0001` }, payload: { title: "Converted work item" } };
    const created = await ctx.app.inject(request);
    expect(created.statusCode).toBe(201);
    const converted = await ctx.app.inject({
      method: "POST",
      url: `/api/${route}/${created.json().id}/${route === "projects" ? "convert-to-task" : "convert-to-story"}`,
      payload: { expectedRevision: created.json().revision, ...(route === "tasks" ? { status: "backlog" } : {}) },
    });
    expect(converted.statusCode, converted.body).toBe(201);
    const before = digest();
    const replay = await ctx.app.inject(request);
    expect(replay.statusCode).toBe(404);
    expect(replay.json().error.code).toBe(route === "projects" ? "project_not_found" : "task_not_found");
    expect(digest()).toBe(before);
  });
});
