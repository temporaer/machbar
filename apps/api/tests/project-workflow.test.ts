import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDb, type DbHandle } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import * as schema from "../src/db/schema.js";
import { createMember } from "../src/domain/members.js";
import { createProject as createProjectMutation, updateProject } from "../src/domain/storyCrud.js";
import {
  activateProject,
  archiveProject,
  completeProject,
  reopenProject,
  returnProjectToBacklog,
} from "../src/domain/storyWorkflow.js";
import { createTask } from "../src/domain/taskCrud.js";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

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
  db.update(schema.workItems)
    .set({ status: "active" })
    .where(eq(schema.workItems.id, project.id))
    .run();
  return { ...project, status: "active" };
}

/**
 * Route-level (HTTP) coverage of the explicit project workflow: new
 * stories default to `backlog`, and every status change happens through
 * one of the five dedicated actions (activate / return-to-backlog /
 * complete / reopen / archive) rather than a generic `status` field on
 * `PATCH /api/projects/:id`.
 */
describe("project workflow (HTTP routes)", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await closeTestContext(ctx);
  });

  async function createMemberRoute(name: string) {
    const res = await ctx.app.inject({ method: "POST", url: "/api/members", payload: { name } });
    return res.json();
  }

  async function createProjectRoute(payload: Record<string, unknown> = {}) {
    const requestedActive = payload.status === "active";
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        title: "Testprojekt",
        ...payload,
        ...(requestedActive ? { status: "backlog" } : {}),
      },
    });
    const project = res.json();
    if (requestedActive) {
      ctx.handle.sqlite
        .prepare("UPDATE work_items SET status = 'active' WHERE id = ?")
        .run(project.id);
      return (
        await ctx.app.inject({
          method: "GET",
          url: `/api/projects/${project.id}`,
        })
      ).json();
    }
    return project;
  }

  async function addProgressTask(projectId: number) {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { projectId, title: "Next action", status: "actionable" },
    });
    expect(response.statusCode).toBe(201);
  }

  it("defaults a newly created project to backlog with activate/archive as its only actions", async () => {
    const project = await createProjectRoute();
    expect(project.status).toBe("backlog");
    expect(project.availableActions.sort()).toEqual(["activate", "archive"]);
  });

  it("activates the dated task's backlog project and its ancestors as one transition", async () => {
    const member = await createMemberRoute("Mira");
    const parent = await createProjectRoute({ title: "Haus", ownerMemberId: member.id });
    const child = await createProjectRoute({
      title: "Küche",
      parentId: parent.id,
      ownerMemberId: member.id,
    });
    const taskResponse = await ctx.app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: {
        projectId: child.id,
        title: "Material ausmessen",
        status: "someday",
        scheduledDate: "2026-12-01",
      },
    });

    expect(taskResponse.statusCode).toBe(201);
    expect(taskResponse.json().status).toBe("actionable");
    expect((await ctx.app.inject({ method: "GET", url: `/api/projects/${child.id}` })).json().status).toBe("active");
    expect((await ctx.app.inject({ method: "GET", url: `/api/projects/${parent.id}` })).json().status).toBe("active");
    expect((await ctx.app.inject({ method: "GET", url: `/api/tasks/${taskResponse.json().id}` })).json().scheduledDate)
      .toBe("2026-12-01");
    const today = (await ctx.app.inject({ method: "GET", url: "/api/agenda/today?scope=all&date=2026-10-11" })).json();
    expect(today.planned.map((task: { id: number }) => task.id)).not.toContain(taskResponse.json().id);
    expect(today.unscheduled.map((task: { id: number }) => task.id)).not.toContain(taskResponse.json().id);
  });

  it("returns missing driver decisions without persisting a committed task, then applies the retry atomically", async () => {
    const member = await createMemberRoute("Rae");
    const project = await createProjectRoute({ title: "Steuer", ownerMemberId: null });
    const body = {
      projectId: project.id,
      title: "Unterlagen zusammenstellen",
      scheduledDate: "2026-12-01",
    };
    const rejected = await ctx.app.inject({ method: "POST", url: "/api/tasks", payload: body });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().error).toMatchObject({
      code: "project_commitment_resolution_required",
      details: {
        projects: [{ projectId: project.id, required: ["driver"] }],
        expectedProjects: [{ projectId: project.id, revision: project.revision }],
      },
    });
    expect((await ctx.app.inject({ method: "GET", url: `/api/projects/${project.id}` })).json().status).toBe("backlog");
    expect(ctx.handle.sqlite.prepare("SELECT id FROM work_items WHERE role = 'task'").all()).toHaveLength(0);

    const retried = await ctx.app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: {
        ...body,
        activationResolution: {
          expectedProjects: [{ projectId: project.id, revision: project.revision }],
          drivers: [{ projectId: project.id, ownerMemberId: member.id }],
        },
      },
    });
    expect(retried.statusCode).toBe(201);
    expect(retried.json().status).toBe("actionable");
    expect((await ctx.app.inject({ method: "GET", url: `/api/projects/${project.id}` })).json())
      .toMatchObject({ status: "active", ownerMemberId: member.id });
  });

  it("collects a missing project driver before atomically enabling recurrence", async () => {
    const member = await createMemberRoute("Rae");
    const project = await createProjectRoute({ title: "Heizung", ownerMemberId: null });
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { projectId: project.id, title: "Filter prüfen", status: "someday" },
    });
    expect(created.statusCode).toBe(201);
    const task = created.json();
    const commitment = {
      expectedRevision: task.revision,
      scheduledDate: "2026-12-01",
      repeatAfterDays: 14,
      allowedDeviationDays: 2,
    };

    const required = await ctx.app.inject({ method: "PATCH", url: `/api/tasks/${task.id}`, payload: commitment });
    expect(required.statusCode).toBe(409);
    expect(required.json().error).toMatchObject({
      code: "project_commitment_resolution_required",
      details: { projects: [{ projectId: project.id, required: ["driver"] }] },
    });
    expect((await ctx.app.inject({ method: "GET", url: `/api/tasks/${task.id}` })).json()).toMatchObject({
      status: "someday",
      scheduledDate: null,
      repeatAfterDays: null,
      dueDate: null,
    });
    expect((await ctx.app.inject({ method: "GET", url: `/api/projects/${project.id}` })).json().status).toBe("backlog");

    const retried = await ctx.app.inject({
      method: "PATCH",
      url: `/api/tasks/${task.id}`,
      payload: {
        ...commitment,
        activationResolution: {
          expectedProjects: required.json().error.details.expectedProjects,
          drivers: [{ projectId: project.id, ownerMemberId: member.id }],
        },
      },
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toMatchObject({
      status: "actionable",
      scheduledDate: "2026-12-01",
      repeatAfterDays: 14,
      dueDate: "2026-12-03",
    });
    expect((await ctx.app.inject({ method: "GET", url: `/api/projects/${project.id}` })).json()).toMatchObject({
      status: "active",
      ownerMemberId: member.id,
    });
  });

  it("requires decisions before persisting a newly created project deadline, then creates the next action and activates atomically", async () => {
    const member = await createMemberRoute("Mira");
    const payload = {
      title: "Keller renovieren",
      ownerMemberId: member.id,
      dueDate: "2026-12-15",
    };
    const before = ctx.handle.sqlite
      .prepare("SELECT COUNT(*) AS count FROM work_items WHERE role = 'story'")
      .get() as { count: number };

    const rejected = await ctx.app.inject({ method: "POST", url: "/api/projects", payload });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().error).toMatchObject({
      code: "project_commitment_resolution_required",
      details: {
        projects: [{ title: "Keller renovieren", required: ["progressPath"] }],
        expectedProjects: [{ revision: expect.any(Number) }],
      },
    });
    expect(ctx.handle.sqlite
      .prepare("SELECT COUNT(*) AS count FROM work_items WHERE role = 'story'")
      .get()).toEqual(before);

    const decision = rejected.json().error.details;
    const retried = await ctx.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        ...payload,
        activationResolution: {
          expectedProjects: decision.expectedProjects,
          drivers: [],
          nextActionTitle: "Maße aufnehmen",
        },
      },
    });
    expect(retried.statusCode).toBe(201);
    expect(retried.json()).toMatchObject({ title: "Keller renovieren", status: "active" });
    const project = (await ctx.app.inject({ method: "GET", url: `/api/projects/${retried.json().id}` })).json();
    expect(project.tasks.map((task: { title: string }) => task.title)).toContain("Maße aufnehmen");
    expect(ctx.handle.sqlite
      .prepare("SELECT COUNT(*) AS count FROM work_items WHERE role = 'story'")
      .get()).toEqual({ count: before.count + 1 });
  });

  it("returns refreshed project decisions when a project changes while a commitment is being reviewed", async () => {
    const member = await createMemberRoute("Mira");
    const project = await createProjectRoute({ title: "Haus", ownerMemberId: null });
    const request = {
      projectId: project.id,
      title: "Fenster ausmessen",
      dueDate: "2026-12-01",
    };
    const initial = await ctx.app.inject({ method: "POST", url: "/api/tasks", payload: request });
    expect(initial.statusCode).toBe(409);

    const changed = await ctx.app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}`,
      payload: { expectedRevision: project.revision, notes: "Kontext geändert" },
    });
    expect(changed.statusCode).toBe(200);

    const retried = await ctx.app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: {
        ...request,
        activationResolution: {
          expectedProjects: [{ projectId: project.id, revision: project.revision }],
          drivers: [{ projectId: project.id, ownerMemberId: member.id }],
        },
      },
    });
    expect(retried.statusCode).toBe(409);
    expect(retried.json().error).toMatchObject({
      code: "project_commitment_resolution_required",
      details: {
        reason: "project_snapshot_stale",
        projects: [{ projectId: project.id, title: "Haus", required: ["driver"] }],
        expectedProjects: [{ projectId: project.id, revision: changed.json().revision }],
      },
    });
    expect(ctx.handle.sqlite.prepare("SELECT id FROM work_items WHERE role = 'task'").all()).toHaveLength(0);
    expect((await ctx.app.inject({ method: "GET", url: `/api/projects/${project.id}` })).json())
      .toMatchObject({ status: "backlog", ownerMemberId: null, notes: "Kontext geändert" });

    const refreshed = retried.json().error.details.expectedProjects;
    const accepted = await ctx.app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: {
        ...request,
        activationResolution: {
          expectedProjects: refreshed,
          drivers: [{ projectId: project.id, ownerMemberId: member.id }],
        },
      },
    });
    expect(accepted.statusCode).toBe(201);
    expect(ctx.handle.sqlite.prepare("SELECT id FROM work_items WHERE role = 'task'").all()).toHaveLength(1);
  });

  it("refreshes the decision chain when an ancestor is activated during review", async () => {
    const member = await createMemberRoute("Mira");
    const parent = await createProjectRoute({ title: "Haus", ownerMemberId: member.id });
    const child = await createProjectRoute({ title: "Küche", parentId: parent.id, ownerMemberId: null });
    const request = {
      projectId: child.id,
      title: "Arbeitsfläche ausmessen",
      dueDate: "2026-12-01",
    };
    const initial = await ctx.app.inject({ method: "POST", url: "/api/tasks", payload: request });
    expect(initial.statusCode).toBe(409);
    expect(initial.json().error.details.expectedProjects).toHaveLength(2);

    // Simulate a concurrent canonical activation changing both status and
    // revision while the user is choosing the child project's driver.
    ctx.handle.sqlite.prepare("UPDATE work_items SET status = 'active', revision = revision + 1 WHERE id = ?")
      .run(parent.id);
    const staleRetry = await ctx.app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: {
        ...request,
        activationResolution: {
          expectedProjects: initial.json().error.details.expectedProjects,
          drivers: [{ projectId: child.id, ownerMemberId: member.id }],
        },
      },
    });
    expect(staleRetry.statusCode).toBe(409);
    expect(staleRetry.json().error).toMatchObject({
      code: "project_commitment_resolution_required",
      details: {
        reason: "project_snapshot_stale",
        expectedProjects: [{ projectId: child.id, revision: child.revision }],
      },
    });
    expect(ctx.handle.sqlite.prepare("SELECT id FROM work_items WHERE role = 'task'").all()).toHaveLength(0);

    const accepted = await ctx.app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: {
        ...request,
        activationResolution: {
          expectedProjects: staleRetry.json().error.details.expectedProjects,
          drivers: [{ projectId: child.id, ownerMemberId: member.id }],
        },
      },
    });
    expect(accepted.statusCode).toBe(201);
    expect((await ctx.app.inject({ method: "GET", url: `/api/projects/${parent.id}` })).json().status).toBe("active");
    expect((await ctx.app.inject({ method: "GET", url: `/api/projects/${child.id}` })).json().status).toBe("active");
  });

  it("creates a user-authored progress path and activates when a project deadline is the commitment", async () => {
    const member = await createMemberRoute("Lena");
    const project = await createProjectRoute({ title: "Keller", ownerMemberId: member.id });
    const response = await ctx.app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}`,
      payload: {
        expectedRevision: project.revision,
        dueDate: "2026-12-20",
        activationResolution: {
          expectedProjects: [{ projectId: project.id, revision: project.revision }],
          drivers: [],
          nextActionTitle: "Kellerregal ausmessen",
        },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "active", dueDate: "2026-12-20" });
    const tasks = ctx.handle.sqlite.prepare("SELECT title, status FROM work_items WHERE role = 'task'").all();
    expect(tasks).toEqual([{ title: "Kellerregal ausmessen", status: "active" }]);
  });

  it("refreshes the project deadline draft and decisions after another edit", async () => {
    const member = await createMemberRoute("Lena");
    const project = await createProjectRoute({ title: "Keller", ownerMemberId: member.id });
    const initial = await ctx.app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}`,
      payload: { expectedRevision: project.revision, dueDate: "2026-12-20" },
    });
    expect(initial.statusCode).toBe(409);
    expect(initial.json().error.code).toBe("project_commitment_resolution_required");

    const edit = await ctx.app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}`,
      payload: { expectedRevision: project.revision, notes: "Neue Information" },
    });
    expect(edit.statusCode).toBe(200);
    const staleRetry = await ctx.app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}`,
      payload: {
        expectedRevision: project.revision,
        dueDate: "2026-12-20",
        activationResolution: {
          expectedProjects: initial.json().error.details.expectedProjects,
          drivers: [],
          nextActionTitle: "Materialbedarf prüfen",
        },
      },
    });
    expect(staleRetry.statusCode).toBe(409);
    expect(staleRetry.json().error).toMatchObject({
      code: "project_commitment_resolution_required",
      details: {
        targetRevision: edit.json().revision,
        projects: [{ projectId: project.id, required: ["progressPath"] }],
        expectedProjects: [{ projectId: project.id, revision: edit.json().revision }],
      },
    });

    const refreshed = await ctx.app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}`,
      payload: {
        expectedRevision: staleRetry.json().error.details.targetRevision,
        dueDate: "2026-12-20",
        activationResolution: {
          expectedProjects: staleRetry.json().error.details.expectedProjects,
          drivers: [],
          nextActionTitle: "Materialbedarf prüfen",
        },
      },
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json()).toMatchObject({ status: "active", dueDate: "2026-12-20" });
    const tasks = ctx.handle.sqlite.prepare("SELECT title FROM work_items WHERE role = 'task'").all();
    expect(tasks).toEqual([{ title: "Materialbedarf prüfen" }]);
  });

  it("refreshes ancestor decisions from the rolled-back graph while preserving a proposed next action", async () => {
    const member = await createMemberRoute("Lena");
    const parent = await createProjectRoute({ title: "Haus", ownerMemberId: member.id });
    const child = await createProjectRoute({ title: "Keller", parentId: parent.id, ownerMemberId: member.id });
    const initial = await ctx.app.inject({
      method: "PATCH",
      url: `/api/projects/${child.id}`,
      payload: { expectedRevision: child.revision, dueDate: "2026-12-20" },
    });
    expect(initial.statusCode).toBe(409);
    expect(initial.json().error.details.projects).toEqual(expect.arrayContaining([
      expect.objectContaining({ projectId: child.id, required: ["progressPath"] }),
      expect.objectContaining({ projectId: parent.id, required: ["progressPath"] }),
    ]));

    const parentEdit = await ctx.app.inject({
      method: "PATCH",
      url: `/api/projects/${parent.id}`,
      payload: { expectedRevision: parent.revision, notes: "Neue Information" },
    });
    expect(parentEdit.statusCode).toBe(200);
    const nextActionTitle = "Materialbedarf prüfen";
    const staleRetry = await ctx.app.inject({
      method: "PATCH",
      url: `/api/projects/${child.id}`,
      payload: {
        expectedRevision: child.revision,
        dueDate: "2026-12-20",
        activationResolution: {
          expectedProjects: initial.json().error.details.expectedProjects,
          drivers: [],
          nextActionTitle,
        },
      },
    });
    expect(staleRetry.statusCode).toBe(409);
    expect(staleRetry.json().error.details).toMatchObject({
      reason: "project_snapshot_stale",
      projects: expect.arrayContaining([
        expect.objectContaining({ projectId: child.id, required: ["progressPath"] }),
        expect.objectContaining({ projectId: parent.id, required: ["progressPath"] }),
      ]),
      expectedProjects: [
        expect.objectContaining({ projectId: child.id, revision: child.revision }),
        expect.objectContaining({ projectId: parent.id, revision: parentEdit.json().revision }),
      ],
    });
    expect(ctx.handle.sqlite.prepare("SELECT id FROM work_items WHERE role = 'task'").all()).toHaveLength(0);

    const accepted = await ctx.app.inject({
      method: "PATCH",
      url: `/api/projects/${child.id}`,
      payload: {
        expectedRevision: child.revision,
        dueDate: "2026-12-20",
        activationResolution: {
          expectedProjects: staleRetry.json().error.details.expectedProjects,
          drivers: [],
          nextActionTitle,
        },
      },
    });
    expect(accepted.statusCode).toBe(200);
    expect(ctx.handle.sqlite.prepare("SELECT title FROM work_items WHERE role = 'task'").all())
      .toEqual([{ title: nextActionTitle }]);
  });

  it("refreshes task commitment decisions before inserting a proposed action when an ancestor changed", async () => {
    const member = await createMemberRoute("Lena");
    const parent = await createProjectRoute({ title: "Haus", ownerMemberId: member.id });
    const child = await createProjectRoute({ title: "Keller", parentId: parent.id, ownerMemberId: member.id });
    const prerequisite = await ctx.app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { projectId: child.id, title: "Freigabe erhalten", status: "someday" },
    });
    expect(prerequisite.statusCode).toBe(201);
    const blocked = await ctx.app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { projectId: child.id, title: "Material bestellen", status: "actionable" },
    });
    expect(blocked.statusCode).toBe(201);
    const dependency = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${blocked.json().id}/dependencies`,
      payload: { dependsOnTaskId: prerequisite.json().id },
    });
    expect(dependency.statusCode).toBe(201);

    const request = {
      expectedRevision: dependency.json().revision,
      dueDate: "2026-12-20",
    };
    const initial = await ctx.app.inject({
      method: "PATCH",
      url: `/api/tasks/${blocked.json().id}`,
      payload: request,
    });
    expect(initial.statusCode).toBe(409);
    expect(initial.json().error).toMatchObject({
      code: "project_commitment_resolution_required",
      details: {
        projects: expect.arrayContaining([
          expect.objectContaining({ projectId: child.id, required: ["progressPath"] }),
        ]),
      },
    });

    const parentEdit = await ctx.app.inject({
      method: "PATCH",
      url: `/api/projects/${parent.id}`,
      payload: { expectedRevision: parent.revision, notes: "Antwort steht noch aus" },
    });
    expect(parentEdit.statusCode).toBe(200);
    const nextActionTitle = "Alternative Bezugsquelle prüfen";
    const staleRetry = await ctx.app.inject({
      method: "PATCH",
      url: `/api/tasks/${blocked.json().id}`,
      payload: {
        ...request,
        activationResolution: {
          expectedProjects: initial.json().error.details.expectedProjects,
          drivers: [],
          nextActionTitle,
        },
      },
    });
    expect(staleRetry.statusCode).toBe(409);
    expect(staleRetry.json().error.details).toMatchObject({
      reason: "project_snapshot_stale",
      projects: expect.arrayContaining([
        expect.objectContaining({ projectId: child.id, required: ["progressPath"] }),
      ]),
      expectedProjects: expect.arrayContaining([
        expect.objectContaining({ projectId: child.id, revision: child.revision }),
        expect.objectContaining({ projectId: parent.id, revision: parentEdit.json().revision }),
      ]),
    });
    expect(ctx.handle.sqlite.prepare("SELECT title FROM work_items WHERE role = 'task' ORDER BY id").all())
      .toEqual([{ title: "Freigabe erhalten" }, { title: "Material bestellen" }]);

    const accepted = await ctx.app.inject({
      method: "PATCH",
      url: `/api/tasks/${blocked.json().id}`,
      payload: {
        ...request,
        activationResolution: {
          expectedProjects: staleRetry.json().error.details.expectedProjects,
          drivers: [],
          nextActionTitle,
        },
      },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ dueDate: "2026-12-20" });
    expect(ctx.handle.sqlite.prepare("SELECT title FROM work_items WHERE role = 'task' ORDER BY id").all())
      .toEqual([
        { title: "Freigabe erhalten" },
        { title: "Material bestellen" },
        { title: nextActionTitle },
      ]);
    expect((await ctx.app.inject({ method: "GET", url: `/api/projects/${child.id}` })).json().status).toBe("active");
    expect((await ctx.app.inject({ method: "GET", url: `/api/projects/${parent.id}` })).json().status).toBe("active");
  });

  it("activates an already-dated backlog project when its deadline is changed", async () => {
    const member = await createMemberRoute("Lena");
    const project = await createProjectRoute({
      title: "Steuer",
      ownerMemberId: member.id,
    });
    // Simulate a dated backlog project left behind by the previous behavior.
    ctx.handle.sqlite.prepare("UPDATE work_items SET due_date = ? WHERE id = ?")
      .run("2026-12-01", project.id);
    await addProgressTask(project.id);

    const response = await ctx.app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}`,
      payload: {
        expectedRevision: project.revision,
        dueDate: "2026-12-20",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "active", dueDate: "2026-12-20" });
  });

  it("does not treat a project deadline as a progress path and rolls back when no path exists", async () => {
    const member = await createMemberRoute("Jo");
    const project = await createProjectRoute({ title: "Keller", ownerMemberId: member.id });
    const response = await ctx.app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}`,
      payload: { expectedRevision: project.revision, dueDate: "2026-12-20" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({
      code: "project_commitment_resolution_required",
      details: { projects: [{ projectId: project.id, required: ["progressPath"] }] },
    });
    expect((await ctx.app.inject({ method: "GET", url: `/api/projects/${project.id}` })).json())
      .toMatchObject({ status: "backlog", dueDate: null });
  });

  it("activates a dated project without resolving its healthy external wait", async () => {
    const member = await createMemberRoute("Kim");
    const project = await createProjectRoute({ title: "Versicherung", ownerMemberId: member.id });
    const task = (await ctx.app.inject({
      method: "POST", url: "/api/tasks", payload: { projectId: project.id, title: "Rückmeldung abwarten", status: "actionable" },
    })).json();
    const waiting = await ctx.app.inject({
      method: "PATCH", url: `/api/tasks/${task.id}`,
      payload: { expectedRevision: task.revision, externalWait: { waitingFor: "Versicherung" }, revisitAt: "2026-12-10T09:00:00.000Z" },
    });
    expect(waiting.statusCode).toBe(200);
    const currentProject = (await ctx.app.inject({ method: "GET", url: `/api/projects/${project.id}` })).json();
    const response = await ctx.app.inject({
      method: "PATCH", url: `/api/projects/${project.id}`,
      payload: { expectedRevision: currentProject.revision, dueDate: "2026-12-20" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("active");
    expect((await ctx.app.inject({ method: "GET", url: `/api/tasks/${task.id}` })).json())
      .toMatchObject({ status: "actionable", externalWait: expect.objectContaining({ waitingFor: "Versicherung" }) });
  });

  it("creates nested stories and exposes child stories plus breadcrumbs", async () => {
    const parent = await createProjectRoute({ title: "Haus verbessern" });
    const child = await createProjectRoute({
      title: "Gästezimmer renovieren",
      parentId: parent.id,
    });
    const grandchild = await createProjectRoute({
      title: "Wände vorbereiten",
      parentId: child.id,
    });

    const parentDetail = await ctx.app.inject({
      method: "GET",
      url: `/api/projects/${parent.id}`,
    });
    expect(parentDetail.statusCode).toBe(200);
    expect(parentDetail.json().childStories).toEqual([
      expect.objectContaining({
        id: child.id,
        parentId: parent.id,
        title: "Gästezimmer renovieren",
      }),
    ]);

    const grandchildDetail = await ctx.app.inject({
      method: "GET",
      url: `/api/projects/${grandchild.id}`,
    });
    expect(grandchildDetail.statusCode).toBe(200);
    expect(grandchildDetail.json()).toMatchObject({
      parentId: child.id,
      ancestors: [
        { id: parent.id, title: "Haus verbessern" },
        { id: child.id, title: "Gästezimmer renovieren" },
      ],
    });
  });

  it("rejects activation without a driver with a structured 400", async () => {
    const project = await createProjectRoute();
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/activate`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({
      code: "project_driver_required",
      details: { projectId: project.id },
    });
  });

  it("treats an explicitly cleared driver as missing and leaves the project unchanged", async () => {
    const anna = await createMemberRoute("Anna");
    const project = await createProjectRoute({ ownerMemberId: anna.id });
    const beforeRevision = project.revision;

    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/activate`,
      payload: { ownerMemberId: null },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({
      code: "project_driver_required",
      details: { projectId: project.id },
    });

    const after = await ctx.app.inject({
      method: "GET",
      url: `/api/projects/${project.id}`,
    });
    expect(after.statusCode).toBe(200);
    expect(after.json()).toMatchObject({
      status: "backlog",
      ownerMemberId: anna.id,
      revision: beforeRevision,
    });
  });

  it("activates a project by supplying a driver in the same call", async () => {
    const anna = await createMemberRoute("Anna");
    const project = await createProjectRoute();
    await addProgressTask(project.id);

    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/activate`,
      payload: { ownerMemberId: anna.id },
    });
    expect(res.statusCode).toBe(200);
    const activated = res.json();
    expect(activated.status).toBe("active");
    expect(activated.ownerMemberId).toBe(anna.id);
    expect(activated.availableActions.sort()).toEqual(
      ["archive", "complete", "return_to_backlog"].sort(),
    );
  });

  it("activates a project that already has a driver, without supplying one again", async () => {
    const anna = await createMemberRoute("Anna");
    const project = await createProjectRoute({ ownerMemberId: anna.id });
    await addProgressTask(project.id);

    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/activate`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("active");
  });

  it("rejects activating a project that is already active", async () => {
    const anna = await createMemberRoute("Anna");
    const project = await createProjectRoute({ ownerMemberId: anna.id, status: "active" });

    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/activate`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: "project_transition_invalid",
      details: {
        projectId: project.id,
        currentStatus: "active",
        action: "activate",
      },
    });
  });

  it("rejects direct active creation and activation without a viable progress or waiting path", async () => {
      const anna = await createMemberRoute("Readiness owner");
      const direct = await ctx.app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          title: "Bypass",
          status: "active",
          ownerMemberId: anna.id,
        },
      });
      expect(direct.statusCode).toBe(409);
      expect(direct.json().error.code).toBe("project_activation_not_ready");

      const project = await createProjectRoute({ ownerMemberId: anna.id });
      const activation = await ctx.app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/activate`,
      });
      expect(activation.statusCode).toBe(409);
      expect(activation.json().error).toMatchObject({
        code: "project_activation_not_ready",
        details: {
          projectId: project.id,
          hasViableProgressPath: false,
          hasHealthyFutureWaiting: false,
        },
      });
  });

  it("allows activation when the only credible path is a healthy future wait", async () => {
      const anna = await createMemberRoute("Waiting owner");
      const project = await createProjectRoute({ ownerMemberId: anna.id });
      const task = (
        await ctx.app.inject({
          method: "POST",
          url: "/api/tasks",
          payload: {
            projectId: project.id,
            title: "Wait for reply",
          },
        })
      ).json();
      await ctx.app.inject({
        method: "PUT",
        url: `/api/tasks/${task.id}/external-wait`,
        payload: {
          waitingFor: "Reply",
          revisitDate: "2099-01-01",
        },
      });

      const activation = await ctx.app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/activate`,
      });
      expect(activation.statusCode).toBe(200);
      expect(activation.json().status).toBe("active");
  });

  it("keeps the driver when returning an active project to the backlog, and allows clearing it only then", async () => {
    const anna = await createMemberRoute("Anna");
    const project = await createProjectRoute({ ownerMemberId: anna.id, status: "active" });

    const backToBacklog = (
      await ctx.app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/return-to-backlog`,
      })
    ).json();
    expect(backToBacklog.status).toBe("backlog");
    expect(backToBacklog.ownerMemberId).toBe(anna.id);

    const cleared = (
      await ctx.app.inject({
        method: "PATCH",
        url: `/api/projects/${project.id}`,
        payload: { ownerMemberId: null },
      })
    ).json();
    expect(cleared.ownerMemberId).toBeNull();
  });

  it("rejects clearing the driver of an active project", async () => {
    const anna = await createMemberRoute("Anna");
    const project = await createProjectRoute({ ownerMemberId: anna.id, status: "active" });

    const res = await ctx.app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}`,
      payload: { ownerMemberId: null },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: "project_driver_locked",
      details: {
        projectId: project.id,
        currentStatus: "active",
        requiredStatus: "backlog",
      },
    });

    const unchanged = (
      await ctx.app.inject({ method: "GET", url: `/api/projects/${project.id}` })
    ).json();
    expect(unchanged.ownerMemberId).toBe(anna.id);
  });

  it("completes an active project manually, and reopens a completed one back to active", async () => {
    const anna = await createMemberRoute("Anna");
    const project = await createProjectRoute({ ownerMemberId: anna.id, status: "active" });
    await addProgressTask(project.id);

    const completed = (
      await ctx.app.inject({ method: "POST", url: `/api/projects/${project.id}/complete` })
    ).json();
    expect(completed.status).toBe("completed");
    expect(completed.ownerMemberId).toBe(anna.id);
    expect(completed.availableActions.sort()).toEqual(["archive", "reopen"].sort());

    const reopened = (
      await ctx.app.inject({ method: "POST", url: `/api/projects/${project.id}/reopen` })
    ).json();
    expect(reopened.status).toBe("active");
    expect(reopened.ownerMemberId).toBe(anna.id);
  });

  it("requires all project completion choices first, then applies criteria and child resolution atomically", async () => {
    const project = await createProjectRoute({ title: "Abschluss", status: "active" });
    const childResponse = await ctx.app.inject({ method: "POST", url: "/api/tasks", payload: { projectId: project.id, title: "Offene Aufgabe", status: "actionable" } });
    const child = childResponse.json();
    const criterionResponse = await ctx.app.inject({ method: "POST", url: `/api/projects/${project.id}/criteria`, payload: { text: "Ergebnis übergeben" } });
    const criterion = criterionResponse.json().acceptanceCriteria[0];
    const current = (await ctx.app.inject({ method: "GET", url: `/api/projects/${project.id}` })).json();

    const rejected = await ctx.app.inject({ method: "POST", url: `/api/projects/${project.id}/complete`, payload: { expectedRevision: current.revision } });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().error.code).toBe("project_completion_resolution_required");
    expect((await ctx.app.inject({ method: "GET", url: `/api/projects/${project.id}` })).json().status).toBe("active");
    expect((await ctx.app.inject({ method: "GET", url: `/api/tasks/${child.id}` })).json().status).toBe("actionable");
    expect((await ctx.app.inject({ method: "GET", url: `/api/projects/${project.id}` })).json().acceptanceCriteria[0].checked).toBe(false);

    const rollback = await ctx.app.inject({
      method: "POST", url: `/api/projects/${project.id}/complete`, payload: {
        expectedRevision: current.revision,
        expectedTaskRevisions: [{ taskId: child.id, revision: child.revision }],
        descendantResolutions: [{ taskId: child.id, action: "cancel", expectedRevision: child.revision }],
      },
    });
    expect(rollback.statusCode).toBe(409);
    expect(rollback.json().error.code).toBe("project_completion_criteria_incomplete");
    expect((await ctx.app.inject({ method: "GET", url: `/api/tasks/${child.id}` })).json().status).toBe("actionable");

    const completed = await ctx.app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/complete`,
      payload: {
        expectedRevision: current.revision,
        criteriaToCheck: [criterion.id],
        expectedTaskRevisions: [{ taskId: child.id, revision: child.revision }],
        descendantResolutions: [{ taskId: child.id, action: "cancel", expectedRevision: child.revision }],
      },
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({ status: "completed", acceptanceCriteria: [{ checked: true }] });
    expect((await ctx.app.inject({ method: "GET", url: `/api/tasks/${child.id}` })).json().status).toBe("cancelled");
  });

  it("keeps a project active while execution commitments remain and withdraws them only by explicit choice", async () => {
    const project = await createProjectRoute({ title: "Geplantes Projekt", status: "active", dueDate: "2026-12-20" });
    const created = await ctx.app.inject({
      method: "POST", url: "/api/tasks", payload: {
        projectId: project.id, title: "Termin vorbereiten", status: "actionable", dueDate: "2026-11-10", scheduledDate: "2026-11-01",
        repeatAfterDays: 30, allowedDeviationDays: 2,
        reminders: [{ kind: "absolute", at: "2026-10-20T09:00:00.000Z" }],
      },
    });
    const task = created.json();
    const first = await ctx.app.inject({ method: "POST", url: `/api/projects/${project.id}/return-to-backlog`, payload: { expectedRevision: project.revision, revisitAt: "2026-11-15T09:00:00.000Z" } });
    expect(first.statusCode).toBe(409);
    expect(first.json().error.code).toBe("project_commitments_prevent_parking");
    expect((await ctx.app.inject({ method: "GET", url: `/api/projects/${project.id}` })).json().status).toBe("active");
    expect((await ctx.app.inject({ method: "GET", url: `/api/tasks/${task.id}` })).json().scheduledDate).toBe("2026-11-01");

    const parked = await ctx.app.inject({
      method: "POST", url: `/api/projects/${project.id}/return-to-backlog`, payload: {
        expectedRevision: project.revision, revisitAt: "2026-11-15T09:00:00.000Z", withdrawCommitments: true,
        expectedTaskRevisions: [{ taskId: task.id, revision: task.revision }],
      },
    });
    expect(parked.statusCode).toBe(200);
    expect(parked.json()).toMatchObject({ status: "backlog", dueDate: null, revisitAt: "2026-11-15T09:00:00.000Z" });
    expect((await ctx.app.inject({ method: "GET", url: `/api/tasks/${task.id}` })).json()).toMatchObject({ dueDate: null, scheduledDate: null, repeatAfterDays: null, reminders: [] });
  });

  it("moves a selected open task branch to Inbox atomically with project completion", async () => {
    const project = await createProjectRoute({ title: "Abschluss mit Restarbeit", status: "active" });
    const task = (await ctx.app.inject({ method: "POST", url: "/api/tasks", payload: { projectId: project.id, title: "Rückfrage", status: "actionable" } })).json();
    const current = (await ctx.app.inject({ method: "GET", url: `/api/projects/${project.id}` })).json();
    const response = await ctx.app.inject({
      method: "POST", url: `/api/projects/${project.id}/complete`, payload: {
        expectedRevision: current.revision,
        expectedTaskRevisions: [{ taskId: task.id, revision: task.revision }],
        descendantResolutions: [{ taskId: task.id, action: "move_to_inbox", expectedRevision: task.revision }],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("completed");
    expect((await ctx.app.inject({ method: "GET", url: `/api/tasks/${task.id}` })).json()).toMatchObject({ id: task.id, status: "actionable", projectId: null, parentTaskId: null });
  });

  it("rejects a stale child snapshot without partial completion and accepts a refreshed retry", async () => {
    const project = await createProjectRoute({ title: "Stale completion", status: "active" });
    const task = (await ctx.app.inject({ method: "POST", url: "/api/tasks", payload: { projectId: project.id, title: "Angebot prüfen", status: "actionable" } })).json();
    const snapshot = (await ctx.app.inject({ method: "GET", url: `/api/projects/${project.id}` })).json();
    await ctx.app.inject({ method: "PATCH", url: `/api/tasks/${task.id}`, payload: { expectedRevision: task.revision, notes: "Neue Information" } });
    const stale = await ctx.app.inject({
      method: "POST", url: `/api/projects/${project.id}/complete`, payload: {
        expectedRevision: snapshot.revision,
        expectedTaskRevisions: [{ taskId: task.id, revision: task.revision }],
        descendantResolutions: [{ taskId: task.id, action: "cancel", expectedRevision: task.revision }],
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("stale_write_conflict");
    expect((await ctx.app.inject({ method: "GET", url: `/api/projects/${project.id}` })).json().status).toBe("active");
    const currentTask = (await ctx.app.inject({ method: "GET", url: `/api/tasks/${task.id}` })).json();
    expect(currentTask).toMatchObject({ status: "actionable", notes: "Neue Information" });

    const currentProject = (await ctx.app.inject({ method: "GET", url: `/api/projects/${project.id}` })).json();
    const retried = await ctx.app.inject({
      method: "POST", url: `/api/projects/${project.id}/complete`, payload: {
        expectedRevision: currentProject.revision,
        expectedTaskRevisions: [{ taskId: currentTask.id, revision: currentTask.revision }],
        descendantResolutions: [{ taskId: currentTask.id, action: "cancel", expectedRevision: currentTask.revision }],
      },
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json().status).toBe("completed");
    expect((await ctx.app.inject({ method: "GET", url: `/api/tasks/${task.id}` })).json().status).toBe("cancelled");
  });

  it("rejects reopening a completed project without a viable progress or waiting path", async () => {
    const anna = await createMemberRoute("Reopen owner");
    const project = await createProjectRoute({
      ownerMemberId: anna.id,
      status: "completed",
    });

    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/reopen`,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({
      code: "project_activation_not_ready",
      details: {
        projectId: project.id,
        hasViableProgressPath: false,
        hasHealthyFutureWaiting: false,
      },
    });
  });

  it("assigns a missing driver atomically while reopening a ready project", async () => {
    const anna = await createMemberRoute("Replacement driver");
    const project = await createProjectRoute({ status: "completed" });
    await addProgressTask(project.id);

    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/reopen`,
      payload: { ownerMemberId: anna.id },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "active",
      ownerMemberId: anna.id,
    });
  });

  it("rejects completing a backlog project", async () => {
    const project = await createProjectRoute();
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/complete`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: "project_transition_invalid",
      details: { currentStatus: "backlog", action: "complete" },
    });
  });

  it("rejects reopening a project that isn't completed", async () => {
    const project = await createProjectRoute();
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/reopen`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: "project_transition_invalid",
      details: { currentStatus: "backlog", action: "reopen" },
    });
  });

  it("archives a backlog, active or completed project, and rejects archiving twice", async () => {
    const project = await createProjectRoute();
    const archived = (
      await ctx.app.inject({ method: "POST", url: `/api/projects/${project.id}/archive` })
    ).json();
    expect(archived.status).toBe("archived");
    expect(archived.availableActions.sort()).toEqual(["return_to_backlog"]);

    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/archive`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: "project_transition_invalid",
      details: { currentStatus: "archived", action: "archive" },
    });
  });

  it("returns a structured 404 for workflow actions on an unknown project", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/projects/999999/activate",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatchObject({
      code: "project_not_found",
      details: { projectId: 999999 },
    });
  });

  it.each([
    ["activate", "backlog"],
    ["return-to-backlog", "active"],
    ["complete", "active"],
    ["reopen", "completed"],
    ["archive", "backlog"],
  ] as const)(
    "rejects a stale revision for project %s without applying the transition",
    async (action, initialStatus) => {
      const anna = await createMemberRoute(`Anna ${action}`);
      const project = await createProjectRoute({
        status: initialStatus,
        ownerMemberId: anna.id,
      });
      const updated = await ctx.app.inject({
        method: "PATCH",
        url: `/api/projects/${project.id}`,
        payload: {
          notes: "Concurrent edit",
          expectedRevision: project.revision,
        },
      });
      expect(updated.statusCode).toBe(200);

      const response = await ctx.app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/${action}`,
        payload: { expectedRevision: project.revision },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("stale_write_conflict");
      const current = await ctx.app.inject({
        method: "GET",
        url: `/api/projects/${project.id}`,
      });
      expect(current.json()).toMatchObject({
        status: initialStatus,
        notes: "Concurrent edit",
        revision: updated.json().revision,
      });
    },
  );

  it("accepts the current revision for every project lifecycle action and returns confirmed entities", async () => {
    const anna = await createMemberRoute("Revision driver");
    let project = await createProjectRoute({ ownerMemberId: anna.id });
    await addProgressTask(project.id);
    for (const action of [
      "activate",
      "complete",
      "reopen",
      "return-to-backlog",
      "archive",
    ]) {
      const response = await ctx.app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/${action}`,
        payload: { expectedRevision: project.revision },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().id).toBe(project.id);
      expect(response.json().revision).toBe(project.revision + 1);
      project = response.json();
    }
  });
});

/**
 * Service-level (direct mutation function) coverage, complementing the
 * HTTP tests above with transaction/rollback and edge-case checks that are
 * awkward to express purely through routes.
 */
describe("project workflow (service layer)", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = openDb(":memory:");
    runMigrations(handle.db);
  });

  afterEach(() => {
    handle.close();
  });

  it("rejects direct active creation without an atomic progress path", () => {
    const anna = createMember(handle.db, "Direct owner");
    expect(() =>
      createProjectMutation(handle.db, {
        title: "Invalid direct active",
        status: "active",
        ownerMemberId: anna.id,
      }),
    ).toThrow(/executable progress path/);
    expect(
      handle.db
        .select()
        .from(schema.workItems)
        .where(eq(schema.workItems.role, "story"))
        .all(),
    ).toEqual([]);
  });

  it("re-activates a project restored from archive to backlog without requiring the driver again", () => {
    const anna = createMember(handle.db, "Anna");
    const project = createProject(handle.db, { title: "Aktiviert", ownerMemberId: anna.id });
    createTask(handle.db, { title: "Next action", projectId: project.id });
    activateProject(handle.db, project.id);
    archiveProject(handle.db, project.id);
    returnProjectToBacklog(handle.db, project.id);

    const reactivated = activateProject(handle.db, project.id);
    expect(reactivated.status).toBe("active");
    expect(reactivated.ownerMemberId).toBe(anna.id);
  });

  it("rejects activating an archived project directly, requiring return-to-backlog first", () => {
    const anna = createMember(handle.db, "Anna");
    const project = createProject(handle.db, { title: "Archiviert", ownerMemberId: anna.id });
    archiveProject(handle.db, project.id);

    expect(() => activateProject(handle.db, project.id)).toThrow(/not allowed/);
  });

  it("lets return-to-backlog pull an archived project back too", () => {
    const project = createProject(handle.db, { title: "Ohne Driver" });
    archiveProject(handle.db, project.id);

    const backToBacklog = returnProjectToBacklog(handle.db, project.id);
    expect(backToBacklog.status).toBe("backlog");
  });

  it("returns an active project to backlog with its revisit date atomically", () => {
    const anna = createMember(handle.db, "Anna");
    const project = createProject(handle.db, { title: "Später", ownerMemberId: anna.id });
    createTask(handle.db, { title: "Next action", projectId: project.id });
    activateProject(handle.db, project.id);

    const deferred = returnProjectToBacklog(
      handle.db,
      project.id,
      undefined,
      project.revision + 1,
      "2030-01-15T00:00:00.000Z",
    );

    expect(deferred.status).toBe("backlog");
    expect(deferred.revisitAt).toBe("2030-01-15T00:00:00.000Z");
  });

  it("throws a not-found AppError for a nonexistent project on every transition", () => {
    expect(() => activateProject(handle.db, 999999)).toThrow(/not found/);
    expect(() => returnProjectToBacklog(handle.db, 999999)).toThrow(/not found/);
    expect(() => completeProject(handle.db, 999999)).toThrow(/not found/);
    expect(() => reopenProject(handle.db, 999999)).toThrow(/not found/);
    expect(() => archiveProject(handle.db, 999999)).toThrow(/not found/);
  });

  it("keeps a project's driver update transactional: an invalid tagId rolls back the whole update", () => {
    const anna = createMember(handle.db, "Anna");
    const bob = createMember(handle.db, "Bob");
    const project = createProject(handle.db, { title: "Mit Driver", ownerMemberId: anna.id, status: "active" });

    expect(() =>
      updateProject(handle.db, project.id, {
        ownerMemberId: bob.id,
        tagIds: [999999],
      }),
    ).toThrow();

    // The bogus tag insert's foreign-key failure must have rolled back the
    // whole transaction, including the earlier ownerMemberId update in the
    // same statement batch.
    const reloaded = handle.db
      .select()
      .from(schema.workItems)
      .all()
      .find((p) => p.id === project.id)!;
    expect(reloaded.ownerMemberId).toBe(anna.id);
  });
});
