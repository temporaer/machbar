import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

describe("hierarchy moves: reorder, indent, outdent, change parent, move subtree", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await closeTestContext(ctx);
  });

  async function createProject(title: string) {
    const res = await ctx.app.inject({ method: "POST", url: "/api/projects", payload: { title } });
    return res.json();
  }

  async function createTask(payload: Record<string, unknown>) {
    const res = await ctx.app.inject({ method: "POST", url: "/api/tasks", payload });
    return res.json();
  }

  async function getProjectTasks(projectId: number) {
    const res = await ctx.app.inject({ method: "GET", url: `/api/projects/${projectId}` });
    return res.json().tasks as Array<{ id: number; title: string; position: number }>;
  }

  it("reorders siblings and renormalizes positions", async () => {
    const project = await createProject("Reorder-Projekt");
    await createTask({ projectId: project.id, title: "A" });
    await createTask({ projectId: project.id, title: "B" });
    const c = await createTask({ projectId: project.id, title: "C" });

    await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${c.id}/reorder`,
      payload: { position: 0 },
    });

    const tasks = await getProjectTasks(project.id);
    expect(tasks.map((t) => t.title)).toEqual(["C", "A", "B"]);
    expect(tasks.map((t) => t.position)).toEqual([0, 1, 2]);
  });

  it("indents a task under its previous sibling", async () => {
    const project = await createProject("Indent-Projekt");
    const first = await createTask({ projectId: project.id, title: "Erste" });
    const second = await createTask({ projectId: project.id, title: "Zweite" });

    const indentRes = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${second.id}/indent`,
    });
    expect(indentRes.json().parentTaskId).toBe(first.id);

    const tasks = await getProjectTasks(project.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.title).toBe("Erste");
    expect(tasks[0]).toHaveProperty("children");
  });

  it("rejects indenting the first sibling (no previous sibling to attach to)", async () => {
    const project = await createProject("Indent-Fehler");
    const first = await createTask({ projectId: project.id, title: "Einzige" });
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${first.id}/indent`,
    });
    expect(res.statusCode).toBe(400);
  });

  it("outdents a nested task back to the project root, after its former parent", async () => {
    const project = await createProject("Outdent-Projekt");
    const parent = await createTask({ projectId: project.id, title: "Eltern" });
    const childRes = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${parent.id}/children`,
      payload: { title: "Kind" },
    });
    const child = childRes.json();
    await createTask({ projectId: project.id, title: "Geschwister" });

    const outdentRes = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${child.id}/outdent`,
    });
    expect(outdentRes.json().parentTaskId).toBeNull();
    expect(outdentRes.json().projectId).toBe(project.id);

    const tasks = await getProjectTasks(project.id);
    expect(tasks.map((t) => t.title)).toEqual(["Eltern", "Kind", "Geschwister"]);
  });

  it("rejects outdenting an already top-level task", async () => {
    const project = await createProject("Outdent-Fehler");
    const task = await createTask({ projectId: project.id, title: "Oberste Ebene" });
    const res = await ctx.app.inject({ method: "POST", url: `/api/tasks/${task.id}/outdent` });
    expect(res.statusCode).toBe(400);
  });

  it("changes a task's parent explicitly via /parent", async () => {
    const project = await createProject("Change-Parent-Projekt");
    const newParent = await createTask({ projectId: project.id, title: "Neues Elternteil" });
    const task = await createTask({ projectId: project.id, title: "Wandert" });

    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/parent`,
      payload: { parentTaskId: newParent.id },
    });
    expect(res.json().parentTaskId).toBe(newParent.id);
  });

  it("moves an entire subtree to a different project via move-subtree, cascading the project id", async () => {
    const projectA = await createProject("Projekt A");
    const projectB = await createProject("Projekt B");
    const root = await createTask({ projectId: projectA.id, title: "Wurzel" });
    const childRes = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${root.id}/children`,
      payload: { title: "Unteraufgabe" },
    });
    const child = childRes.json();
    expect(child.projectId).toBe(projectA.id);

    const moveRes = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${root.id}/move-subtree`,
      payload: { projectId: projectB.id },
    });
    expect(moveRes.json().projectId).toBe(projectB.id);

    const childReloaded = await ctx.app.inject({ method: "GET", url: `/api/tasks/${child.id}` });
    expect(childReloaded.json().projectId).toBe(projectB.id);

    const projectATasks = await getProjectTasks(projectA.id);
    expect(projectATasks).toHaveLength(0);
  });

  it("supports the generic /move endpoint for reparenting and repositioning at once", async () => {
    const project = await createProject("Move-Projekt");
    const a = await createTask({ projectId: project.id, title: "A" });
    const b = await createTask({ projectId: project.id, title: "B" });

    const moveRes = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${a.id}/move`,
      payload: { parentTaskId: b.id, position: 0 },
    });
    expect(moveRes.json().parentTaskId).toBe(b.id);
    expect(moveRes.json().position).toBe(0);
  });
});
