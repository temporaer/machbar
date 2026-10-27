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
