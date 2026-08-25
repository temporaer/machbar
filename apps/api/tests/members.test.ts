import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

describe("household member create / rename / delete", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await closeTestContext(ctx);
  });

  async function createMember(name: string) {
    return ctx.app.inject({ method: "POST", url: "/api/members", payload: { name } });
  }

  it("creates a member from just a name", async () => {
    const res = await createMember("Lea Weber");
    expect(res.statusCode).toBe(201);
    const member = res.json();
    expect(member.name).toBe("Lea Weber");
    expect(member.id).toBeTypeOf("number");

    const listRes = await ctx.app.inject({ method: "GET", url: "/api/members" });
    expect(listRes.json().map((m: { name: string }) => m.name)).toContain("Lea Weber");
  });

  it("trims whitespace around the name on create", async () => {
    const res = await createMember("   Tom Fischer   ");
    expect(res.statusCode).toBe(201);
    expect(res.json().name).toBe("Tom Fischer");
  });

  it("rejects an empty or whitespace-only name on create", async () => {
    const emptyRes = await createMember("");
    expect(emptyRes.statusCode).toBe(400);

    const blankRes = await createMember("   ");
    expect(blankRes.statusCode).toBe(400);
  });

  it("rejects a duplicate name (after trimming) on create", async () => {
    const first = await createMember("Nina Bauer");
    expect(first.statusCode).toBe(201);

    const duplicate = await createMember("Nina Bauer");
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.message).toContain("existiert bereits");

    const duplicateWithWhitespace = await createMember("  Nina Bauer  ");
    expect(duplicateWithWhitespace.statusCode).toBe(409);
  });

  it("renames a member", async () => {
    const created = (await createMember("Alte Bezeichnung")).json();

    const renameRes = await ctx.app.inject({
      method: "PATCH",
      url: `/api/members/${created.id}`,
      payload: { name: "Neue Bezeichnung" },
    });
    expect(renameRes.statusCode).toBe(200);
    expect(renameRes.json().name).toBe("Neue Bezeichnung");

    const listRes = await ctx.app.inject({ method: "GET", url: "/api/members" });
    const names = listRes.json().map((m: { name: string }) => m.name);
    expect(names).toContain("Neue Bezeichnung");
    expect(names).not.toContain("Alte Bezeichnung");
  });

  it("rejects renaming to an empty name", async () => {
    const created = (await createMember("Bleibt so")).json();
    const res = await ctx.app.inject({
      method: "PATCH",
      url: `/api/members/${created.id}`,
      payload: { name: "   " },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects renaming to a name already used by another member", async () => {
    const first = (await createMember("Erste Person")).json();
    await createMember("Zweite Person");

    const res = await ctx.app.inject({
      method: "PATCH",
      url: `/api/members/${first.id}`,
      payload: { name: "Zweite Person" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("allows renaming a member to its own current name (no false conflict)", async () => {
    const created = (await createMember("Gleicher Name")).json();
    const res = await ctx.app.inject({
      method: "PATCH",
      url: `/api/members/${created.id}`,
      payload: { name: "Gleicher Name" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("returns 404 when renaming or deleting a member that doesn't exist", async () => {
    const renameRes = await ctx.app.inject({
      method: "PATCH",
      url: "/api/members/999999",
      payload: { name: "Irrelevant" },
    });
    expect(renameRes.statusCode).toBe(404);

    const deleteRes = await ctx.app.inject({
      method: "DELETE",
      url: "/api/members/999999",
    });
    expect(deleteRes.statusCode).toBe(404);
  });

  it("deletes a member that isn't referenced by anything", async () => {
    const created = (await createMember("Wird gelöscht")).json();
    const res = await ctx.app.inject({ method: "DELETE", url: `/api/members/${created.id}` });
    expect(res.statusCode).toBe(204);

    const listRes = await ctx.app.inject({ method: "GET", url: "/api/members" });
    expect(listRes.json().map((m: { id: number }) => m.id)).not.toContain(created.id);
  });

  it("deletes a member who owns a project, nulling the project's owner but keeping the project", async () => {
    const member = (await createMember("Projekt-Besitzerin")).json();
    const project = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { title: "Ein Projekt", ownerMemberId: member.id },
      })
    ).json();

    const res = await ctx.app.inject({ method: "DELETE", url: `/api/members/${member.id}` });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe("");

    const listRes = await ctx.app.inject({ method: "GET", url: "/api/members" });
    expect(listRes.json().map((m: { id: number }) => m.id)).not.toContain(member.id);

    const projectRes = await ctx.app.inject({ method: "GET", url: `/api/projects/${project.id}` });
    expect(projectRes.statusCode).toBe(200);
    expect(projectRes.json().ownerMemberId).toBeNull();
  });

  it("deletes a member who owns a task, nulling the task's owner but keeping the task", async () => {
    const member = (await createMember("Aufgaben-Besitzer")).json();
    const task = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: { title: "Eine Aufgabe", ownerMemberId: member.id, ownerInheritanceMode: "explicit" },
      })
    ).json();

    const res = await ctx.app.inject({ method: "DELETE", url: `/api/members/${member.id}` });
    expect(res.statusCode).toBe(204);

    const taskRes = await ctx.app.inject({ method: "GET", url: `/api/tasks/${task.id}` });
    expect(taskRes.statusCode).toBe(200);
    expect(taskRes.json().ownerMemberId).toBeNull();
    // The inheritance mode itself is untouched: "explicit" + null owner is a
    // valid, already-supported state (an explicitly unassigned task).
    expect(taskRes.json().ownerInheritanceMode).toBe("explicit");
  });

  it("deletes a member who created a task, even if they don't own it, keeping the task", async () => {
    const member = (await createMember("Ersteller")).json();
    const task = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: { title: "Fremdaufgabe", createdByMemberId: member.id },
      })
    ).json();

    const res = await ctx.app.inject({ method: "DELETE", url: `/api/members/${member.id}` });
    expect(res.statusCode).toBe(204);

    const taskRes = await ctx.app.inject({ method: "GET", url: `/api/tasks/${task.id}` });
    expect(taskRes.statusCode).toBe(200);
    expect(taskRes.json().createdByMemberId).toBeNull();
  });

  it("clears every reference (project owner, task owner, task creator) in one atomic transaction", async () => {
    const member = (await createMember("Vielfach Verknüpft")).json();
    const project = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { title: "Gemeinsames Projekt", ownerMemberId: member.id },
      })
    ).json();
    const task = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: {
          title: "Aufgabe mit doppelter Zuordnung",
          projectId: project.id,
          ownerMemberId: member.id,
          ownerInheritanceMode: "explicit",
          createdByMemberId: member.id,
        },
      })
    ).json();

    const res = await ctx.app.inject({ method: "DELETE", url: `/api/members/${member.id}` });
    expect(res.statusCode).toBe(204);

    const projectRes = (
      await ctx.app.inject({ method: "GET", url: `/api/projects/${project.id}` })
    ).json();
    expect(projectRes.ownerMemberId).toBeNull();

    const taskRes = (await ctx.app.inject({ method: "GET", url: `/api/tasks/${task.id}` })).json();
    expect(taskRes.ownerMemberId).toBeNull();
    expect(taskRes.createdByMemberId).toBeNull();
    // The task itself, and its project link, both survive the deletion.
    expect(taskRes.projectId).toBe(project.id);
  });

  it("leaves everything untouched (transactionally) when deleting a member that doesn't exist", async () => {
    const member = (await createMember("Bleibt bestehen")).json();
    const project = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { title: "Unberührtes Projekt", ownerMemberId: member.id },
      })
    ).json();

    const res = await ctx.app.inject({ method: "DELETE", url: "/api/members/999999" });
    expect(res.statusCode).toBe(404);

    const projectRes = (
      await ctx.app.inject({ method: "GET", url: `/api/projects/${project.id}` })
    ).json();
    expect(projectRes.ownerMemberId).toBe(member.id);

    const listRes = await ctx.app.inject({ method: "GET", url: "/api/members" });
    expect(listRes.json().map((m: { id: number }) => m.id)).toContain(member.id);
  });
});

describe("household member deletion against seeded, referenced sample data", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext({ seed: true });
  });

  afterEach(async () => {
    await closeTestContext(ctx);
  });

  it("deletes every seeded member, even though all of them own/create projects and tasks", async () => {
    const membersBefore = (await ctx.app.inject({ method: "GET", url: "/api/members" })).json() as Array<{
      id: number;
      name: string;
    }>;
    expect(membersBefore.length).toBeGreaterThan(0);

    const projectsBefore = (
      await ctx.app.inject({ method: "GET", url: "/api/projects" })
    ).json() as Array<{ id: number }>;
    const tasksBefore = (
      await ctx.app.inject({ method: "GET", url: "/api/search" })
    ).json() as Array<{ id: number }>;
    expect(projectsBefore.length).toBeGreaterThan(0);
    expect(tasksBefore.length).toBeGreaterThan(0);

    for (const member of membersBefore) {
      const res = await ctx.app.inject({ method: "DELETE", url: `/api/members/${member.id}` });
      expect(res.statusCode).toBe(204);
    }

    const membersAfter = (await ctx.app.inject({ method: "GET", url: "/api/members" })).json();
    expect(membersAfter).toEqual([]);

    const projectsAfter = (
      await ctx.app.inject({ method: "GET", url: "/api/projects" })
    ).json() as Array<{ id: number; ownerMemberId: number | null }>;
    expect(projectsAfter.map((p) => p.id).sort()).toEqual(projectsBefore.map((p) => p.id).sort());
    for (const project of projectsAfter) {
      expect(project.ownerMemberId).toBeNull();
    }

    const tasksAfter = (
      await ctx.app.inject({ method: "GET", url: "/api/search" })
    ).json() as Array<{ id: number; ownerMemberId: number | null; createdByMemberId: number | null }>;
    expect(tasksAfter.map((t) => t.id).sort()).toEqual(tasksBefore.map((t) => t.id).sort());
    for (const task of tasksAfter) {
      expect(task.ownerMemberId).toBeNull();
      expect(task.createdByMemberId).toBeNull();
    }
  });
});
