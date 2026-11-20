import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import { getGraphLoadMetrics } from "../src/diagnostics/graphMetrics.js";
import * as schema from "../src/db/schema.js";
import { closeTestContext, createTestContext } from "./helpers.js";

it("serves and edits a 1000-task household without extra graph loads or missing rows", async () => {
  const ctx = createTestContext();
  try {
    ctx.handle.db.transaction(() => {
      for (let index = 0; index < 1000; index++) ctx.handle.db.insert(schema.workItems).values({ role: "task", title: `Scale ${index}`, status: "active", needsClarification: true }).run();
    });
    const before = getGraphLoadMetrics().totalLoads;
    const started = performance.now();
    const all = await ctx.app.inject({ method: "GET", url: "/api/inbox?scope=all" });
    expect(all.statusCode).toBe(200); expect(all.json()).toHaveLength(1000);
    const inbox = await ctx.app.inject({ method: "GET", url: "/api/inbox" });
    expect(inbox.statusCode).toBe(200);
    const item = all.json()[500];
    const updated = await ctx.app.inject({ method: "PATCH", url: `/api/tasks/${item.id}`, payload: { title: "Edited at scale", expectedRevision: item.revision } });
    expect(updated.statusCode, updated.body).toBe(200); expect(updated.json().title).toBe("Edited at scale");
    const metrics = getGraphLoadMetrics();
    expect(metrics.lastTaskCount).toBe(1000);
    expect(metrics.totalLoads - before).toBeLessThanOrEqual(5);
    console.info(JSON.stringify({ scaleTasks: 1000, elapsedMs: Math.round(performance.now() - started), graphLoads: metrics.totalLoads - before }));
  } finally { await closeTestContext(ctx); }
}, 10000);

it("projects a newly created project task once and returns the same detail on replay and read", async () => {
  const ctx = createTestContext();
  try {
    const project = ctx.handle.db.insert(schema.workItems)
      .values({ role: "story", title: "Project", status: "backlog" }).returning().get();
    const request = {
      method: "POST" as const,
      url: "/api/tasks",
      headers: { "idempotency-key": "project_task_load_0001" },
      payload: { title: "New task", projectId: project.id },
    };
    const before = getGraphLoadMetrics().totalLoads;
    const created = await ctx.app.inject(request);
    expect(created.statusCode, created.body).toBe(201);
    expect(getGraphLoadMetrics().totalLoads - before).toBe(1);
    const replay = await ctx.app.inject(request);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toEqual(created.json());
    const read = await ctx.app.inject({ method: "GET", url: `/api/tasks/${created.json().id}` });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json()).toEqual(created.json());
  } finally { await closeTestContext(ctx); }
});
