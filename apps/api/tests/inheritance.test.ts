import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../src/db/schema.js";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

describe("effective owner/context/tags inheritance", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await closeTestContext(ctx);
  });

  function createMember(name: string) {
    // Members are seed-only in this API; insert directly for isolated tests.
    return ctx.handle.db
      .insert(schema.members)
      .values({ name, color: "#000000" })
      .returning()
      .get();
  }

  it("inherits owner, context and tags down a project -> task -> subtask chain", async () => {
    const owner = createMember("Anna");
    const tag = (
      await ctx.app.inject({ method: "POST", url: "/api/tags", payload: { name: "Zuhause" } })
    ).json();

    const project = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          title: "Testprojekt",
          ownerMemberId: owner.id,
          context: "Büro",
          tagIds: [tag.id],
        },
      })
    ).json();

    const parentTask = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: { projectId: project.id, title: "Elternaufgabe" },
      })
    ).json();

    expect(parentTask.effectiveOwnerId).toBe(owner.id);
    expect(parentTask.effectiveOwnerSource).toBe("project");
    expect(parentTask.effectiveContext).toBe("Büro");
    expect(parentTask.effectiveContextSource).toBe("project");
    expect(parentTask.effectiveTags.map((t: { id: number }) => t.id)).toContain(tag.id);

    const childTask = (
      await ctx.app.inject({
        method: "POST",
        url: `/api/tasks/${parentTask.id}/children`,
        payload: { title: "Teilaufgabe" },
      })
    ).json();

    expect(childTask.projectId).toBe(project.id);
    expect(childTask.effectiveOwnerId).toBe(owner.id);
    // Still labelled "project" (not "parent") because nothing along the
    // parent chain overrides the owner/context explicitly.
    expect(childTask.effectiveOwnerSource).toBe("project");
    expect(childTask.effectiveContext).toBe("Büro");
    expect(childTask.effectiveContextSource).toBe("project");
    expect(childTask.effectiveTags.map((t: { id: number }) => t.id)).toContain(tag.id);
  });

  it("labels inheritance as 'parent' once an ancestor task sets an explicit override", async () => {
    const projectOwner = createMember("Projektinhaber");
    const parentOwner = createMember("Elternzuständiger");
    const project = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { title: "Projekt mit Override", ownerMemberId: projectOwner.id, context: "Büro" },
      })
    ).json();

    const parentTask = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: {
          projectId: project.id,
          title: "Elternaufgabe mit eigener Zuständigkeit",
          ownerMemberId: parentOwner.id,
          ownerInheritanceMode: "explicit",
          context: "Telefon",
          contextInheritanceMode: "explicit",
        },
      })
    ).json();

    const childTask = (
      await ctx.app.inject({
        method: "POST",
        url: `/api/tasks/${parentTask.id}/children`,
        payload: { title: "Geerbtes Kind" },
      })
    ).json();

    expect(childTask.effectiveOwnerId).toBe(parentOwner.id);
    expect(childTask.effectiveOwnerSource).toBe("parent");
    expect(childTask.effectiveContext).toBe("Telefon");
    expect(childTask.effectiveContextSource).toBe("parent");
  });

  it("lets a task override inheritance explicitly or opt out with 'none'", async () => {
    const owner = createMember("Jonas");
    const project = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { title: "Projekt", ownerMemberId: owner.id, context: "Garten" },
      })
    ).json();

    const otherOwner = createMember("Mia");
    const explicitTask = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: {
          projectId: project.id,
          title: "Eigene Zuständigkeit",
          ownerMemberId: otherOwner.id,
          ownerInheritanceMode: "explicit",
          context: "Telefon",
          contextInheritanceMode: "explicit",
        },
      })
    ).json();
    expect(explicitTask.effectiveOwnerId).toBe(otherOwner.id);
    expect(explicitTask.effectiveOwnerSource).toBe("task");
    expect(explicitTask.effectiveContext).toBe("Telefon");
    expect(explicitTask.effectiveContextSource).toBe("task");

    const noneTask = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: {
          projectId: project.id,
          title: "Ohne Zuständigkeit",
          ownerInheritanceMode: "none",
          contextInheritanceMode: "none",
        },
      })
    ).json();
    expect(noneTask.effectiveOwnerId).toBeNull();
    expect(noneTask.effectiveOwnerSource).toBe("none");
    expect(noneTask.effectiveContext).toBeNull();
    expect(noneTask.effectiveContextSource).toBe("none");
  });

  it("excludes a specific inherited tag while keeping the task's own explicit tags", async () => {
    const tagA = (
      await ctx.app.inject({ method: "POST", url: "/api/tags", payload: { name: "TagA" } })
    ).json();
    const tagB = (
      await ctx.app.inject({ method: "POST", url: "/api/tags", payload: { name: "TagB" } })
    ).json();

    const project = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { title: "Projekt mit Tags", tagIds: [tagA.id] },
      })
    ).json();

    const task = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: { projectId: project.id, title: "Aufgabe" },
      })
    ).json();
    expect(task.effectiveTags.map((t: { id: number }) => t.id)).toEqual([tagA.id]);

    const updated = (
      await ctx.app.inject({
        method: "PATCH",
        url: `/api/tasks/${task.id}`,
        payload: { tagIds: [tagB.id], excludedTagIds: [tagA.id] },
      })
    ).json();

    const ids = updated.effectiveTags.map((t: { id: number }) => t.id).sort();
    expect(ids).toEqual([tagB.id]);
    expect(updated.explicitTags.map((t: { id: number }) => t.id)).toEqual([tagB.id]);
  });
});
