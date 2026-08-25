import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addDependency, createProject, createTask } from "../src/domain/mutations.js";
import * as schema from "../src/db/schema.js";
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
        payload: {
          title: "Neues Projekt",
          notes: "Freie Notizen mit Link und Telefonnummer",
        },
      })
    ).json();
    // New stories always start in the backlog (see project-workflow.test.ts
    // for the full activate/return-to-backlog/complete/reopen/archive
    // state machine and its driver invariants).
    expect(created.status).toBe("backlog");
    expect(created.acceptanceCriteria).toEqual([]);
    expect(created.notes).toBe("Freie Notizen mit Link und Telefonnummer");
    expect(created.availableActions).toEqual(["activate", "archive"]);

    const updated = (
      await ctx.app.inject({
        method: "PATCH",
        url: `/api/projects/${created.id}`,
        payload: {
          title: "Umbenanntes Projekt",
          notes: "Aktualisierter Hintergrund",
          context: "Büro",
        },
      })
    ).json();
    expect(updated.title).toBe("Umbenanntes Projekt");
    expect(updated.context).toBe("Büro");
    expect(updated.notes).toBe("Aktualisierter Hintergrund");

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

  it("deletes a project while preserving and detaching its tasks", async () => {
    const project = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { title: "Wird gelöscht" },
      })
    ).json();
    const task = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: { title: "Bleibt erhalten", projectId: project.id },
      })
    ).json();

    const removed = await ctx.app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}`,
    });
    expect(removed.statusCode).toBe(204);

    const missingProject = await ctx.app.inject({
      method: "GET",
      url: `/api/projects/${project.id}`,
    });
    expect(missingProject.statusCode).toBe(404);

    const survivingTask = await ctx.app.inject({
      method: "GET",
      url: `/api/tasks/${task.id}`,
    });
    expect(survivingTask.statusCode).toBe(200);
    expect(survivingTask.json().projectId).toBeNull();
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

    expect(await stuckTitles()).toContain(
      "Wartungsplan Auto:only_waiting_without_followup",
    );

    const detail = (await ctx.app
      .inject({ method: "GET", url: `/api/projects/${waitingProject.id}` })
      .then((r) => r.json())) as { tasks: Array<{ id: number; status: string }> };
    const waitingTasks = detail.tasks.filter((t) => t.status === "waiting");
    for (const waitingTask of waitingTasks) {
      const scheduled = await ctx.app.inject({
        method: "PATCH",
        url: `/api/tasks/${waitingTask.id}`,
        payload: { scheduledDate: "2099-10-01" },
      });
      expect(scheduled.statusCode).toBe(200);
    }

    expect(await stuckTitles()).not.toContain(
      "Wartungsplan Auto:only_waiting_without_followup",
    );

    for (const waitingTask of waitingTasks) {
      await ctx.app.inject({
        method: "PATCH",
        url: `/api/tasks/${waitingTask.id}`,
        payload: { scheduledDate: null },
      });
    }

    expect(await stuckTitles()).toContain(
      "Wartungsplan Auto:only_waiting_without_followup",
    );
  });

  it("omits only exclusively scheduled dependency chains from /api/projects/stuck", async () => {
    const owner = ctx.handle.db
      .insert(schema.members)
      .values({ name: "API-Parkzuständige", color: "#123456" })
      .returning()
      .get();
    const parked = createProject(ctx.handle.db, {
      title: "API geplant geparkt",
      status: "active",
      ownerMemberId: owner.id,
    });
    const blocker = createTask(ctx.handle.db, {
      projectId: parked.id,
      title: "API Wiedervorlage",
      status: "waiting",
      scheduledDate: "2026-11-01",
    });
    const action = createTask(ctx.handle.db, {
      projectId: parked.id,
      title: "API blockierte Aktion",
      status: "actionable",
    });
    addDependency(ctx.handle.db, action.id, blocker.id);

    const mixed = createProject(ctx.handle.db, {
      title: "API gemischt blockiert",
      status: "active",
      ownerMemberId: owner.id,
    });
    const mixedBlocker = createTask(ctx.handle.db, {
      projectId: mixed.id,
      title: "API unterminierter Blockierer",
      status: "waiting",
    });
    const mixedAction = createTask(ctx.handle.db, {
      projectId: mixed.id,
      title: "API blockiert",
      status: "actionable",
    });
    addDependency(ctx.handle.db, mixedAction.id, mixedBlocker.id);

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/projects/stuck",
    });
    expect(response.statusCode).toBe(200);
    const stuck = response.json() as Array<{ id: number; stuckReason: string }>;
    expect(stuck.some((project) => project.id === parked.id)).toBe(false);
    expect(stuck).toContainEqual(
      expect.objectContaining({
        id: mixed.id,
        stuckReason: "blocked_dependencies",
      }),
    );
  });
});
