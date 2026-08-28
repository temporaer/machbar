import { afterEach, describe, expect, it } from "vitest";
import { ChangeNotifier } from "../src/changeNotifier.js";
import {
  closeTestContext,
  createTestContext,
  type TestContext,
} from "./helpers.js";

describe("multi-client synchronization", () => {
  let ctx: TestContext | undefined;

  afterEach(async () => {
    if (ctx) await closeTestContext(ctx);
    ctx = undefined;
  });

  it("rejects a stale project PATCH without overwriting the committed state", async () => {
    ctx = createTestContext();
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { title: "Original" },
    });
    const project = created.json();

    const first = await ctx.app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}`,
      payload: {
        notes: "Saved elsewhere",
        expectedRevision: project.revision,
      },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().revision).toBeGreaterThan(project.revision);

    const stale = await ctx.app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}`,
      payload: {
        title: "Stale overwrite",
        expectedRevision: project.revision,
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("stale_write_conflict");

    const current = await ctx.app.inject({
      method: "GET",
      url: `/api/projects/${project.id}`,
    });
    expect(current.json()).toMatchObject({
      title: "Original",
      notes: "Saved elsewhere",
      revision: first.json().revision,
    });
  });

  it("advances task revisions for relation-only changes", async () => {
    ctx = createTestContext();
    const tag = await ctx.app.inject({
      method: "POST",
      url: "/api/tags",
      payload: { name: "Home" },
    });
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { title: "Tagged task" },
    });
    const task = created.json();

    const updated = await ctx.app.inject({
      method: "PATCH",
      url: `/api/tasks/${task.id}`,
      payload: {
        tagIds: [tag.json().id],
        expectedRevision: task.revision,
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().revision).toBeGreaterThan(task.revision);
    expect(updated.json().explicitTags).toHaveLength(1);
  });

  it("publishes successful mutations with their origin client ID", async () => {
    const notifier = new ChangeNotifier();
    const events: Array<{ id: number; originClientId: string | null }> = [];
    notifier.subscribe((event) => events.push(event));
    ctx = createTestContext({ changeNotifier: notifier });

    await ctx.app.inject({ method: "GET", url: "/api/members" });
    await ctx.app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { "x-machbar-client-id": "tab-a" },
      payload: { title: "Published" },
    });
    await ctx.app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { title: "" },
    });

    expect(events).toEqual([{ id: 1, originClientId: "tab-a" }]);
  });
});
