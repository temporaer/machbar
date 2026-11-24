import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProject } from "../src/domain/storyCrud.js";
import { createTask } from "../src/domain/taskCrud.js";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

describe("first action child clarification", () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = createTestContext(); });
  afterEach(async () => closeTestContext(ctx));

  it.each(["single", "batch", "reference-first"] as const)(
    "classifies only the captured parent for %s without activating its project",
    async mode => {
      const project = createProject(ctx.handle.db, { title: "Backlog project" });
      const parent = createTask(ctx.handle.db, { title: "Capture", projectId: project.id, status: "captured" });
      if (mode === "reference-first") {
        const reference = await ctx.app.inject({
          method: "POST", url: `/api/tasks/${parent.id}/children`,
          payload: { title: "Reference", kind: "reference" },
        });
        expect(reference.statusCode, reference.body).toBe(201);
        const before = await ctx.app.inject({ method: "GET", url: `/api/tasks/${parent.id}` });
        expect(before.json()).toMatchObject({ status: "captured", needsClarification: true, revision: parent.revision });
      }
      const response = await ctx.app.inject({
        method: "POST",
        url: `/api/tasks/${parent.id}/children${mode === "batch" ? "/batch" : ""}`,
        payload: mode === "batch"
          ? { expectedRevision: parent.revision, steps: [{ title: "First" }, { title: "Second" }] }
          : { title: "First" },
      });
      expect(response.statusCode, response.body).toBe(201);
      const confirmed = await ctx.app.inject({ method: "GET", url: `/api/tasks/${parent.id}` });
      expect(confirmed.json()).toMatchObject({ status: "actionable", needsClarification: false, revision: parent.revision + 1 });
      const outer = await ctx.app.inject({ method: "GET", url: `/api/projects/${project.id}` });
      expect(outer.json()).toMatchObject({ status: "backlog", revision: project.revision });
      const events = ctx.handle.sqlite.prepare("SELECT COUNT(*) AS count FROM activity_events WHERE entity_id = ? AND kind = 'task_status_changed'").get(parent.id);
      expect(events).toEqual({ count: 1 });
    },
  );

  it.each(["single", "batch"] as const)("keeps a Someday parent parked after %s child creation", async mode => {
    const parent = createTask(ctx.handle.db, { title: "Parked", status: "someday" });
    const response = await ctx.app.inject({
      method: "POST", url: `/api/tasks/${parent.id}/children${mode === "batch" ? "/batch" : ""}`,
      payload: mode === "batch" ? { expectedRevision: parent.revision, steps: [{ title: "Step" }] } : { title: "Step" },
    });
    expect(response.statusCode, response.body).toBe(201);
    const confirmed = await ctx.app.inject({ method: "GET", url: `/api/tasks/${parent.id}` });
    expect(confirmed.json()).toMatchObject({ status: "someday", revision: parent.revision });
  });

  it("does not classify a captured parent when a batch is invalid", async () => {
    const parent = createTask(ctx.handle.db, { title: "Capture", status: "captured" });
    const before = ctx.handle.sqlite.serialize();
    const response = await ctx.app.inject({
      method: "POST", url: `/api/tasks/${parent.id}/children/batch`,
      payload: { expectedRevision: parent.revision, steps: [{ title: "Valid" }, { title: "" }] },
    });
    expect(response.statusCode).toBe(400);
    expect(ctx.handle.sqlite.serialize()).toEqual(before);
  });
});
