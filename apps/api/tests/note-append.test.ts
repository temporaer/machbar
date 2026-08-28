import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

describe("append-only task and project notes", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await closeTestContext(ctx);
  });

  async function createTask(notes = "") {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { title: "Aufgabe", notes },
    });
    return response.json() as { id: number; notes: string };
  }

  async function createProject(notes = "") {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { title: "Projekt", notes },
    });
    return response.json() as { id: number; notes: string };
  }

  it("adds trimmed content to empty task notes", async () => {
    const task = await createTask();

    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/notes`,
      payload: { content: "  Neue Notiz  " },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().notes).toBe("Neue Notiz");
  });

  it("appends task notes instead of replacing existing content", async () => {
    const task = await createTask("Erste Notiz");

    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/notes`,
      payload: { content: "Zweite Notiz" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().notes).toBe("Erste Notiz\n\nZweite Notiz");
  });

  it("does not rewrite existing note whitespace while appending", async () => {
    const task = await createTask("Erste Notiz  ");

    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/notes`,
      payload: { content: "Zweite Notiz" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().notes).toBe("Erste Notiz  \n\nZweite Notiz");
  });

  it("uses one blank line between project note blocks despite edge newlines", async () => {
    const project = await createProject("Erste Notiz\n\n");

    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/notes`,
      payload: { content: "\n\nZweite Notiz\n\n" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().notes).toBe("Erste Notiz\n\nZweite Notiz");
  });

  it("leaves existing notes unchanged when blank content is appended", async () => {
    const project = await createProject("Bestehende Notiz");

    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/notes`,
      payload: { content: " \n\t " },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().notes).toBe("Bestehende Notiz");
  });

  it.each([
    "/api/tasks/999999/notes",
    "/api/projects/999999/notes",
  ])("returns the established not-found response for %s", async (url) => {
    const response = await ctx.app.inject({
      method: "POST",
      url,
      payload: { content: "Notiz" },
    });

    expect(response.statusCode).toBe(404);
    const taskRequest = url.startsWith("/api/tasks/");
    expect(response.json().error).toMatchObject({
      code: taskRequest ? "task_not_found" : "project_not_found",
      details: taskRequest ? { taskId: 999999 } : { projectId: 999999 },
    });
  });
});
