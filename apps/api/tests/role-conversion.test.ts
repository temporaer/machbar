import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { AvailabilityRule, Task } from "@machbar/shared";
import { Graph } from "../src/domain/graph.js";
import { buildAgenda } from "../src/domain/agenda.js";
import * as schema from "../src/db/schema.js";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

describe("task <-> story role conversion", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await closeTestContext(ctx);
  });

  async function post(url: string, payload: Record<string, unknown>) {
    return ctx.app.inject({ method: "POST", url, payload });
  }

  it("converts a committed actionable tree to an active story without a wrapper task", async () => {
    const member = (
      await post("/api/members", { name: "Mira" })
    ).json();
    const tag = (
      await post("/api/tags", { name: "zuhause", kind: "plain" })
    ).json();
    const root = (
      await post("/api/tasks", {
        title: "Kinderzimmer renovieren",
        notes: "Farbe und Möbel abstimmen",
        status: "actionable",
        ownerMemberId: member.id,
        ownerInheritanceMode: "explicit",
        dueDate: "2026-10-10",
        scheduledDate: "2026-09-15",
        notBeforeAt: "2026-09-14T08:00:00.000Z",
        notBeforeDate: "2026-09-14",
        tagIds: [tag.id],
      })
    ).json();
    const firstChild = (
      await post(`/api/tasks/${root.id}/children`, {
        title: "Farbe aussuchen",
      })
    ).json();
    const secondChild = (
      await post(`/api/tasks/${root.id}/children`, {
        title: "Wand streichen",
      })
    ).json();
    const grandchild = (
      await post(`/api/tasks/${secondChild.id}/children`, {
        title: "Abkleben",
      })
    ).json();
    const converted = await post(`/api/tasks/${root.id}/convert-to-story`, {
      status: "active",
      title: "Kinderzimmer fertig renovieren",
      notes: "Aktualisierte Notizen",
      expectedRevision: root.revision,
    });

    expect(converted.statusCode).toBe(201);
    expect(converted.json()).toMatchObject({
      id: root.id,
      title: "Kinderzimmer fertig renovieren",
      notes: "Aktualisierte Notizen",
      status: "active",
      ownerMemberId: member.id,
      dueDate: "2026-10-10",
      scheduledDate: null,
      tags: [expect.objectContaining({ id: tag.id })],
    });
    expect(
      ctx.handle.db
        .select({
          scheduledDate: schema.workItems.scheduledDate,
          notBeforeAt: schema.workItems.notBeforeAt,
          notBeforeDate: schema.workItems.notBeforeDate,
        })
        .from(schema.workItems)
        .where(eq(schema.workItems.id, root.id))
        .get(),
    ).toEqual({ scheduledDate: null, notBeforeAt: null, notBeforeDate: null });

    const project = (
      await ctx.app.inject({
        method: "GET",
        url: `/api/projects/${converted.json().id}`,
      })
    ).json();
    expect(project.tasks.map((task: { id: number }) => task.id)).toEqual([
      firstChild.id,
      secondChild.id,
      expect.any(Number),
    ]);
    expect(project.tasks[2]).toMatchObject({
      title: "Kinderzimmer renovieren",
      scheduledDate: "2026-09-15",
      dueDate: null,
    });
    expect(project.tasks[1]).toMatchObject({
      id: secondChild.id,
      parentTaskId: null,
      children: [expect.objectContaining({ id: grandchild.id })],
    });
    expect(ctx.handle.db.select().from(schema.activityEvents)
      .where(eq(schema.activityEvents.entityId, root.id)).all())
      .toEqual(expect.arrayContaining([expect.objectContaining({ kind: "task_created", entityType: "task" })]));
    expect(
      await ctx.app.inject({ method: "GET", url: `/api/tasks/${root.id}` }),
    ).toMatchObject({ statusCode: 404 });

    const activity = ctx.handle.db.select().from(schema.activityEvents).all();
    expect(activity.at(-1)).toMatchObject({
      kind: "work_item_role_converted",
      entityId: converted.json().id,
      entityType: "project",
      entityTitle: "Kinderzimmer fertig renovieren",
      metadata: expect.objectContaining({
        changedFields: ["role"],
      }),
    });
  });

  it("converts a captured root task to the story backlog", async () => {
    const root = (await post("/api/tasks", { title: "Vielleicht umziehen" })).json();
    const converted = await post(`/api/tasks/${root.id}/convert-to-story`, {
      status: "backlog",
      expectedRevision: root.revision,
    });

    expect(converted.statusCode).toBe(201);
    expect(converted.json()).toMatchObject({
      id: root.id,
      title: "Vielleicht umziehen",
      status: "backlog",
    });

    const projects = (
      await ctx.app.inject({ method: "GET", url: "/api/projects" })
    ).json();
    expect(projects).toContainEqual(
      expect.objectContaining({ id: converted.json().id, status: "backlog" }),
    );
  });

  it("converts actionable and someday standalone tasks to backlog stories", async () => {
    const actionable = (
      await post("/api/tasks", {
        title: "Actionable wird Projekt",
        status: "actionable",
        ownerMemberId: (await post("/api/members", { name: "Projekt-Treiber" })).json().id,
        ownerInheritanceMode: "explicit",
      })
    ).json();
    const someday = (
      await post("/api/tasks", {
        title: "Someday wird Projekt",
        status: "someday",
      })
    ).json();

    const actionableStory = await post(
      `/api/tasks/${actionable.id}/convert-to-story`,
      { status: "backlog", expectedRevision: actionable.revision },
    );
    const somedayStory = await post(
      `/api/tasks/${someday.id}/convert-to-story`,
      { status: "backlog", expectedRevision: someday.revision },
    );

    expect(actionableStory.statusCode).toBe(201);
    expect(actionableStory.json()).toMatchObject({
      id: actionable.id,
      status: "active",
      title: "Actionable wird Projekt",
    });
    expect(somedayStory.statusCode).toBe(201);
    expect(somedayStory.json()).toMatchObject({
      id: someday.id,
      status: "backlog",
      title: "Someday wird Projekt",
    });
    const actionableRow = ctx.handle.sqlite
      .prepare("SELECT role, task_kind FROM work_items WHERE id = ?")
      .get(actionable.id) as { role: string; task_kind: string | null };
    expect(actionableRow).toEqual({ role: "story", task_kind: null });
  });

  it("preserves hierarchy, compatible metadata, and activity identity", async () => {
    const member = (await post("/api/members", { name: "Hannes" })).json();
    const tag = (await post("/api/tags", { name: "keller", kind: "plain" })).json();
    const context = ctx.handle.db
      .insert(schema.physicalContexts)
      .values({
        source: "home_assistant",
        externalId: "basement",
        name: "Keller",
      })
      .returning()
      .get();
    const root = (
      await post("/api/tasks", {
        title: "Keller organisieren",
        notes: "Regale und Kisten",
        status: "actionable",
        ownerMemberId: member.id,
        ownerInheritanceMode: "explicit",
        dueDate: "2026-10-10",
        scheduledDate: "2026-09-15",
        notBeforeAt: "2026-09-14T08:00:00.000Z",
        notBeforeDate: "2026-09-14",
        tagIds: [tag.id],
        contextInheritanceMode: "explicit",
        contextIds: [context.id],
      })
    ).json();
    const first = (
      await post(`/api/tasks/${root.id}/children`, { title: "Regale ausmessen" })
    ).json();
    const second = (
      await post(`/api/tasks/${root.id}/children`, { title: "Kisten kaufen" })
    ).json();
    const grandchild = (
      await post(`/api/tasks/${first.id}/children`, { title: "Maßband suchen" })
    ).json();

    const converted = await post(`/api/tasks/${root.id}/convert-to-story`, {
      status: "backlog",
      expectedRevision: root.revision,
    });

    expect(converted.statusCode).toBe(201);
    expect(converted.json()).toMatchObject({
      id: root.id,
      revision: root.revision + 2,
      title: "Keller organisieren",
      notes: "Regale und Kisten",
      status: "active",
      ownerMemberId: member.id,
      dueDate: "2026-10-10",
      scheduledDate: null,
      tags: [expect.objectContaining({ id: tag.id })],
      contexts: [expect.objectContaining({ id: context.id })],
    });
    expect(
      ctx.handle.db
        .select({
          scheduledDate: schema.workItems.scheduledDate,
          notBeforeAt: schema.workItems.notBeforeAt,
          notBeforeDate: schema.workItems.notBeforeDate,
        })
        .from(schema.workItems)
        .where(eq(schema.workItems.id, root.id))
        .get(),
    ).toEqual({ scheduledDate: null, notBeforeAt: null, notBeforeDate: null });
    const project = (
      await ctx.app.inject({ method: "GET", url: `/api/projects/${root.id}` })
    ).json();
    expect(project.tasks[2].effectiveContexts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: context.id, name: "Keller" }),
    ]));
    expect(project.tasks.map((task: { id: number }) => task.id)).toEqual([
      first.id,
      second.id,
      expect.any(Number),
    ]);
    expect(project.tasks[2]).toMatchObject({
      title: "Keller organisieren",
      scheduledDate: "2026-09-15",
    });
    expect(project.tasks[0]).toMatchObject({
      id: first.id,
      parentTaskId: null,
      children: [expect.objectContaining({ id: grandchild.id })],
    });
    const rows = ctx.handle.db
      .select({
        id: schema.workItems.id,
        parentId: schema.workItems.parentId,
        role: schema.workItems.role,
        position: schema.workItems.position,
      })
      .from(schema.workItems)
      .where(eq(schema.workItems.id, first.id))
      .all();
    expect(rows).toEqual([
      {
        id: first.id,
        parentId: root.id,
        role: "task",
        position: first.position,
      },
    ]);
    expect(
      ctx.handle.db
        .select()
        .from(schema.workItems)
        .where(eq(schema.workItems.id, grandchild.id))
        .get(),
    ).toMatchObject({ parentId: first.id, role: "task" });
    const activity = ctx.handle.db.select().from(schema.activityEvents).all();
    expect(activity.at(-1)).toMatchObject({
      kind: "work_item_role_converted",
      entityId: root.id,
      entityType: "project",
    });
    expect(activity.some((event) => event.kind === "project_deleted")).toBe(false);
    expect(activity.filter((event) => event.kind === "project_created")).toHaveLength(0);
  });

  it("requires an explicit owner when converting to an active project", async () => {
    const root = (await post("/api/tasks", { title: "Keller aufräumen" })).json();
    const activePromotion = await post(
      `/api/tasks/${root.id}/convert-to-story`,
      {
        status: "active",
        expectedRevision: root.revision,
      },
    );

    expect(activePromotion.statusCode).toBe(409);
    expect(activePromotion.json().error.code).toBe("project_commitment_resolution_required");
    expect(
      await ctx.app.inject({ method: "GET", url: `/api/tasks/${root.id}` }),
    ).toMatchObject({ statusCode: 200 });
  });

  it("rolls back a staged preservation step when activation decisions are missing", async () => {
    const source = (await post("/api/tasks", {
      title: "Datiertes Vorhaben",
      status: "actionable",
      scheduledDate: "2026-10-20",
    })).json();

    const response = await post(`/api/tasks/${source.id}/convert-to-story`, {
      status: "backlog",
      expectedRevision: source.revision,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("project_commitment_resolution_required");
    expect(ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.id, source.id)).get()).toMatchObject({
      role: "task", status: "active", scheduledDate: "2026-10-20",
    });
    expect(ctx.handle.db.select().from(schema.workItems).all()).toHaveLength(1);
  });

  it("preserves an active conversion as a child action atomically", async () => {
    const member = (await post("/api/members", { name: "No path owner" })).json();
    const root = (
      await post("/api/tasks", {
        title: "Project-shaped capture",
        status: "actionable",
        ownerMemberId: member.id,
        ownerInheritanceMode: "explicit",
      })
    ).json();
    const response = await post(
      `/api/tasks/${root.id}/convert-to-story`,
      {
        status: "active",
        expectedRevision: root.revision,
        activationResolution: {
          expectedProjects: [{ projectId: root.id, revision: root.revision }],
          drivers: [],
        },
      },
    );
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ status: "active", nextAction: { title: "Project-shaped capture" } });
    const project = (await ctx.app.inject({ method: "GET", url: `/api/projects/${root.id}` })).json();
    expect(project.tasks).toHaveLength(1);
    expect(project.tasks[0]).toMatchObject({ title: "Project-shaped capture", status: "actionable" });
  });

  it("converts a someday root with an actionable child and driver to active", async () => {
    const member = (await post("/api/members", { name: "Active owner" })).json();
    const root = (
      await post("/api/tasks", {
        title: "Keller organisieren",
        status: "someday",
        ownerMemberId: member.id,
        ownerInheritanceMode: "explicit",
      })
    ).json();
    await post(`/api/tasks/${root.id}/children`, {
      title: "Regale ausmessen",
      status: "actionable",
    });

    const response = await post(`/api/tasks/${root.id}/convert-to-story`, {
      status: "active",
      expectedRevision: root.revision,
      activationResolution: {
        expectedProjects: [{ projectId: root.id, revision: root.revision }],
        drivers: [],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      id: root.id,
      status: "active",
      ownerMemberId: member.id,
    });
  });

  it("allows backlog conversion without activation readiness", async () => {
    const root = (
      await post("/api/tasks", {
        title: "Noch nicht reif",
        status: "someday",
      })
    ).json();

    const response = await post(`/api/tasks/${root.id}/convert-to-story`, {
      status: "backlog",
      expectedRevision: root.revision,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      id: root.id,
      status: "backlog",
      ownerMemberId: null,
    });
  });

  it("rejects subtasks, project-contained tasks, and unsupported terminal states", async () => {
    const root = (
      await post("/api/tasks", { title: "Root", status: "actionable" })
    ).json();
    const child = (await post(`/api/tasks/${root.id}/children`, { title: "Child" })).json();
    const storyRoot = (await post("/api/tasks", { title: "Story root" })).json();
    const story = (
      await post(`/api/tasks/${storyRoot.id}/convert-to-story`, {
        status: "backlog",
        expectedRevision: storyRoot.revision,
      })
    ).json();
    const insideStory = (
      await post("/api/tasks", {
        title: "Inside story",
        projectId: story.id,
      })
    ).json();
    const done = (
      await post("/api/tasks", {
        title: "Done task",
        status: "done",
      })
    ).json();
    const cancelled = (
      await post("/api/tasks", {
        title: "Cancelled task",
        status: "cancelled",
      })
    ).json();

    const childConversion = await post(`/api/tasks/${child.id}/convert-to-story`, {
      status: "backlog",
      expectedRevision: child.revision,
    });
    const storyContainedConversion = await post(
      `/api/tasks/${insideStory.id}/convert-to-story`,
      { status: "backlog", expectedRevision: insideStory.revision },
    );
    const doneConversion = await post(`/api/tasks/${done.id}/convert-to-story`, {
      status: "backlog",
      expectedRevision: done.revision,
    });
    const cancelledConversion = await post(
      `/api/tasks/${cancelled.id}/convert-to-story`,
      { status: "backlog", expectedRevision: cancelled.revision },
    );

    expect(childConversion.statusCode).toBe(409);
    expect(childConversion.json().error).toMatchObject({
      code: "role_conversion_invalid",
      details: { reason: "not_root" },
    });
    expect(storyContainedConversion.statusCode).toBe(409);
    expect(storyContainedConversion.json().error).toMatchObject({
      code: "role_conversion_invalid",
      details: { reason: "inside_story" },
    });
    expect(doneConversion.statusCode).toBe(409);
    expect(doneConversion.json().error).toMatchObject({
      code: "role_conversion_invalid",
      details: { reason: "unsupported_status" },
    });
    expect(cancelledConversion.statusCode).toBe(409);
    expect(cancelledConversion.json().error).toMatchObject({
      code: "role_conversion_invalid",
      details: { reason: "unsupported_status" },
    });
  });

  it("rejects converting reference material to a story and leaves the row untouched", async () => {
    const reference = (
      await post("/api/tasks", {
        title: "Campingliste",
        kind: "reference",
      })
    ).json();

    const response = await post(`/api/tasks/${reference.id}/convert-to-story`, {
      status: "backlog",
      expectedRevision: reference.revision,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({
      code: "role_conversion_invalid",
      message: expect.stringContaining("make-action"),
      details: { reason: "is_reference" },
    });
    expect(
      (
        await ctx.app.inject({
          method: "GET",
          url: `/api/tasks/${reference.id}`,
        })
      ).json(),
    ).toMatchObject({
      id: reference.id,
      kind: "reference",
    });
    const row = ctx.handle.sqlite
      .prepare("SELECT role, task_kind FROM work_items WHERE id = ?")
      .get(reference.id) as { role: string; task_kind: string | null };
    expect(row).toEqual({ role: "task", task_kind: "reference" });
  });

  it("moves task-only obligations to a preserved child while keeping the project identity", async () => {
    const member = (await post("/api/members", { name: "Conversion driver" })).json();
    const waiting = (
      await post("/api/tasks", { title: "Wartet extern", status: "actionable", ownerMemberId: member.id, ownerInheritanceMode: "explicit" })
    ).json();
    await ctx.app.inject({
      method: "PUT",
      url: `/api/tasks/${waiting.id}/external-wait`,
      payload: {
        expectedRevision: waiting.revision,
        waitingFor: "Antwort",
      },
    });

    const dependencyTask = (
      await post("/api/tasks", { title: "Mit Abhängigkeit", status: "actionable", ownerMemberId: member.id, ownerInheritanceMode: "explicit" })
    ).json();
    const selectedStep = (await post(`/api/tasks/${dependencyTask.id}/children`, { title: "Ausgewählte Voraussetzung" })).json();
    const blocker = (
      await post("/api/tasks", { title: "Voraussetzung", status: "actionable" })
    ).json();
    const outgoingDependency = await post(`/api/tasks/${dependencyTask.id}/dependencies`, {
      dependsOnTaskId: blocker.id,
    });
    expect(outgoingDependency.statusCode).toBe(201);
    const outgoingDependencyId = outgoingDependency.json().dependencies.find(
      (dependency: { dependsOnTaskId: number }) => dependency.dependsOnTaskId === blocker.id,
    ).id;
    const incomingTask = (await post("/api/tasks", { title: "Wartet auf Projekt", status: "actionable" })).json();
    const incomingDependency = await post(`/api/tasks/${incomingTask.id}/dependencies`, {
      dependsOnTaskId: dependencyTask.id,
    });
    expect(incomingDependency.statusCode).toBe(201);
    expect((await ctx.app.inject({ method: "GET", url: `/api/tasks/${dependencyTask.id}` })).json().incomingDependencies)
      .toEqual([expect.objectContaining({ id: incomingDependency.json().dependencies[0].id, taskId: incomingTask.id, title: "Wartet auf Projekt" })]);

    const recurring = (
      await post("/api/tasks", {
        title: "Wiederholt",
        status: "actionable",
        ownerMemberId: member.id,
        ownerInheritanceMode: "explicit",
      })
    ).json();
    ctx.handle.db
      .update(schema.workItems)
      .set({ repeatAfterDays: 7 })
      .where(eq(schema.workItems.id, recurring.id))
      .run();
    ctx.handle.db.insert(schema.taskRecurrenceOccurrences).values({
      taskId: recurring.id,
      scheduledDate: "2026-10-01",
      deadlineDate: "2026-10-08",
      completedOn: "2026-10-01",
      completedAt: "2026-10-01T12:00:00.000Z",
      result: "hit",
    }).run();
    const reminder = (
      await post("/api/tasks", {
        title: "Mit Erinnerung",
        status: "actionable",
        ownerMemberId: member.id,
        ownerInheritanceMode: "explicit",
      })
    ).json();
    ctx.handle.db
      .insert(schema.taskReminders)
      .values({
        taskId: reminder.id,
        kind: "absolute",
        at: "2030-01-01T09:00:00.000Z",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run();

    const sources = [waiting, dependencyTask, recurring, reminder];
    for (const source of sources) {
      const current = (await ctx.app.inject({ method: "GET", url: `/api/tasks/${source.id}` })).json();
      const response = await post(`/api/tasks/${source.id}/convert-to-story`, {
        status: "backlog",
        expectedRevision: current.revision,
        activationResolution: {
          expectedProjects: [{ projectId: source.id, revision: current.revision }],
          drivers: [],
          ...(source.id === dependencyTask.id
            ? { nextActionTitle: "Voraussetzung bearbeiten" }
            : source.id === waiting.id
              ? { nextActionTitle: "Rückmeldung nachfassen" }
              : {}),
        },
        ...(source.id === dependencyTask.id ? {
          dependencyMappings: [{
            dependencyId: outgoingDependencyId,
            targetTaskId: selectedStep.id,
            sourceEndpoint: "task",
          }],
        } : {}),
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ id: source.id, status: "active" });
      const converted = (await ctx.app.inject({ method: "GET", url: `/api/projects/${source.id}` })).json();
      expect(converted.tasks).toEqual(expect.arrayContaining([
        expect.objectContaining({ title: source.title, status: "actionable" }),
      ]));
    }

    const dependencyRow = ctx.handle.db.select().from(schema.taskDependencies)
      .where(eq(schema.taskDependencies.dependsOnTaskId, blocker.id)).get();
    expect(dependencyRow?.taskId).toBe(selectedStep.id);
    const incomingRow = ctx.handle.db.select().from(schema.taskDependencies)
      .where(eq(schema.taskDependencies.taskId, incomingTask.id)).get();
    expect(incomingRow?.dependsOnTaskId).not.toBe(dependencyTask.id);
    const dependencyProject = (await ctx.app.inject({ method: "GET", url: `/api/projects/${dependencyTask.id}` })).json();
    expect(incomingRow?.dependsOnTaskId).toBe(dependencyProject.tasks.find((child: { title: string }) => child.title === dependencyTask.title).id);
    const recurringProject = (await ctx.app.inject({ method: "GET", url: `/api/projects/${recurring.id}` })).json();
    const recurringStep = recurringProject.tasks.find((child: { title: string }) => child.title === recurring.title);
    expect(recurringStep.repeatAfterDays).toBe(7);
    expect(ctx.handle.db.select().from(schema.taskRecurrenceOccurrences)
      .where(eq(schema.taskRecurrenceOccurrences.taskId, recurringStep.id)).all()).toHaveLength(1);
    const reminderProject = (await ctx.app.inject({ method: "GET", url: `/api/projects/${reminder.id}` })).json();
    expect(reminderProject.tasks.find((child: { title: string }) => child.title === reminder.title).reminders).toHaveLength(1);
    const waitProject = (await ctx.app.inject({ method: "GET", url: `/api/projects/${waiting.id}` })).json();
    expect(waitProject.tasks.find((child: { title: string }) => child.title === waiting.title).externalWait.waitingFor).toBe("Antwort");
    const reminderStepId = reminderProject.tasks.find((child: { title: string }) => child.title === reminder.title).id;
    expect(ctx.handle.db.select().from(schema.taskReminders).where(eq(schema.taskReminders.taskId, reminderStepId)).all()).toHaveLength(1);
  });

  const windowRule = (match: "inside" | "outside"): AvailabilityRule => ({
    kind: "weekly", match,
    windows: [{ weekdays: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" }],
  });

  it.each([
    ["inside", true], ["outside", true],
    ["inside", false], ["outside", false],
  ] as const)("preserves %s availability on the action through conversion and reversal (scheduled=%s)", async (match, scheduled) => {
    const rule = windowRule(match);
    const childRule = windowRule(match === "inside" ? "outside" : "inside");
    const member = (await post("/api/members", { name: "Driver" })).json();
    const source = (await post("/api/tasks", {
      title: "Business-hour action",
      status: scheduled ? "actionable" : "someday",
      ownerMemberId: member.id,
      ownerInheritanceMode: "explicit",
      availabilityRule: rule,
      ...(scheduled ? { scheduledDate: "2026-10-12" } : {}),
    })).json();
    const child = (await post("/api/tasks", {
      title: "Child with its own window", parentTaskId: source.id,
      status: "actionable", availabilityRule: childRule,
    })).json();
    const before = (await ctx.app.inject({ method: "GET", url: `/api/tasks/${source.id}` })).json();
    const conversion = await post(`/api/tasks/${source.id}/convert-to-story`, {
      status: scheduled ? "active" : "backlog", expectedRevision: before.revision,
    });
    expect(conversion.statusCode, JSON.stringify(conversion.json())).toBe(201);
    const project = (await ctx.app.inject({ method: "GET", url: `/api/projects/${source.id}` })).json();
    expect(project.status).toBe(scheduled ? "active" : "backlog");
    const preserved = project.tasks.find((task: Task) => task.id !== child.id);
    expect(preserved).toMatchObject({ availabilityRule: rule, scheduledDate: scheduled ? "2026-10-12" : null });
    expect(project.tasks.find((task: Task) => task.id === child.id).availabilityRule).toEqual(childRule);
    expect(ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.id, source.id)).get()?.availabilityRule).toBeNull();

    const agendaIds = (now: string) => {
      const agenda = buildAgenda(Graph.load(ctx.handle.db, now), { now, today: "2026-10-12", householdTimezone: "Europe/Berlin" });
      const ids: number[] = [];
      const visit = (task: Task) => { ids.push(task.id); task.children.forEach(visit); };
      [...agenda.planned, ...agenda.shared, ...agenda.unscheduled, ...agenda.revisit].forEach(visit);
      return ids;
    };
    const unavailableNow = match === "inside" ? "2026-10-12T16:00:00Z" : "2026-10-12T10:00:00Z";
    const availableNow = match === "inside" ? "2026-10-12T10:00:00Z" : "2026-10-12T16:00:00Z";
    expect(agendaIds(unavailableNow)).not.toContain(preserved.id);
    if (scheduled) expect(agendaIds(availableNow)).toContain(preserved.id);
    else expect(agendaIds(availableNow)).not.toContain(preserved.id); // window alone never activates the project

    const reversal = await post(`/api/projects/${source.id}/convert-to-task`, { expectedRevision: project.revision });
    expect(reversal.statusCode, JSON.stringify(reversal.json())).toBe(201);
    expect(reversal.json()).toMatchObject({ availabilityRule: null, status: scheduled ? "actionable" : "someday" });
    const graph = Graph.load(ctx.handle.db, unavailableNow);
    expect(graph.tasksById.get(preserved.id)).toMatchObject({ availabilityRule: rule, status: scheduled ? "actionable" : "someday" });
    expect(graph.tasksById.get(child.id)?.availabilityRule).toEqual(childRule);
    expect(agendaIds(unavailableNow)).not.toContain(preserved.id);
  });

  it.each(["stale", "cancelled", "activation"] as const)("retains the original window when conversion is rejected (%s)", async (reason) => {
    const rule = windowRule("inside");
    const source = (await post("/api/tasks", {
      title: "Original window", availabilityRule: rule,
      status: reason === "cancelled" ? "cancelled" : "actionable",
      ...(reason === "activation" ? { scheduledDate: "2026-10-12" } : {}),
    })).json();
    const before = ctx.handle.db.select().from(schema.workItems).all();
    const eventsBefore = ctx.handle.db.select().from(schema.activityEvents).all();
    const result = await post(`/api/tasks/${source.id}/convert-to-story`, {
      status: "backlog", expectedRevision: source.revision + (reason === "stale" ? 1 : 0),
    });
    expect(result.statusCode).toBe(409);
    expect(ctx.handle.db.select().from(schema.workItems).all()).toEqual(before);
    expect(ctx.handle.db.select().from(schema.activityEvents).all()).toEqual(eventsBefore);
    const retained = (await ctx.app.inject({ method: "GET", url: `/api/tasks/${source.id}` })).json();
    expect(retained.availabilityRule).toEqual(rule);
  });

  it("keeps a future revisit and its reminder deferred during conversion", async () => {
    const source = (await post("/api/tasks", {
      title: "Später um Regale kümmern",
      status: "someday",
      revisitAt: "2030-06-01T09:00:00.000Z",
      reminders: [{ kind: "absolute", at: "2030-05-31T09:00:00.000Z" }],
    })).json();

    const response = await post(`/api/tasks/${source.id}/convert-to-story`, {
      status: "backlog",
      expectedRevision: source.revision,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ id: source.id, status: "backlog", revisitAt: "2030-06-01T09:00:00.000Z" });
    const project = (await ctx.app.inject({ method: "GET", url: `/api/projects/${source.id}` })).json();
    const preserved = project.tasks.find((step: { title: string }) => step.title === source.title);
    expect(preserved).toMatchObject({
      status: "actionable",
      revisitAt: "2030-06-01T09:00:00.000Z",
      reminders: [expect.objectContaining({ kind: "absolute", at: "2030-05-31T09:00:00.000Z" })],
    });
    const today = (await ctx.app.inject({ method: "GET", url: "/api/agenda/today?scope=all&date=2030-05-31" })).json();
    expect(today.planned.map((task: { id: number }) => task.id)).not.toContain(preserved.id);
    expect(today.unscheduled.map((task: { id: number }) => task.id)).not.toContain(preserved.id);
  });

  it("retains a recurrence-derived deadline on its preserved step", async () => {
    const member = (await post("/api/members", { name: "Recurring driver" })).json();
    const source = (await post("/api/tasks", {
      title: "Filter prüfen",
      status: "actionable",
      ownerMemberId: member.id,
      ownerInheritanceMode: "explicit",
      scheduledDate: "2030-06-01",
      repeatAfterDays: 7,
      allowedDeviationDays: 2,
    })).json();
    expect(source.dueDate).toBe("2030-06-03");

    const response = await post(`/api/tasks/${source.id}/convert-to-story`, {
      status: "backlog",
      expectedRevision: source.revision,
      activationResolution: {
        expectedProjects: [{ projectId: source.id, revision: source.revision }],
        drivers: [],
      },
    });

    expect(response.statusCode).toBe(201);
    const project = (await ctx.app.inject({ method: "GET", url: `/api/projects/${source.id}` })).json();
    const preserved = project.tasks.find((step: { title: string }) => step.title === source.title);
    expect(preserved).toMatchObject({
      scheduledDate: "2030-06-01",
      dueDate: "2030-06-03",
      repeatAfterDays: 7,
      allowedDeviationDays: 2,
    });
  });

  it("rejects conversion from a stale descendant snapshot without changing the graph", async () => {
    const root = (await post("/api/tasks", { title: "Outline" })).json();
    const child = (await post(`/api/tasks/${root.id}/children`, { title: "First step" })).json();
    const changedChild = await ctx.app.inject({ method: "PATCH", url: `/api/tasks/${child.id}`, payload: { title: "Updated step", expectedRevision: child.revision } });
    expect(changedChild.statusCode).toBe(200);

    const response = await post(`/api/tasks/${root.id}/convert-to-story`, {
      status: "backlog",
      expectedRevision: root.revision,
      expectedDescendantRevisions: [{ taskId: child.id, revision: child.revision }],
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("stale_write_conflict");
    expect((await ctx.app.inject({ method: "GET", url: `/api/tasks/${root.id}` })).json()).toMatchObject({ id: root.id });
    expect((await ctx.app.inject({ method: "GET", url: `/api/tasks/${child.id}` })).json()).toMatchObject({ title: "Updated step" });
    expect(ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.id, root.id)).get()).toMatchObject({ role: "task", status: "active" });
  });

  it("rejects a dependency remapping that would create a cycle and rolls back all conversion writes", async () => {
    const root = (await post("/api/tasks", { title: "Project action", status: "actionable" })).json();
    const child = (await post(`/api/tasks/${root.id}/children`, { title: "First step" })).json();
    const external = (await post("/api/tasks", { title: "External prerequisite", status: "actionable" })).json();
    const sourceEdge = await post(`/api/tasks/${root.id}/dependencies`, { dependsOnTaskId: external.id });
    await post(`/api/tasks/${external.id}/dependencies`, { dependsOnTaskId: child.id });
    const dependencyId = sourceEdge.json().dependencies.find(
      (dependency: { dependsOnTaskId: number }) => dependency.dependsOnTaskId === external.id,
    ).id;
    const before = ctx.handle.db.select().from(schema.taskDependencies).all();

    const response = await post(`/api/tasks/${root.id}/convert-to-story`, {
      status: "backlog",
      expectedRevision: (await ctx.app.inject({ method: "GET", url: `/api/tasks/${root.id}` })).json().revision,
      dependencyMappings: [{ dependencyId, targetTaskId: child.id, sourceEndpoint: "task" }],
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({ code: "role_conversion_invalid", details: { reason: "invalid_dependency_mapping" } });
    expect(ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.id, root.id)).get()).toMatchObject({ role: "task" });
    expect(ctx.handle.db.select().from(schema.taskDependencies).all()).toEqual(before);
    expect(ctx.handle.db.select().from(schema.workItems).all()).toHaveLength(3);
  });

  it("converts a story back to a task, preserving identity, history, and a project work plan", async () => {
    const project = (
      await post("/api/projects", {
        title: "Wieder zur Aufgabe",
        status: "backlog",
      })
    ).json();
    ctx.handle.db
      .update(schema.workItems)
      .set({ dueDate: "2026-10-10", scheduledDate: "2026-09-15" })
      .where(eq(schema.workItems.id, project.id))
      .run();
    const reverted = await post(`/api/projects/${project.id}/convert-to-task`, {
      expectedRevision: project.revision,
    });
    expect(reverted.statusCode).toBe(201);
    expect(reverted.json()).toMatchObject({
      id: project.id,
      title: "Wieder zur Aufgabe",
      status: "actionable",
      dueDate: "2026-10-10",
      scheduledDate: "2026-09-15",
    });
    const revertedRow = ctx.handle.sqlite
      .prepare("SELECT role, task_kind FROM work_items WHERE id = ?")
      .get(project.id) as { role: string; task_kind: string | null };
    expect(revertedRow).toEqual({ role: "task", task_kind: "action" });
    expect(
      await ctx.app.inject({
        method: "GET",
        url: `/api/projects/${project.id}`,
      }),
    ).toMatchObject({ statusCode: 404 });

    const activity = ctx.handle.db
      .select()
      .from(schema.activityEvents)
      .all();
    expect(activity.filter((e) => e.kind === "work_item_role_converted")).toHaveLength(1);
  });

  it("keeps recurrence, reminder, dependency, and occurrence identities when converting a project", async () => {
    const project = (await post("/api/projects", { title: "Wiederkehrende Wartung", status: "backlog" })).json();
    const prerequisite = (await post("/api/tasks", { title: "Zugang erhalten", status: "actionable" })).json();
    const reminder = ctx.handle.db.insert(schema.taskReminders).values({
      taskId: project.id,
      kind: "absolute",
      at: "2027-03-12T08:00:00.000Z",
    }).returning().get();
    const occurrence = ctx.handle.db.insert(schema.taskRecurrenceOccurrences).values({
      taskId: project.id,
      scheduledDate: "2026-09-01",
      deadlineDate: "2026-09-01",
      completedOn: "2026-09-01",
      completedAt: "2026-09-01T09:00:00.000Z",
      result: "hit",
    }).returning().get();
    const dependency = ctx.handle.db.insert(schema.taskDependencies).values({
      taskId: project.id,
      dependsOnTaskId: prerequisite.id,
    }).returning().get();
    ctx.handle.db.update(schema.workItems)
      .set({ repeatAfterDays: 30, allowedDeviationDays: 3 })
      .where(eq(schema.workItems.id, project.id)).run();
    const oldActivity = ctx.handle.db.insert(schema.activityEvents).values({
      kind: "task_status_changed",
      entityType: "project",
      entityId: project.id,
      entityTitle: project.title,
      metadata: { previousStatus: "backlog", nextStatus: "active" },
    }).returning().get();

    const converted = await post(`/api/projects/${project.id}/convert-to-task`, {
      expectedRevision: project.revision,
    });

    expect(converted.statusCode).toBe(201);
    expect(converted.json()).toMatchObject({
      id: project.id,
      status: "actionable",
      repeatAfterDays: 30,
      allowedDeviationDays: 3,
      reminders: [expect.objectContaining({ id: reminder.id, at: "2027-03-12T08:00:00.000Z" })],
      dependencies: [expect.objectContaining({ id: dependency.id, dependsOnTaskId: prerequisite.id })],
    });
    expect(ctx.handle.db.select().from(schema.taskRecurrenceOccurrences)
      .where(eq(schema.taskRecurrenceOccurrences.taskId, project.id)).all()).toEqual([occurrence]);
    expect(ctx.handle.db.select().from(schema.activityEvents)
      .where(eq(schema.activityEvents.id, oldActivity.id)).get()).toMatchObject({ entityType: "project", entityId: project.id });
    expect(ctx.handle.db.select().from(schema.taskDependencies)
      .where(eq(schema.taskDependencies.id, dependency.id)).get()).toEqual(dependency);
  });

  it("preserves child tasks and editable acceptance criteria when converting a story", async () => {
    const root = (await post("/api/tasks", { title: "Mit Unterschritten" })).json();
    const converted = (
      await post(`/api/tasks/${root.id}/convert-to-story`, { status: "backlog" })
    ).json();
    await post(`/api/tasks`, { title: "Schritt", projectId: converted.id });

    const criterion = await post(`/api/projects/${converted.id}/criteria`, {
      text: "Fertig, wenn alles sauber ist",
    });

    const before = (await ctx.app.inject({ method: "GET", url: `/api/projects/${converted.id}` })).json();
    const convertedTask = await post(`/api/projects/${converted.id}/convert-to-task`, {
      expectedRevision: before.revision,
    });
    expect(convertedTask.statusCode).toBe(201);
    expect(convertedTask.json()).toMatchObject({
      id: converted.id,
      kind: "action",
      acceptanceCriteria: [expect.objectContaining({ text: "Fertig, wenn alles sauber ist", checked: false })],
      children: [expect.objectContaining({ title: "Schritt", parentTaskId: converted.id })],
    });

    const blockedCompletion = await post(`/api/tasks/${converted.id}/complete`, {});
    expect(blockedCompletion.statusCode).toBe(409);
    expect(blockedCompletion.json().error).toMatchObject({
      code: "task_completion_criteria_incomplete",
      details: { taskId: converted.id, incompleteCriterionIds: [criterion.json().acceptanceCriteria[0].id] },
    });

    const edited = await ctx.app.inject({
      method: "PATCH",
      url: `/api/tasks/${converted.id}/criteria/${criterion.json().acceptanceCriteria[0].id}`,
      payload: { text: "Fertig, wenn Küche und Flur sauber sind" },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().acceptanceCriteria[0].text).toBe("Fertig, wenn Küche und Flur sauber sind");
    const checked = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${converted.id}/criteria/${criterion.json().acceptanceCriteria[0].id}/check`,
      payload: { checked: true },
    });
    expect(checked.statusCode).toBe(200);
    const completed = await post(`/api/tasks/${converted.id}/complete`, { descendantsPolicy: "leave_open" });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({ status: "done", acceptanceCriteria: [expect.objectContaining({ checked: true })] });
  });

  it("keeps an unplanned backlog outline parked but preserves child commitments", async () => {
    const source = (await post("/api/projects", { title: "Geparktes Projekt", status: "backlog" })).json();
    ctx.handle.db.update(schema.workItems).set({ status: "active" })
      .where(eq(schema.workItems.id, source.id)).run();
    const unplanned = (await post("/api/tasks", { title: "Undatierter Schritt", projectId: source.id })).json();
    const dated = (await post("/api/tasks", {
      title: "Geplanter Schritt",
      projectId: source.id,
      scheduledDate: "2030-06-01",
    })).json();
    ctx.handle.db.update(schema.workItems)
      .set({ status: "backlog", revision: source.revision + 1 })
      .where(eq(schema.workItems.id, source.id)).run();
    const backlogRevision = ctx.handle.db.select({ revision: schema.workItems.revision })
      .from(schema.workItems).where(eq(schema.workItems.id, source.id)).get()!.revision;

    const converted = await post(`/api/projects/${source.id}/convert-to-task`, { expectedRevision: backlogRevision });

    expect(converted.statusCode, JSON.stringify(converted.json())).toBe(201);
    expect(converted.json()).toMatchObject({ id: source.id, status: "someday" });
    expect((await ctx.app.inject({ method: "GET", url: `/api/tasks/${unplanned.id}` })).json().status).toBe("someday");
    expect((await ctx.app.inject({ method: "GET", url: `/api/tasks/${dated.id}` })).json()).toMatchObject({
      status: "actionable",
      scheduledDate: "2030-06-01",
    });

    const beforeDate = (await ctx.app.inject({ method: "GET", url: "/api/agenda/today?scope=all&date=2030-05-31" })).json();
    expect(beforeDate.planned.map((task: { id: number }) => task.id)).not.toContain(dated.id);
    expect(beforeDate.unscheduled.map((task: { id: number }) => task.id)).not.toContain(unplanned.id);
    const onDate = (await ctx.app.inject({ method: "GET", url: "/api/agenda/today?scope=all&date=2030-06-01" })).json();
    expect(onDate.planned.map((task: { id: number }) => task.id)).toContain(dated.id);
    expect(onDate.unscheduled.map((task: { id: number }) => task.id)).not.toContain(unplanned.id);

    const active = (await post("/api/projects", { title: "Aktives Projekt", status: "backlog" })).json();
    const driver = (await post("/api/members", { name: "Aktiver Treiber" })).json();
    ctx.handle.db.update(schema.workItems).set({ status: "active", ownerMemberId: driver.id, ownerInheritanceMode: "explicit" })
      .where(eq(schema.workItems.id, active.id)).run();
    const activeChild = (await post("/api/tasks", { title: "Weiterarbeiten", projectId: active.id })).json();
    const activeConversion = await post(`/api/projects/${active.id}/convert-to-task`, {
      expectedRevision: active.revision,
    });
    expect(activeConversion.json().status).toBe("actionable");
    expect((await ctx.app.inject({ method: "GET", url: `/api/tasks/${activeChild.id}` })).json().status).toBe("actionable");
    const activeAgenda = (await ctx.app.inject({ method: "GET", url: "/api/agenda/today?scope=all&date=2030-06-01" })).json();
    expect(activeAgenda.unscheduled.map((task: { id: number }) => task.id)).toContain(activeChild.id);
  });

  it("preserves the original project completion timestamp after later edits", async () => {
    const project = (await post("/api/projects", { title: "Abgeschlossen", status: "backlog" })).json();
    const completedAt = "2026-09-12T08:30:00.000Z";
    ctx.handle.db.update(schema.workItems)
      .set({ status: "done", completedAt, updatedAt: "2026-10-01T10:00:00.000Z", revision: project.revision + 1 })
      .where(eq(schema.workItems.id, project.id)).run();
    ctx.handle.db.update(schema.workItems)
      .set({ title: "Nachträglich angepasst", notes: "Ergänzung", updatedAt: "2026-10-10T10:00:00.000Z", revision: project.revision + 2 })
      .where(eq(schema.workItems.id, project.id)).run();
    const converted = await post(`/api/projects/${project.id}/convert-to-task`, {
      expectedRevision: project.revision + 2,
    });

    expect(converted.statusCode, JSON.stringify(converted.json())).toBe(201);
    expect(converted.json()).toMatchObject({
      title: "Nachträglich angepasst",
      notes: "Ergänzung",
      status: "done",
      completedAt,
    });
  });

  it("rejects a stale project revision after a criterion changes without converting the item", async () => {
    const task = (await post("/api/tasks", { title: "Projekt mit Ergebnis" })).json();
    const project = (await post(`/api/tasks/${task.id}/convert-to-story`, { status: "backlog" })).json();
    const before = (await ctx.app.inject({ method: "GET", url: `/api/projects/${project.id}` })).json();
    const criterion = await post(`/api/projects/${project.id}/criteria`, { text: "Ergebnis sichtbar" });
    const response = await post(`/api/projects/${project.id}/convert-to-task`, { expectedRevision: before.revision });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("stale_write_conflict");
    expect((await ctx.app.inject({ method: "GET", url: `/api/projects/${project.id}` })).json()).toMatchObject({
      id: project.id,
      acceptanceCriteria: [expect.objectContaining({ id: criterion.json().acceptanceCriteria[0].id })],
    });
    expect(ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.id, project.id)).get()).toMatchObject({ role: "story" });
  });

  it("preserves combined project planning and revisit fields, while rejecting archived status", async () => {
    const planned = (await post("/api/projects", { title: "Wiedervorlage mit Plan", status: "backlog" })).json();
    ctx.handle.db.update(schema.workItems).set({ scheduledDate: "2027-02-01", revisitAt: "2027-01-15T09:00:00.000Z" })
      .where(eq(schema.workItems.id, planned.id)).run();
    const planningConversion = await post(`/api/projects/${planned.id}/convert-to-task`, {});
    expect(planningConversion.statusCode).toBe(201);
    expect(planningConversion.json()).toMatchObject({
      id: planned.id,
      status: "actionable",
      scheduledDate: "2027-02-01",
      revisitAt: "2027-01-15T09:00:00.000Z",
    });
    expect(ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.id, planned.id)).get()).toMatchObject({
      role: "task", scheduledDate: "2027-02-01", revisitAt: "2027-01-15T09:00:00.000Z",
    });

    const archived = (await post("/api/projects", { title: "Archiviertes Projekt", status: "backlog" })).json();
    ctx.handle.db.update(schema.workItems).set({ status: "archived", archivedAt: new Date().toISOString() })
      .where(eq(schema.workItems.id, archived.id)).run();
    const archivedConflict = await post(`/api/projects/${archived.id}/convert-to-task`, {});
    expect(archivedConflict.statusCode).toBe(409);
    expect(archivedConflict.json().error.details.reason).toBe("archived_status_requires_restore");
    expect(ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.id, archived.id)).get()).toMatchObject({ role: "story", status: "archived" });
  });
});
