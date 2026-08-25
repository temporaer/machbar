import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

describe("search/filter and project CRUD/archive", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext({ seed: true });
  });

  afterEach(async () => {
    await closeTestContext(ctx);
  });

  it("filters search results by status and waitingFor", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/search?status=waiting&waitingFor=Vermieter",
    });
    const results = res.json() as Array<{ title: string; status: string }>;
    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe("Nebenkostenabrechnung klären");
  });

  it("filters search results by effective context", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/search?effectiveContext=Garten",
    });
    const results = res.json() as Array<{ effectiveContext: string }>;
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) expect(r.effectiveContext).toBe("Garten");
  });

  it("filters search results by tag", async () => {
    const tags = (await ctx.app.inject({ method: "GET", url: "/api/tags" })).json() as Array<{
      id: number;
      name: string;
    }>;
    const financeTag = tags.find((t) => t.name === "Finanzen")!;
    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/search?tagIds=${financeTag.id}`,
    });
    const results = res.json() as Array<{ effectiveTags: Array<{ id: number }> }>;
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.effectiveTags.map((t) => t.id)).toContain(financeTag.id);
    }
  });

  it("creates a backlog project, edits its metadata, and archives it", async () => {
    const created = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { title: "Neues Projekt" },
      })
    ).json();
    // New stories always start in the backlog (see project-workflow.test.ts
    // for the full activate/return-to-backlog/complete/reopen/archive
    // state machine and its driver invariants).
    expect(created.status).toBe("backlog");
    expect(created.acceptanceCriteria).toEqual([]);
    expect(created.availableActions).toEqual(["activate", "archive"]);

    const updated = (
      await ctx.app.inject({
        method: "PATCH",
        url: `/api/projects/${created.id}`,
        payload: { title: "Umbenanntes Projekt", context: "Büro" },
      })
    ).json();
    expect(updated.title).toBe("Umbenanntes Projekt");
    expect(updated.context).toBe("Büro");

    const archived = (
      await ctx.app.inject({ method: "POST", url: `/api/projects/${created.id}/archive` })
    ).json();
    expect(archived.status).toBe("archived");
  });

  it("returns 404 with a German message for an unknown project", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/api/projects/999999" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toContain("wurde nicht gefunden");
  });

  it("drops a waiting-only project from /api/projects/stuck once a revisit is scheduled", async () => {
    const stuckTitles = async () => {
      const res = await ctx.app.inject({ method: "GET", url: "/api/projects/stuck" });
      return (res.json() as Array<{ title: string; stuckReason: string }>).map(
        (p) => `${p.title}:${p.stuckReason}`,
      );
    };

    const projects = (await ctx.app
      .inject({ method: "GET", url: "/api/projects" })
      .then((r) => r.json())) as Array<{ id: number; title: string }>;
    const waitingProject = projects.find((p) => p.title === "Wartungsplan Auto")!;

    expect(await stuckTitles()).toContain("Wartungsplan Auto:only_waiting");

    const detail = (await ctx.app
      .inject({ method: "GET", url: `/api/projects/${waitingProject.id}` })
      .then((r) => r.json())) as { tasks: Array<{ id: number; status: string }> };
    const waitingTask = detail.tasks.find((t) => t.status === "waiting")!;

    const scheduled = await ctx.app.inject({
      method: "PATCH",
      url: `/api/tasks/${waitingTask.id}`,
      payload: { scheduledDate: "2026-10-01" },
    });
    expect(scheduled.statusCode).toBe(200);

    expect(await stuckTitles()).not.toContain("Wartungsplan Auto:only_waiting");

    await ctx.app.inject({
      method: "PATCH",
      url: `/api/tasks/${waitingTask.id}`,
      payload: { scheduledDate: null },
    });

    expect(await stuckTitles()).toContain("Wartungsplan Auto:only_waiting");
  });
});
