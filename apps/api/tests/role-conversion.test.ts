import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
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

  it("converts a story back to a task, preserving identity and history, when the story has no children or acceptance criteria", async () => {
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
    ctx.handle.db
      .update(schema.workItems)
      .set({
        notBeforeAt: "2026-09-14T08:00:00.000Z",
        notBeforeDate: "2026-09-14",
      })
      .where(eq(schema.workItems.id, project.id))
      .run();
    const reverted = await post(`/api/projects/${project.id}/convert-to-task`, {
      expectedRevision: project.revision,
    });
    expect(reverted.statusCode).toBe(201);
    expect(reverted.json()).toMatchObject({
      id: project.id,
      title: "Wieder zur Aufgabe",
      status: "someday",
      dueDate: "2026-10-10",
      scheduledDate: null,
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

  it("rejects converting a story with tasks or acceptance criteria back to a task", async () => {
    const root = (await post("/api/tasks", { title: "Mit Unterschritten" })).json();
    const converted = (
      await post(`/api/tasks/${root.id}/convert-to-story`, { status: "backlog" })
    ).json();
    await post(`/api/tasks`, { title: "Schritt", projectId: converted.id });

    const withChildren = await post(
      `/api/projects/${converted.id}/convert-to-task`,
      {},
    );
    expect(withChildren.statusCode).toBe(409);
    expect(withChildren.json().error.code).toBe("role_conversion_invalid");

    const emptyRoot = (
      await post("/api/tasks", { title: "Ohne Unterschritte" })
    ).json();
    const emptyPromoted = (
      await post(`/api/tasks/${emptyRoot.id}/convert-to-story`, {
        status: "backlog",
      })
    ).json();
    await post(`/api/projects/${emptyPromoted.id}/criteria`, {
      text: "Fertig, wenn alles sauber ist",
    });

    const withCriteria = await post(
      `/api/projects/${emptyPromoted.id}/convert-to-task`,
      {},
    );
    expect(withCriteria.statusCode).toBe(409);
    expect(withCriteria.json().error.code).toBe("role_conversion_invalid");
  });
});
