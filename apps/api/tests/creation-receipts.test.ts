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
