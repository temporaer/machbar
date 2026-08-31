import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDb, type DbHandle } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import * as schema from "../src/db/schema.js";
import {
  activateProject,
  archiveProject,
  completeProject,
  createMember,
  createProject as createProjectMutation,
  createTask,
  reopenProject,
  returnProjectToBacklog,
  updateProject,
} from "../src/domain/mutations.js";
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
  db.update(schema.projects)
    .set({ status: "active" })
    .where(eq(schema.projects.id, project.id))
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
        .prepare("UPDATE projects SET status = 'active' WHERE id = ?")
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
            scheduledDate: "2099-01-01",
          },
        })
      ).json();
      await ctx.app.inject({
        method: "PUT",
        url: `/api/tasks/${task.id}/external-wait`,
        payload: { waitingFor: "Reply" },
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
    expect(handle.db.select().from(schema.projects).all()).toEqual([]);
  });

  it("re-activates an archived, previously-active project without requiring the driver again", () => {
    const anna = createMember(handle.db, "Anna");
    const project = createProject(handle.db, { title: "Aktiviert", ownerMemberId: anna.id });
    createTask(handle.db, { title: "Next action", projectId: project.id });
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
