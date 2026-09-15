import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACTIVITY_ACTOR_HEADER } from "@machbar/shared";
import * as schema from "../src/db/schema.js";
import { createProject, updateProject } from "../src/domain/storyCrud.js";
import {
  createChildTask,
  createTask,
  updateTask,
} from "../src/domain/taskCrud.js";
import { moveTask } from "../src/domain/structuralMoves.js";
import { convertStoryToTask, convertTaskToStory } from "../src/domain/roleConversion.js";
import { completeTask } from "../src/domain/taskWorkflow.js";
import { getContributionSummary } from "../src/repo/contributionRepo.js";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

describe("work-task scope", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await closeTestContext(ctx);
  });

  function member(name: string) {
    return ctx.handle.db
      .insert(schema.members)
      .values({ name, color: "#123456" })
      .returning()
      .get();
  }

  it("defaults every new root task/project to household scope", () => {
    const task = createTask(ctx.handle.db, { title: "Wäsche" });
    const project = createProject(ctx.handle.db, { title: "Umzug" });
    expect(task.scope).toBe("household");
    expect(project.scope).toBe("household");
  });

  it("inherits scope from the parent for child tasks and nested projects, ignoring an explicit override", () => {
    const anna = member("Anna");
    const workProject = createProject(ctx.handle.db, {
      title: "Onboarding",
      scope: "work",
      ownerMemberId: anna.id,
    });
    const childTask = createTask(ctx.handle.db, {
      title: "Slides vorbereiten",
      projectId: workProject.id,
      // explicit override on a non-root create must be ignored
      scope: "household",
    });
    expect(childTask.scope).toBe("work");

    const grandchild = createChildTask(ctx.handle.db, childTask.id, {
      title: "Folie 3 überarbeiten",
    });
    expect(grandchild.scope).toBe("work");

    const nestedProject = createProject(ctx.handle.db, {
      title: "Teilprojekt",
      parentId: workProject.id,
    });
    expect(nestedProject.scope).toBe("work");
  });

  it("auto-assigns the creating member as owner for a root work item with no explicit owner", () => {
    const ben = member("Ben");
    const task = createTask(ctx.handle.db, {
      title: "Vertrag prüfen",
      scope: "work",
      createdByMemberId: ben.id,
    });
    expect(task.ownerMemberId).toBe(ben.id);

    const project = createProject(ctx.handle.db, {
      title: "Freelance-Projekt",
      scope: "work",
    });
    // No acting member supplied at all (no `actorMemberId` in context) -> stays
    // unset; the explicit-owner path is exercised via createTask above and the
    // updateTask/updateProject cases below.
    expect(project.ownerMemberId).toBeNull();
  });

  it("rejects moving a task across a household/work scope boundary", () => {
    const householdProject = createProject(ctx.handle.db, { title: "Haushalt" });
    const workProject = createProject(ctx.handle.db, {
      title: "Arbeit",
      scope: "work",
    });
    const task = createTask(ctx.handle.db, {
      title: "Haushaltsaufgabe",
      projectId: householdProject.id,
    });

    expect(() =>
      moveTask(ctx.handle.db, task.id, {
        projectId: workProject.id,
        parentTaskId: null,
        expectedRevision: task.revision,
      }),
    ).toThrow(
      expect.objectContaining({ code: "scope_mismatch" }),
    );
  });

  it("preserves scope across task<->story role conversion", () => {
    const anna = member("Anna");
    const workTask = createTask(ctx.handle.db, {
      title: "Kundenprojekt starten",
      scope: "work",
      createdByMemberId: anna.id,
    });
    const converted = convertTaskToStory(ctx.handle.db, workTask.id, {
      status: "backlog",
    });
    expect(converted.scope).toBe("work");

    const backToTask = convertStoryToTask(ctx.handle.db, converted.id, {});
    expect(backToTask.scope).toBe("work");
  });

  it("only allows editing scope on a root item, cascading to the whole subtree and auto-assigning an owner", () => {
    const anna = member("Anna");
    const project = createProject(ctx.handle.db, { title: "Projekt" });
    const task = createTask(ctx.handle.db, {
      title: "Aufgabe",
      projectId: project.id,
    });
    const subtask = createChildTask(ctx.handle.db, task.id, {
      title: "Teilaufgabe",
    });

    expect(() =>
      updateTask(ctx.handle.db, task.id, {
        scope: "work",
        expectedRevision: task.revision,
      }),
    ).toThrow(expect.objectContaining({ code: "scope_edit_root_only" }));

    updateProject(
      ctx.handle.db,
      project.id,
      { scope: "work", expectedRevision: project.revision },
      { actorMemberId: anna.id },
    );

    const reloadedProject = ctx.handle.db
      .select()
      .from(schema.workItems)
      .all()
      .find((row) => row.id === project.id)!;
    expect(reloadedProject.scope).toBe("work");
    expect(reloadedProject.ownerMemberId).toBe(anna.id);

    const reloadedTask = ctx.handle.db
      .select()
      .from(schema.workItems)
      .all()
      .find((row) => row.id === task.id)!;
    const reloadedSubtask = ctx.handle.db
      .select()
      .from(schema.workItems)
      .all()
      .find((row) => row.id === subtask.id)!;
    expect(reloadedTask.scope).toBe("work");
    expect(reloadedSubtask.scope).toBe("work");
  });

  it("hides a work item from other members but keeps it visible to its owner across list/aggregate endpoints", async () => {
    const anna = await ctx.app
      .inject({ method: "POST", url: "/api/members", payload: { name: "Anna", color: "#111111" } })
      .then((res) => res.json());
    const ben = await ctx.app
      .inject({ method: "POST", url: "/api/members", payload: { name: "Ben", color: "#222222" } })
      .then((res) => res.json());

    const workTask = createTask(ctx.handle.db, {
      title: "Geheimes Arbeitsprojekt",
      status: "actionable",
      scope: "work",
      createdByMemberId: anna.id,
    });

    const forOwner = await ctx.app.inject({
      method: "GET",
      url: `/api/tasks/${workTask.id}`,
      headers: { [ACTIVITY_ACTOR_HEADER]: String(anna.id) },
    });
    expect(forOwner.statusCode).toBe(200);

    const forOther = await ctx.app.inject({
      method: "GET",
      url: `/api/tasks/${workTask.id}`,
      headers: { [ACTIVITY_ACTOR_HEADER]: String(ben.id) },
    });
    expect(forOther.statusCode).toBe(404);

    const projectsForOther = await ctx.app.inject({ method: "GET", url: "/api/projects" });
    expect(projectsForOther.statusCode).toBe(200);

    const searchForOther = await ctx.app.inject({
      method: "GET",
      url: `/api/search?text=${encodeURIComponent("Geheimes")}`,
    });
    expect(searchForOther.json() as unknown[]).toHaveLength(0);

    const searchForOwner = await ctx.app.inject({
      method: "GET",
      url: `/api/search?text=${encodeURIComponent("Geheimes")}`,
      headers: { [ACTIVITY_ACTOR_HEADER]: String(anna.id) },
    });
    expect(
      (searchForOwner.json() as Array<{ title: string }>).map((task) => task.title),
    ).toContain("Geheimes Arbeitsprojekt");


    const agendaForOther = await ctx.app.inject({
      method: "GET",
      url: `/api/agenda/today?scope=work&memberId=${ben.id}`,
    });
    const otherTitles = [
      ...agendaForOther.json().shared,
      ...agendaForOther.json().unscheduled,
    ].map((task: { title: string }) => task.title);
    expect(otherTitles).not.toContain("Geheimes Arbeitsprojekt");

    const agendaForOwner = await ctx.app.inject({
      method: "GET",
      url: `/api/agenda/today?scope=work&memberId=${anna.id}`,
    });
    const ownTitles = [
      ...agendaForOwner.json().shared,
      ...agendaForOwner.json().unscheduled,
    ].map((task: { title: string }) => task.title);
    expect(ownTitles).toContain("Geheimes Arbeitsprojekt");
  });

  it("requires a resolvable member for the work agenda scope", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/agenda/today?scope=work",
    });
    expect(res.statusCode).toBe(400);
  });

  it("never mixes a work item into the household (mine/all) agenda view", async () => {
    const anna = await ctx.app
      .inject({ method: "POST", url: "/api/members", payload: { name: "Anna", color: "#111111" } })
      .then((res) => res.json());
    createTask(ctx.handle.db, {
      title: "Arbeitsaufgabe",
      status: "actionable",
      scope: "work",
      createdByMemberId: anna.id,
    });

    const householdAgenda = await ctx.app.inject({
      method: "GET",
      url: `/api/agenda/today?scope=mine&memberId=${anna.id}`,
    });
    const titles = [
      ...householdAgenda.json().shared,
      ...householdAgenda.json().unscheduled,
    ].map((task: { title: string }) => task.title);
    expect(titles).not.toContain("Arbeitsaufgabe");
  });

  it("never contributes to household points/gamification", () => {
    const anna = member("Anna");
    const workTask = createTask(ctx.handle.db, {
      title: "Bezahlter Auftrag",
      status: "actionable",
      scope: "work",
      ownerMemberId: anna.id,
      ownerInheritanceMode: "explicit",
    });

    completeTask(ctx.handle.db, workTask.id, undefined, {
      actorMemberId: anna.id,
    });

    expect(getContributionSummary(ctx.handle.db).sharedTotal).toBe(0);
    expect(
      ctx.handle.db.select().from(schema.contributionEvents).all(),
    ).toHaveLength(0);
  });

  it("hides a captured work item from other members but keeps it visible to its owner in /api/inbox", async () => {
    const anna = await ctx.app
      .inject({ method: "POST", url: "/api/members", payload: { name: "Anna", color: "#111111" } })
      .then((res) => res.json());
    const ben = await ctx.app
      .inject({ method: "POST", url: "/api/members", payload: { name: "Ben", color: "#222222" } })
      .then((res) => res.json());

    const capturedWork = createTask(ctx.handle.db, {
      title: "Erfasste Arbeitsaufgabe",
      status: "captured",
      scope: "work",
      createdByMemberId: anna.id,
    });

    const householdDefault = await ctx.app.inject({ method: "GET", url: "/api/inbox" });
    expect(
      (householdDefault.json() as Array<{ id: number }>).map((task) => task.id),
    ).not.toContain(capturedWork.id);

    const forOther = await ctx.app.inject({
      method: "GET",
      url: `/api/inbox?scope=work&memberId=${ben.id}`,
    });
    expect(
      (forOther.json() as Array<{ id: number }>).map((task) => task.id),
    ).not.toContain(capturedWork.id);

    const forOwner = await ctx.app.inject({
      method: "GET",
      url: `/api/inbox?scope=work&memberId=${anna.id}`,
    });
    expect(
      (forOwner.json() as Array<{ id: number }>).map((task) => task.id),
    ).toContain(capturedWork.id);

    const householdScopeForOwner = await ctx.app.inject({
      method: "GET",
      url: `/api/inbox?scope=all&memberId=${anna.id}`,
    });
    expect(
      (householdScopeForOwner.json() as Array<{ id: number }>).map(
        (task) => task.id,
      ),
    ).not.toContain(capturedWork.id);
  });

  it("requires a resolvable member for the work inbox scope", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/inbox?scope=work",
    });
    expect(res.statusCode).toBe(400);
  });
});
