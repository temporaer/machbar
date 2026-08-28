import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DbHandle } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import * as schema from "../src/db/schema.js";
import {
  activateProject,
  archiveProject,
  completeProject,
  createMember,
  createProject,
  reopenProject,
  returnProjectToBacklog,
  updateProject,
} from "../src/domain/mutations.js";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

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
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { title: "Testprojekt", ...payload },
    });
    return res.json();
  }

  it("defaults a newly created project to backlog with activate/archive as its only actions", async () => {
    const project = await createProjectRoute();
    expect(project.status).toBe("backlog");
    expect(project.availableActions.sort()).toEqual(["activate", "archive"]);
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

  it("activates a project by supplying a driver in the same call", async () => {
    const anna = await createMemberRoute("Anna");
    const project = await createProjectRoute();

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
    expect(archived.availableActions.sort()).toEqual(["activate", "return_to_backlog"].sort());

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

  it("re-activates an archived, previously-active project without requiring the driver again", () => {
    const anna = createMember(handle.db, "Anna");
    const project = createProject(handle.db, { title: "Aktiviert", ownerMemberId: anna.id });
    activateProject(handle.db, project.id);
    archiveProject(handle.db, project.id);

    const reactivated = activateProject(handle.db, project.id);
    expect(reactivated.status).toBe("active");
    expect(reactivated.ownerMemberId).toBe(anna.id);
  });

  it("lets return-to-backlog pull an archived project back too", () => {
    const project = createProject(handle.db, { title: "Ohne Driver" });
    archiveProject(handle.db, project.id);

    const backToBacklog = returnProjectToBacklog(handle.db, project.id);
    expect(backToBacklog.status).toBe("backlog");
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
      .from(schema.projects)
      .all()
      .find((p) => p.id === project.id)!;
    expect(reloaded.ownerMemberId).toBe(anna.id);
  });
});
