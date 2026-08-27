import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../src/db/schema.js";
import { createProject, createTask } from "../src/domain/mutations.js";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

describe("capture query views", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await closeTestContext(ctx);
  });

  it("/api/inbox selects captured tasks regardless of project placement", async () => {
    const project = createProject(ctx.handle.db, {
      title: "Capture-Projekt",
    });
    const inProject = createTask(ctx.handle.db, {
      projectId: project.id,
      title: "Im Projekt erfasst",
      status: "captured",
    });
    const topLevel = createTask(ctx.handle.db, {
      title: "Geklärter Eingangskandidat",
      status: "actionable",
      needsClarification: false,
    });

    const response = await ctx.app.inject({ method: "GET", url: "/api/inbox" });
    expect(response.statusCode).toBe(200);
    const ids = response.json().map((task: { id: number }) => task.id);
    expect(ids).toContain(inProject.id);
    expect(ids).not.toContain(topLevel.id);
  });

  it("/api/inbox returns a clarification-only forest without leaked or duplicate descendants", async () => {
    const project = createProject(ctx.handle.db, { title: "Baum-Projekt" });
    const capturedParent = createTask(ctx.handle.db, {
      projectId: project.id,
      title: "Erfasster Elternteil",
      needsClarification: true,
    });
    const capturedChild = createTask(ctx.handle.db, {
      parentTaskId: capturedParent.id,
      title: "Erfasstes Kind",
      needsClarification: true,
    });
    const clarifiedChild = createTask(ctx.handle.db, {
      parentTaskId: capturedParent.id,
      title: "Geklärtes Kind",
      needsClarification: false,
    });
    const capturedGrandchild = createTask(ctx.handle.db, {
      parentTaskId: clarifiedChild.id,
      title: "Erfasster Enkel",
      needsClarification: true,
    });

    const response = await ctx.app.inject({ method: "GET", url: "/api/inbox" });
    expect(response.statusCode).toBe(200);
    const tasks = response.json() as Array<{
      id: number;
      children: Array<{ id: number }>;
    }>;

    expect(tasks.map((task) => task.id)).toEqual(
      expect.arrayContaining([capturedParent.id, capturedGrandchild.id]),
    );
    expect(tasks.map((task) => task.id)).not.toContain(capturedChild.id);
    expect(tasks.find((task) => task.id === capturedParent.id)?.children).toEqual([
      expect.objectContaining({ id: capturedChild.id }),
    ]);
    expect(
      tasks.flatMap((task) => task.children).some((task) => task.id === clarifiedChild.id),
    ).toBe(false);
  });

  it("gives captured-only active projects clarification-aware repair guidance", async () => {
    const project = createProject(ctx.handle.db, {
      title: "Nur Capture",
      status: "active",
    });
    createTask(ctx.handle.db, {
      projectId: project.id,
      title: "Erst klären",
      status: "actionable",
      needsClarification: true,
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/projects/stuck",
    });
    expect(response.statusCode).toBe(200);
    const result = (
      response.json() as Array<{
        id: number;
        openCount: number;
        stuckReason: string;
        repairAction: string;
      }>
    ).find((row) => row.id === project.id);
    expect(result).toMatchObject({
      openCount: 1,
      stuckReason: "no_next_action",
    });
    expect(result?.repairAction).toMatch(/Kläre die erfassten Aufgaben/);
  });

  it("does not use captured unassigned work to classify a mixed project as unassigned", async () => {
    const owner = ctx.handle.db
      .insert(schema.members)
      .values({ name: "Zuständige", color: "#123456" })
      .returning()
      .get();
    const project = createProject(ctx.handle.db, {
      title: "Gemischt",
      status: "active",
      ownerMemberId: owner.id,
    });
    createTask(ctx.handle.db, {
      projectId: project.id,
      title: "Erfasst und gemeinsam",
      status: "actionable",
      needsClarification: true,
      ownerInheritanceMode: "none",
    });
    createTask(ctx.handle.db, {
      projectId: project.id,
      title: "Geklärt und zuständig",
      status: "actionable",
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/projects/stuck",
    });
    expect(
      (response.json() as Array<{ id: number }>).some(
        (row) => row.id === project.id,
      ),
    ).toBe(false);
  });
});
