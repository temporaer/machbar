import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../src/db/schema.js";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

describe("effective owner and typed-tag inheritance", () => {
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

  it("inherits owner and typed tags down a project -> task -> subtask chain", async () => {
    const owner = createMember("Anna");
    const tag = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/tags",
        payload: { name: "Zuhause", kind: "area" },
      })
    ).json();

    const project = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          title: "Testprojekt",
          ownerMemberId: owner.id,
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
    expect(parentTask.inheritedOwnerId).toBe(owner.id);
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
    expect(childTask.inheritedOwnerId).toBe(owner.id);
    // Still labelled "project" because nothing in the parent chain overrides ownership.
    expect(childTask.effectiveOwnerSource).toBe("project");
    expect(childTask.effectiveTags.map((t: { id: number }) => t.id)).toContain(tag.id);
  });

  it("keeps every project task creation and refile path in owner inheritance by default", async () => {
    const owner = createMember("Projektinhaber");
    const project = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { title: "Lastenrad überholen", ownerMemberId: owner.id },
      })
    ).json();

    const direct = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: { projectId: project.id, title: "Direkter Schritt" },
      })
    ).json();
    const child = (
      await ctx.app.inject({
        method: "POST",
        url: `/api/tasks/${direct.id}/children`,
        payload: { title: "Teilaufgabe" },
      })
    ).json();
    const successor = (
      await ctx.app.inject({
        method: "POST",
        url: `/api/tasks/${direct.id}/successors`,
        payload: { title: "Nachfolger" },
      })
    ).json();
    const sequence = (
      await ctx.app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/task-sequence`,
        payload: { titles: ["Ablauf eins", "Ablauf zwei"] },
      })
    ).json();
    const captured = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: { title: "Erst im Eingang", status: "actionable" },
      })
    ).json();
    const refiled = (
      await ctx.app.inject({
        method: "POST",
        url: `/api/tasks/${captured.id}/move`,
        payload: {
          parentTaskId: null,
          projectId: project.id,
          expectedRevision: captured.revision,
        },
      })
    ).json();

    expect(captured.inheritedOwnerId).toBeNull();
    for (const task of [direct, child, successor, ...sequence, refiled]) {
      expect(task).toMatchObject({
        ownerMemberId: null,
        ownerInheritanceMode: "inherit",
        effectiveOwnerId: owner.id,
        effectiveOwnerSource: "project",
        inheritedOwnerId: owner.id,
        projectOwnerMemberId: owner.id,
      });
    }
  });

  it("labels inheritance as 'parent' once an ancestor task sets an explicit override", async () => {
    const projectOwner = createMember("Projektinhaber");
    const parentOwner = createMember("Elternzuständiger");
    const project = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { title: "Projekt mit Override", ownerMemberId: projectOwner.id },
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
    expect(parentTask.inheritedOwnerId).toBe(projectOwner.id);
    expect(childTask.inheritedOwnerId).toBe(parentOwner.id);
  });

  it("lets a task override inheritance explicitly or opt out with 'none'", async () => {
    const owner = createMember("Jonas");
    const project = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { title: "Projekt", ownerMemberId: owner.id },
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
        },
      })
    ).json();
    expect(explicitTask.effectiveOwnerId).toBe(otherOwner.id);
    expect(explicitTask.effectiveOwnerSource).toBe("task");
    expect(explicitTask.inheritedOwnerId).toBe(owner.id);

    const noneTask = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: {
          projectId: project.id,
          title: "Ohne Zuständigkeit",
          ownerInheritanceMode: "none",
        },
      })
    ).json();
    expect(noneTask.effectiveOwnerId).toBeNull();
    expect(noneTask.effectiveOwnerSource).toBe("none");
    expect(noneTask.inheritedOwnerId).toBe(owner.id);
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

  it("rolls typed task tags up to the project and selects one deterministic primary area", async () => {
    const explicitArea = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/tags",
        payload: { name: "Haus", kind: "area" },
      })
    ).json();
    const derivedArea = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/tags",
        payload: { name: "Garten", kind: "area" },
      })
    ).json();
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
        payload: { title: "Sanierung", tagIds: [explicitArea.id] },
      })
    ).json();
    for (const title of ["Beet planen", "Pflanzen kaufen"]) {
      await ctx.app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: {
          projectId: project.id,
          title,
          tagIds: [derivedArea.id, actor.id],
        },
      });
    }

    const detail = (
      await ctx.app.inject({
        method: "GET",
        url: `/api/projects/${project.id}`,
      })
    ).json();
    expect(detail.effectiveAreaTags.map((tag: { id: number }) => tag.id)).toEqual(
      expect.arrayContaining([explicitArea.id, derivedArea.id]),
    );
    expect(detail.effectiveTags.map((tag: { id: number }) => tag.id)).toContain(
      actor.id,
    );
    expect(detail.primaryAreaTag.id).toBe(explicitArea.id);

    await ctx.app.inject({
      method: "PATCH",
      url: `/api/tags/${explicitArea.id}`,
      payload: { groupingMode: "hidden" },
    });
    const regrouped = (
      await ctx.app.inject({
        method: "GET",
        url: `/api/projects/${project.id}`,
      })
    ).json();
    expect(regrouped.primaryAreaTag.id).toBe(derivedArea.id);

    const pinnedArea = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/tags",
        payload: { name: "Verwaltung", kind: "area" },
      })
    ).json();
    await ctx.app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: {
        projectId: project.id,
        title: "Antrag stellen",
        tagIds: [pinnedArea.id],
      },
    });
    await ctx.app.inject({
      method: "PATCH",
      url: `/api/tags/${pinnedArea.id}`,
      payload: { groupingMode: "pinned", sortPosition: 0 },
    });
    const pinned = (
      await ctx.app.inject({
        method: "GET",
        url: `/api/projects/${project.id}`,
      })
    ).json();
    expect(pinned.primaryAreaTag.id).toBe(pinnedArea.id);
  });
});
