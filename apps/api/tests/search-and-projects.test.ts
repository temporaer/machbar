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

  function addExternalWaitRow(taskId: number, waitingFor: string | null = null) {
    ctx.handle.db.insert(schema.taskExternalWaits).values({ taskId, waitingFor }).run();
  }

  it("filters search results by canonical external-wait state", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/search?status=actionable&externalWait=true",
    });
    const results = res.json() as Array<{
      title: string;
      status: string;
      externalWait: { waitingFor: string | null } | null;
    }>;
    expect(results).toContainEqual(expect.objectContaining({
      title: "Nebenkostenabrechnung klären",
      status: "actionable",
      externalWait: { waitingFor: "Vermieter" },
    }));
    expect(results.every((task) => task.externalWait !== null)).toBe(true);
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

  it("rejects creating a same-name tag with a different primary kind", async () => {
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/tags",
      payload: { name: "Telefonisch", kind: "context" },
    });
    expect(created.statusCode).toBe(201);

    const conflict = await ctx.app.inject({
      method: "POST",
      url: "/api/tags",
      payload: { name: "Telefonisch", kind: "plain" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toMatchObject({
      code: "tag_kind_conflict",
      details: {
        name: "Telefonisch",
        existingKind: "context",
        requestedKind: "plain",
      },
    });
  });

  it("filters waiting and refinement tasks by effective typed tags", async () => {
    const actor = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/tags",
        payload: { name: "Installateur", kind: "actor" },
      })
    ).json();
    const project = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          title: "Heizung",
          status: "active",
          tagIds: [actor.id],
        },
      })
    ).json();
    const task = (await ctx.app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: {
        projectId: project.id,
        title: "Auf Rückmeldung warten",
        status: "actionable",
      },
    })).json();
    const wait = await ctx.app.inject({
      method: "PUT",
      url: `/api/tasks/${task.id}/external-wait`,
      payload: { waitingFor: "Installateur" },
    });
    expect(wait.statusCode).toBe(200);

    const waiting = await ctx.app.inject({
      method: "GET",
      url: `/api/waiting?actorTagId=${actor.id}`,
    });
    expect(waiting.json()[0].effectiveActorTags[0].id).toBe(actor.id);

    const refinement = await ctx.app.inject({
      method: "GET",
      url: `/api/refinement/tasks?tagIds=${actor.id}`,
    });
    expect(
      refinement.json().some((task: { title: string }) => task.title === "Auf Rückmeldung warten"),
    ).toBe(true);
  });

  it("returns dependency-only, external-only, and combined blockers once each", async () => {
    const prerequisite = createTask(ctx.handle.db, {
      title: "Voraussetzung",
      status: "actionable",
    });
    const dependencyOnly = createTask(ctx.handle.db, {
      title: "Nur Abhängigkeit",
      status: "actionable",
    });
    addDependency(ctx.handle.db, dependencyOnly.id, prerequisite.id);
    const externalOnly = createTask(ctx.handle.db, {
      title: "Nur externe Rückmeldung",
      status: "actionable",
    });
    addExternalWaitRow(externalOnly.id, "Lieferdienst");
    const both = createTask(ctx.handle.db, {
      title: "Beide Blocker",
      status: "actionable",
    });
    addDependency(ctx.handle.db, both.id, prerequisite.id);
    addExternalWaitRow(both.id, "Freigabe");

    const response = await ctx.app.inject({ method: "GET", url: "/api/waiting" });
    expect(response.statusCode).toBe(200);
    const rows = response.json() as Array<{
      id: number;
      blockers: Array<{ type: "dependency" | "external" }>;
    }>;
    for (const task of [dependencyOnly, externalOnly, both]) {
      expect(rows.filter((row) => row.id === task.id)).toHaveLength(1);
    }
    expect(rows.find((row) => row.id === dependencyOnly.id)?.blockers).toEqual([
      expect.objectContaining({ type: "dependency" }),
    ]);
    expect(rows.find((row) => row.id === externalOnly.id)?.blockers).toEqual([
      expect.objectContaining({ type: "external" }),
    ]);
    expect(rows.find((row) => row.id === both.id)?.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "dependency" }),
        expect.objectContaining({ type: "external" }),
      ]),
    );
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
        },
      })
    ).json();
    expect(updated.title).toBe("Umbenanntes Projekt");
    expect(updated.notes).toBe("Aktualisierter Hintergrund");

    const archived = (
      await ctx.app.inject({ method: "POST", url: `/api/projects/${created.id}/archive` })
    ).json();
    expect(archived.status).toBe("archived");
  });

  it("returns a structured 404 for an unknown project", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/api/projects/999999" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatchObject({
      code: "project_not_found",
      details: { projectId: 999999 },
    });
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
      "Wartungsplan Auto:waiting_without_followup",
    );

    const detail = (await ctx.app
      .inject({ method: "GET", url: `/api/projects/${waitingProject.id}` })
      .then((r) => r.json())) as {
      tasks: Array<{ id: number; externalWait: { waitingFor: string | null } | null }>;
    };
    const waitingTasks = detail.tasks.filter((task) => task.externalWait !== null);
    for (const waitingTask of waitingTasks) {
      const scheduled = await ctx.app.inject({
        method: "PATCH",
        url: `/api/tasks/${waitingTask.id}`,
        payload: { scheduledDate: "2099-10-01" },
      });

      expect(scheduled.statusCode).toBe(200);
    }

    expect(await stuckTitles()).not.toContain(
      "Wartungsplan Auto:waiting_without_followup",
    );

    for (const waitingTask of waitingTasks) {
      await ctx.app.inject({
        method: "PATCH",
        url: `/api/tasks/${waitingTask.id}`,
        payload: { scheduledDate: null },
      });
    }

    expect(await stuckTitles()).toContain(
      "Wartungsplan Auto:waiting_without_followup",
    );
  });

  it("summarizes ordered, deduplicated waiting reasons in project responses", async () => {
    const owner = ctx.handle.db.select().from(schema.members).get()!;
    const project = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          title: "Küchenrenovierung",
          status: "active",
          ownerMemberId: owner.id,
        },
      })
    ).json();
    for (const payload of [
      {
        title: "Fenster bestellen",
        waitingFor: "Angebot der Schreinerei",
        scheduledDate: "2099-10-03",
      },
      {
        title: "Arbeitsplatte bestellen",
        waitingFor: "Angebot der Schreinerei",
        scheduledDate: "2099-10-01",
      },
      {
        title: "Lieferung verfolgen",
        waitingFor: null,
        scheduledDate: "2099-10-02",
      },
      {
        title: "Nicht mehr relevant",
        waitingFor: "Diese Rückmeldung ist erledigt",
        status: "done",
        scheduledDate: "2099-09-01",
      },
    ]) {
      const waitingFor = payload.waitingFor;
      const created = (await ctx.app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: {
          projectId: project.id,
          status: "actionable",
          title: payload.title,
          scheduledDate: payload.scheduledDate,
        },
      })).json();
      if (payload.status !== "done") {
        const wait = await ctx.app.inject({
          method: "PUT",
          url: `/api/tasks/${created.id}/external-wait`,
          payload: { waitingFor },
        });
        expect(wait.statusCode).toBe(200);
      } else {
        await ctx.app.inject({
          method: "POST",
          url: `/api/tasks/${created.id}/complete`,
          payload: {},
        });
      }
    }

    const projects = (
      await ctx.app.inject({ method: "GET", url: "/api/projects" })
    ).json();
    const listedProject = projects.find(
      (item: { id: number }) => item.id === project.id,
    );

    expect(listedProject).toMatchObject({
      nextAction: null,
      stuckReason: null,
      waitingOn: ["Angebot der Schreinerei", "Lieferung verfolgen"],
      waitingUntil: "2099-10-01",
    });

    const waitingTasks = (
      await ctx.app.inject({ method: "GET", url: "/api/waiting" })
    ).json() as Array<{ title: string; externalWait: { waitingFor: string | null } | null }>;
    expect(waitingTasks).toContainEqual(
      expect.objectContaining({
        title: "Lieferung verfolgen",
        externalWait: { waitingFor: null },
      }),
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
      status: "actionable",
      scheduledDate: "2026-11-01",
    });
    addExternalWaitRow(blocker.id);
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
      status: "captured",
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
        stuckReason: "blocked_without_clear_path",
      }),
    );
  });
});
