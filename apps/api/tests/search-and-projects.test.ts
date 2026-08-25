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

  it("creates, updates, archives and unarchives a project", async () => {
    const created = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { title: "Neues Projekt" },
      })
    ).json();
    expect(created.status).toBe("active");

    const updated = (
      await ctx.app.inject({
        method: "PATCH",
        url: `/api/projects/${created.id}`,
        payload: { description: "Beschreibung" },
      })
    ).json();
    expect(updated.description).toBe("Beschreibung");

    const archived = (
      await ctx.app.inject({ method: "POST", url: `/api/projects/${created.id}/archive` })
    ).json();
    expect(archived.status).toBe("archived");

    const unarchived = (
      await ctx.app.inject({ method: "POST", url: `/api/projects/${created.id}/unarchive` })
    ).json();
    expect(unarchived.status).toBe("active");
  });

  it("returns 404 with a German message for an unknown project", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/api/projects/999999" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toContain("wurde nicht gefunden");
  });
});
