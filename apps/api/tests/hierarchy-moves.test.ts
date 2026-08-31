import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

describe("canonical hierarchy moves", () => {
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
    return res.json().tasks as Array<{
      id: number;
      title: string;
      position: number;
      revision: number;
    }>;
  }

  async function getTask(taskId: number) {
    const res = await ctx.app.inject({ method: "GET", url: `/api/tasks/${taskId}` });
    return res.json();
  }

  it("reorders siblings and renormalizes positions", async () => {
    const project = await createProject("Reorder-Projekt");
    const a = await createTask({ projectId: project.id, title: "A" });
    const b = await createTask({ projectId: project.id, title: "B" });
    const c = await createTask({ projectId: project.id, title: "C" });

    await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${c.id}/move`,
      payload: {
        parentTaskId: null,
        projectId: project.id,
        position: 0,
        expectedRevision: c.revision,
      },
    });

    const tasks = await getProjectTasks(project.id);
    expect(tasks.map((t) => t.title)).toEqual(["C", "A", "B"]);
    expect(tasks.map((t) => t.position)).toEqual([0, 1, 2]);
    expect(tasks.find((t) => t.id === c.id)?.revision).toBe(c.revision + 1);
    expect(tasks.find((t) => t.id === a.id)?.revision).toBe(a.revision);
    expect(tasks.find((t) => t.id === b.id)?.revision).toBe(b.revision);
  });

  it("indents a task under its previous sibling", async () => {
    const project = await createProject("Indent-Projekt");
    const first = await createTask({ projectId: project.id, title: "Erste" });
    const second = await createTask({ projectId: project.id, title: "Zweite" });

    const moveRes = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${second.id}/move`,
      payload: {
        parentTaskId: first.id,
        position: 0,
        expectedRevision: second.revision,
      },
    });
    expect(moveRes.json().parentTaskId).toBe(first.id);

    const tasks = await getProjectTasks(project.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.title).toBe("Erste");
    expect(tasks[0]).toHaveProperty("children");
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
      url: `/api/tasks/${child.id}/move`,
      payload: {
        parentTaskId: null,
        projectId: project.id,
        position: 1,
        expectedRevision: child.revision,
      },
    });
    expect(outdentRes.json().parentTaskId).toBeNull();
    expect(outdentRes.json().projectId).toBe(project.id);

    const tasks = await getProjectTasks(project.id);
    expect(tasks.map((t) => t.title)).toEqual(["Eltern", "Kind", "Geschwister"]);
  });

  it("changes a task's parent explicitly", async () => {
    const project = await createProject("Change-Parent-Projekt");
    const newParent = await createTask({ projectId: project.id, title: "Neues Elternteil" });
    const task = await createTask({ projectId: project.id, title: "Wandert" });

    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/move`,
      payload: {
        parentTaskId: newParent.id,
        position: 0,
        expectedRevision: task.revision,
      },
    });
    expect(res.json().parentTaskId).toBe(newParent.id);
  });

  it("moves an entire subtree to a different project, cascading the project id", async () => {
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
      url: `/api/tasks/${root.id}/move`,
      payload: {
        parentTaskId: null,
        projectId: projectB.id,
        expectedRevision: root.revision,
      },
    });
    expect(moveRes.json().projectId).toBe(projectB.id);

    const childReloaded = await ctx.app.inject({ method: "GET", url: `/api/tasks/${child.id}` });
    expect(childReloaded.json().projectId).toBe(projectB.id);

    const projectATasks = await getProjectTasks(projectA.id);
    expect(projectATasks).toHaveLength(0);
  });

  it("reparents and repositions at once", async () => {
    const project = await createProject("Move-Projekt");
    const a = await createTask({ projectId: project.id, title: "A" });
    const b = await createTask({ projectId: project.id, title: "B" });

    const currentA = await getTask(a.id);
    const moveRes = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${a.id}/move`,
      payload: {
        parentTaskId: b.id,
        position: 0,
        expectedRevision: currentA.revision,
      },
    });
    expect(moveRes.json().parentTaskId).toBe(b.id);
    expect(moveRes.json().position).toBe(0);
  });

  it("rejects moving a task under its own descendant", async () => {
    const project = await createProject("Zyklus-Projekt");
    const root = await createTask({ projectId: project.id, title: "Wurzel" });
    const childRes = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${root.id}/children`,
      payload: { title: "Kind" },
    });
    const child = childRes.json();

    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${root.id}/move`,
      payload: {
        parentTaskId: child.id,
        position: 0,
        expectedRevision: root.revision,
      },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("task_hierarchy_cycle");
  });

  it("rejects a stale structural move without changing the hierarchy", async () => {
    const project = await createProject("Konflikt-Projekt");
    const first = await createTask({ projectId: project.id, title: "A" });
    const second = await createTask({ projectId: project.id, title: "B" });
    const currentFirst = await getTask(first.id);

    const accepted = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${first.id}/move`,
      payload: {
        parentTaskId: null,
        projectId: project.id,
        position: 1,
        expectedRevision: currentFirst.revision,
      },
    });
    expect(accepted.statusCode).toBe(200);

    const stale = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${first.id}/move`,
      payload: {
        parentTaskId: second.id,
        position: 0,
        expectedRevision: currentFirst.revision,
      },
    });

    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("stale_write_conflict");
    expect((await getTask(first.id)).parentTaskId).toBeNull();
  });
});
