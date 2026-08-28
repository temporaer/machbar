import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

describe("tags", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await closeTestContext(ctx);
  });

  it("pre-populates the household and place tags with stable colors", async () => {
    const response = await ctx.app.inject({ method: "GET", url: "/api/tags" });
    expect(response.statusCode).toBe(200);

    const tags = response.json() as Array<{ name: string; color: string }>;
    const byName = new Map(tags.map((tag) => [tag.name, tag]));
    for (const name of [
      "Lars",
      "Lea",
      "Jonas",
      "Hannes",
      "Sarah",
      "Schule",
      "Kita",
      "Urlaub",
      "Haus",
      "Garten",
    ]) {
      expect(byName.get(name)?.color).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("assigns a color when a tag is created and returns it on reuse", async () => {
    const first = await ctx.app.inject({
      method: "POST",
      url: "/api/tags",
      payload: { name: "Sport" },
    });
    const second = await ctx.app.inject({
      method: "POST",
      url: "/api/tags",
      payload: { name: "Sport" },
    });

    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ name: "Sport", color: expect.stringMatching(/^#[0-9a-f]{6}$/i) });
    expect(second.json()).toEqual(first.json());
  });

  it("renames a tag without changing its color or associations", async () => {
    const tag = ctx.handle.sqlite
      .prepare("SELECT id, color FROM tags WHERE name = ?")
      .get("Garten") as { id: number; color: string };
    const project = ctx.handle.sqlite
      .prepare("INSERT INTO projects (title) VALUES (?) RETURNING id")
      .get("Gartenprojekt") as { id: number };
    ctx.handle.sqlite
      .prepare("INSERT INTO project_tags (project_id, tag_id) VALUES (?, ?)")
      .run(project.id, tag.id);

    const response = await ctx.app.inject({
      method: "PATCH",
      url: `/api/tags/${tag.id}`,
      payload: { name: "  Draußen  " },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: tag.id,
      name: "Draußen",
      color: tag.color,
    });
    expect(
      ctx.handle.sqlite
        .prepare("SELECT project_id AS projectId FROM project_tags WHERE tag_id = ?")
        .get(tag.id),
    ).toEqual({ projectId: project.id });
  });

  it("rejects renaming a tag to an existing name", async () => {
    const garden = ctx.handle.sqlite
      .prepare("SELECT id FROM tags WHERE name = ?")
      .get("Garten") as { id: number };

    const response = await ctx.app.inject({
      method: "PATCH",
      url: `/api/tags/${garden.id}`,
      payload: { name: "Haus" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: {
        code: "tag_name_conflict",
        message: "A tag with this name already exists.",
        details: {
          name: "Haus",
          conflictingTagId: expect.any(Number),
        },
      },
    });
  });

  it("deletes a tag and cascades only its project/task associations", async () => {
    const tag = ctx.handle.sqlite
      .prepare("SELECT id FROM tags WHERE name = ?")
      .get("Garten") as { id: number };
    const project = ctx.handle.sqlite
      .prepare("INSERT INTO projects (title) VALUES (?) RETURNING id")
      .get("Gartenprojekt") as { id: number };
    const task = ctx.handle.sqlite
      .prepare("INSERT INTO tasks (title, project_id) VALUES (?, ?) RETURNING id")
      .get("Hecke schneiden", project.id) as { id: number };
    ctx.handle.sqlite
      .prepare("INSERT INTO project_tags (project_id, tag_id) VALUES (?, ?)")
      .run(project.id, tag.id);
    ctx.handle.sqlite
      .prepare("INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)")
      .run(task.id, tag.id);
    ctx.handle.sqlite
      .prepare("INSERT INTO task_excluded_tags (task_id, tag_id) VALUES (?, ?)")
      .run(task.id, tag.id);

    const response = await ctx.app.inject({ method: "DELETE", url: `/api/tags/${tag.id}` });
    expect(response.statusCode).toBe(204);
    expect(ctx.handle.sqlite.prepare("SELECT count(*) AS count FROM project_tags WHERE tag_id = ?").get(tag.id))
      .toEqual({ count: 0 });
    expect(ctx.handle.sqlite.prepare("SELECT count(*) AS count FROM task_tags WHERE tag_id = ?").get(tag.id))
      .toEqual({ count: 0 });
    expect(ctx.handle.sqlite.prepare("SELECT count(*) AS count FROM task_excluded_tags WHERE tag_id = ?").get(tag.id))
      .toEqual({ count: 0 });
    expect(ctx.handle.sqlite.prepare("SELECT id FROM projects WHERE id = ?").get(project.id)).toEqual({ id: project.id });
    expect(ctx.handle.sqlite.prepare("SELECT id FROM tasks WHERE id = ?").get(task.id)).toEqual({ id: task.id });

    const missing = await ctx.app.inject({ method: "DELETE", url: `/api/tags/${tag.id}` });
    expect(missing.statusCode).toBe(404);
  });
});
