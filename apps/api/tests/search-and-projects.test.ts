import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  addDependency,
  createProject as createProjectMutation,
  createTask,
} from "../src/domain/mutations.js";
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

  function addExternalWaitRow(
    taskId: number,
    waitingFor = "External event",
    revisitDate: string | null = null,
  ) {
    ctx.handle.db
      .insert(schema.taskExternalWaits)
      .values({ taskId, waitingFor, revisitDate })
      .run();
  }

  function createProject(
    ...args: Parameters<typeof createProjectMutation>
  ): ReturnType<typeof createProjectMutation> {
    const [db, input, context] = args;
    const requestedActive = input.status === "active";
    const project = createProjectMutation(
      db,
      requestedActive ? { ...input, status: "backlog" } : input,
      context,
    );
    if (!requestedActive) return project;
    db.update(schema.projects)
      .set({ status: "active" })
      .where(eq(schema.projects.id, project.id))
      .run();
    return { ...project, status: "active" };
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
      externalWait: expect.objectContaining({ waitingFor: "Vermieter" }),
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
      payload: { name: "Telefonisch", kind: "actor" },
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
        existingKind: "actor",
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
    ctx.handle.sqlite
      .prepare("UPDATE projects SET status = 'active' WHERE id = ?")
      .run(project.id);
    const wait = await ctx.app.inject({
      method: "PUT",
      url: `/api/tasks/${task.id}/external-wait`,
      payload: { waitingFor: "Installateur" },
    });
    expect(wait.statusCode).toBe(200);

    const waiting = await ctx.app.inject({ method: "GET", url: "/api/waiting" });
    expect(
      waiting.json().find((entry: { task: { id: number } }) => entry.task.id === task.id)
        .task.effectiveActorTags[0].id,
    ).toBe(actor.id);

    const refinement = await ctx.app.inject({
      method: "GET",
      url: `/api/refinement/tasks?tagIds=${actor.id}`,
    });
    expect(
      refinement.json().some((task: { title: string }) => task.title === "Auf Rückmeldung warten"),
    ).toBe(true);
  });

  it("returns direct external waits and skips dependency-only blockers", async () => {
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
      task: {
        id: number;
        blockers: Array<{ type: "dependency" | "external" }>;
      };
    }>;
    expect(rows.some((row) => row.task.id === dependencyOnly.id)).toBe(false);
    for (const task of [externalOnly, both]) {
      expect(rows.filter((row) => row.task.id === task.id)).toHaveLength(1);
    }
    expect(rows.find((row) => row.task.id === externalOnly.id)?.task.blockers).toEqual([
      expect.objectContaining({ type: "external" }),
    ]);
    expect(rows.find((row) => row.task.id === both.id)?.task.blockers).toEqual(
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

  it("drops waiting-without-followup review debt once a revisit is scheduled", async () => {
    const reviewItems = async () => {
      const res = await ctx.app.inject({ method: "GET", url: "/api/review" });
      return res.json() as Array<{
        entityId: number;
        projectId: number | null;
        reason: string;
      }>;
    };

    const projects = (await ctx.app
      .inject({ method: "GET", url: "/api/projects" })
      .then((r) => r.json())) as Array<{ id: number; title: string }>;
    const waitingProject = projects.find((p) => p.title === "Wartungsplan Auto")!;

    const detail = (await ctx.app
      .inject({ method: "GET", url: `/api/projects/${waitingProject.id}` })
      .then((r) => r.json())) as {
      tasks: Array<{
        id: number;
        externalWait: { waitingFor: string | null; revisitDate: string | null } | null;
      }>;
    };
    const waitingTasks = detail.tasks.filter((task) => task.externalWait !== null);
    for (const waitingTask of waitingTasks) {
      expect(await reviewItems()).toContainEqual(
        expect.objectContaining({
          entityId: waitingTask.id,
          reason: "waiting_without_followup",
        }),
      );
    }
    for (const waitingTask of waitingTasks) {
      const scheduled = await ctx.app.inject({
        method: "PUT",
        url: `/api/tasks/${waitingTask.id}/external-wait`,
        payload: {
          waitingFor: waitingTask.externalWait!.waitingFor,
          revisitDate: "2099-10-01",
        },
      });

      expect(scheduled.statusCode).toBe(200);
    }

    expect(
      (await reviewItems()).some(
        (item) =>
          item.projectId === waitingProject.id &&
          item.reason === "waiting_without_followup",
      ),
    ).toBe(false);

    for (const waitingTask of waitingTasks) {
      await ctx.app.inject({
        method: "PUT",
        url: `/api/tasks/${waitingTask.id}/external-wait`,
        payload: {
          waitingFor: waitingTask.externalWait!.waitingFor,
          revisitDate: null,
        },
      });
    }

    expect(
      (await reviewItems()).some(
        (item) =>
          item.projectId === waitingProject.id &&
          item.reason === "waiting_without_followup",
      ),
    ).toBe(true);
  });

  it("summarizes ordered, deduplicated waiting reasons in project responses", async () => {
    const owner = ctx.handle.db.select().from(schema.members).get()!;
    const project = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          title: "Küchenrenovierung",
          ownerMemberId: owner.id,
        },
      })
    ).json();
    ctx.handle.sqlite
      .prepare("UPDATE projects SET status = 'active' WHERE id = ?")
      .run(project.id);
    for (const payload of [
      {
        title: "Fenster bestellen",
        waitingFor: "Angebot der Schreinerei",
        plannedDate: "2099-11-03",
        revisitDate: "2099-10-03",
      },
      {
        title: "Arbeitsplatte bestellen",
        waitingFor: "Angebot der Schreinerei",
        plannedDate: "2099-11-01",
        revisitDate: "2099-10-01",
      },
      {
        title: "Lieferung verfolgen",
        waitingFor: "Liefertermin",
        plannedDate: "2099-11-02",
        revisitDate: "2099-10-02",
      },
      {
        title: "Nicht mehr relevant",
        waitingFor: "Diese Rückmeldung ist erledigt",
        status: "done",
        plannedDate: "2099-09-01",
        revisitDate: "2099-08-01",
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
          scheduledDate: payload.plannedDate,
        },
      })).json();
      if (payload.status !== "done") {
        const wait = await ctx.app.inject({
          method: "PUT",
          url: `/api/tasks/${created.id}/external-wait`,
          payload: { waitingFor, revisitDate: payload.revisitDate },
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
      waitingOn: ["Angebot der Schreinerei", "Liefertermin"],
      waitingUntil: "2099-10-01",
    });

    const waitingTasks = (
      await ctx.app.inject({ method: "GET", url: "/api/waiting" })
    ).json() as Array<{
      task: { title: string; externalWait: { waitingFor: string | null } | null };
    }>;
    expect(waitingTasks).toContainEqual(
      expect.objectContaining({
        task: expect.objectContaining({
          title: "Lieferung verfolgen",
          externalWait: expect.objectContaining({ waitingFor: "Liefertermin" }),
        }),
      }),
    );
  });

  it("keeps reached external waits active while surfacing their task in Today", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const owner = ctx.handle.db.select().from(schema.members).get()!;
    const project = createProject(ctx.handle.db, {
      title: "Auf heutige Rückmeldung warten",
      status: "active",
      ownerMemberId: owner.id,
    });
    const waiting = createTask(ctx.handle.db, {
      projectId: project.id,
      title: "Heute bei der Werkstatt nachhaken",
      status: "actionable",
      scheduledDate: today,
      ownerMemberId: owner.id,
      ownerInheritanceMode: "explicit",
    });
    addExternalWaitRow(waiting.id, "Rückmeldung der Werkstatt", today);

    const projects = (
      await ctx.app.inject({ method: "GET", url: "/api/projects" })
    ).json() as Array<{
      id: number;
      stuckReason: string | null;
      waitingOn: string[];
      waitingUntil: string | null;
    }>;
    expect(projects.find((item) => item.id === project.id)).toMatchObject({
      stuckReason: null,
      waitingOn: ["Rückmeldung der Werkstatt"],
      waitingUntil: today,
    });

    const review = (
      await ctx.app.inject({ method: "GET", url: "/api/review" })
    ).json() as Array<{ projectId: number | null; reason: string }>;
    expect(
      review.some(
        (item) =>
          item.projectId === project.id && item.reason === "project_stuck",
      ),
    ).toBe(false);

    const agenda = (
      await ctx.app.inject({
        method: "GET",
        url: `/api/agenda/today?scope=all&date=${today}`,
      })
    ).json() as { revisit: Array<{ id: number; blocked: boolean }> };
    expect(agenda.revisit).toContainEqual(
      expect.objectContaining({ id: waiting.id, blocked: true }),
    );
  });

  it("omits healthy future-wait chains from Review but reports broken paths", async () => {
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
    addExternalWaitRow(blocker.id, "External event", "2026-11-01");
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
      url: "/api/review",
    });
    expect(response.statusCode).toBe(200);
    const review = response.json() as Array<{
      projectId: number;
      reason: string;
    }>;
    expect(review.some((item) => item.projectId === parked.id)).toBe(false);
    expect(review).toContainEqual(
      expect.objectContaining({
        projectId: mixed.id,
        reason: "broken_blocker_path",
      }),
    );
  });
});
