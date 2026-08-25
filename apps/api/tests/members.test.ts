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

  it("refuses with a German conflict error to delete a member who owns a project", async () => {
    const member = (await createMember("Projekt-Besitzerin")).json();
    await ctx.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { title: "Ein Projekt", ownerMemberId: member.id },
    });

    const res = await ctx.app.inject({ method: "DELETE", url: `/api/members/${member.id}` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain("kann nicht gelöscht werden");

    const listRes = await ctx.app.inject({ method: "GET", url: "/api/members" });
    expect(listRes.json().map((m: { id: number }) => m.id)).toContain(member.id);
  });

  it("refuses to delete a member who owns a task", async () => {
    const member = (await createMember("Aufgaben-Besitzer")).json();
    await ctx.app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { title: "Eine Aufgabe", ownerMemberId: member.id, ownerInheritanceMode: "explicit" },
    });

    const res = await ctx.app.inject({ method: "DELETE", url: `/api/members/${member.id}` });
    expect(res.statusCode).toBe(409);
  });

  it("refuses to delete a member who created a task, even if they don't own it", async () => {
    const member = (await createMember("Ersteller")).json();
    await ctx.app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { title: "Fremdaufgabe", createdByMemberId: member.id },
    });

    const res = await ctx.app.inject({ method: "DELETE", url: `/api/members/${member.id}` });
    expect(res.statusCode).toBe(409);
  });

  it("allows deleting a member again once no project/task references remain", async () => {
    const member = (await createMember("Bald frei")).json();
    const project = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { title: "Temporäres Projekt", ownerMemberId: member.id },
      })
    ).json();

    const blockedDelete = await ctx.app.inject({
      method: "DELETE",
      url: `/api/members/${member.id}`,
    });
    expect(blockedDelete.statusCode).toBe(409);

    await ctx.app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}`,
      payload: { ownerMemberId: null },
    });

    const allowedDelete = await ctx.app.inject({
      method: "DELETE",
      url: `/api/members/${member.id}`,
    });
    expect(allowedDelete.statusCode).toBe(204);
  });
});
