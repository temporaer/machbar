import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { ACTIVITY_ACTOR_HEADER } from "@machbar/shared";
import * as schema from "../src/db/schema.js";
import {
  cancelTask,
  completeTask,
  createProject,
  createTask,
  deleteTask,
  moveTask,
  updateTask,
} from "../src/domain/mutations.js";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

describe("atomic activity recording", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await closeTestContext(ctx);
  });

  function events() {
    return ctx.handle.db
      .select()
      .from(schema.activityEvents)
      .orderBy(asc(schema.activityEvents.id))
      .all();
  }

  it("rolls back state when the event cannot be inserted", () => {
    expect(() =>
      createTask(
        ctx.handle.db,
        { title: "Atomar" },
        { actorMemberId: 999_999 },
      ),
    ).toThrow();

    expect(ctx.handle.db.select().from(schema.tasks).all()).toEqual([]);
    expect(events()).toEqual([]);
  });

  it("rolls back updates and deletions when their event cannot be inserted", () => {
    const task = createTask(ctx.handle.db, { title: "Bestand" });
    const before = events();

    expect(() =>
      updateTask(
        ctx.handle.db,
        task.id,
        { title: "Darf nicht bleiben" },
        { actorMemberId: 999_999 },
      ),
    ).toThrow();
    expect(
      ctx.handle.db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.id, task.id))
        .get()?.title,
    ).toBe("Bestand");
    expect(events()).toEqual(before);

    expect(() =>
      deleteTask(ctx.handle.db, task.id, { actorMemberId: 999_999 }),
    ).toThrow();
    expect(
      ctx.handle.db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.id, task.id))
        .get(),
    ).toBeDefined();
    expect(events()).toEqual(before);
  });

  it("coalesces meaningful edits and never stores note content", () => {
    const task = createTask(ctx.handle.db, { title: "Vorher", notes: "Alt" });
    updateTask(ctx.handle.db, task.id, {
      title: "Nachher",
      notes: "streng vertraulicher Notiztext",
      dueDate: "2026-09-01",
    });

    const edit = events().at(-1)!;
    expect(edit.kind).toBe("task_updated");
    expect(edit.entityTitle).toBe("Nachher");
    expect(edit.metadata).toEqual({
      changedFields: ["title", "notes", "dueDate"],
    });
    expect(JSON.stringify(edit.metadata)).not.toContain("streng vertraulich");
  });

  it("records note appends without copying appended content", async () => {
    const task = createTask(ctx.handle.db, { title: "Notizaufgabe" });
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/notes`,
      payload: { content: "dieser Text darf nicht im Ereignis stehen" },
    });

    expect(response.statusCode).toBe(200);
    const event = events().at(-1)!;
    expect(event.metadata).toEqual({ changedFields: ["notesAppended"] });
    expect(JSON.stringify(event)).not.toContain("dieser Text darf nicht");
  });

  it("records project note appends without copying appended content", async () => {
    const project = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { title: "Notizprojekt" },
      })
    ).json();
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/notes`,
      payload: { content: "auch dieser Projekttext ist vertraulich" },
    });

    expect(response.statusCode).toBe(200);
    const event = events().at(-1)!;
    expect(event.metadata).toEqual({ changedFields: ["notesAppended"] });
    expect(JSON.stringify(event)).not.toContain("dieser Projekttext");
  });

  it("records the resulting acceptance-criterion checked state", async () => {
    const project = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { title: "Kriterienprojekt" },
      })
    ).json();
    const added = (
      await ctx.app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/criteria`,
        payload: { text: "Geprüft" },
      })
    ).json();
    const criterionId = added.acceptanceCriteria[0].id as number;
    const before = events().length;

    await ctx.app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/criteria/${criterionId}/check`,
      payload: { checked: true },
    });
    await ctx.app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/criteria/${criterionId}/check`,
      payload: { checked: false },
    });

    expect(events().slice(before)).toEqual([
      expect.objectContaining({
        kind: "project_acceptance_criterion_checked",
        metadata: { checked: true },
      }),
      expect.objectContaining({
        kind: "project_acceptance_criterion_checked",
        metadata: { checked: false },
      }),
    ]);
  });

  it("suppresses no-op updates and pure position reorders", async () => {
    const first = createTask(ctx.handle.db, { title: "A" });
    createTask(ctx.handle.db, { title: "B" });
    const before = events().length;

    updateTask(ctx.handle.db, first.id, { title: "A", notes: "" });
    const current = (
      await ctx.app.inject({ method: "GET", url: `/api/tasks/${first.id}` })
    ).json();
    const reorder = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${first.id}/move`,
      payload: {
        parentTaskId: null,
        projectId: null,
        position: 1,
        expectedRevision: current.revision,
      },
    });

    expect(reorder.statusCode).toBe(200);
    expect(events()).toHaveLength(before);
  });

  it("records one initiating event with a count for bulk completion", () => {
    const root = createTask(ctx.handle.db, { title: "Root" });
    createTask(ctx.handle.db, { title: "Child 1", parentTaskId: root.id });
    createTask(ctx.handle.db, { title: "Child 2", parentTaskId: root.id });
    const before = events().length;

    completeTask(ctx.handle.db, root.id, "complete_children");

    const added = events().slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      kind: "task_status_changed",
      metadata: {
        previousStatus: "captured",
        nextStatus: "done",
        affectedCount: 3,
      },
    });
  });

  it.each([
    {
      terminalStatus: "done" as const,
      childStatus: "actionable" as const,
      expectedStatus: "done" as const,
    },
    {
      terminalStatus: "cancelled" as const,
      childStatus: "actionable" as const,
      expectedStatus: "cancelled" as const,
    },
  ])(
    "records descendant-only $terminalStatus bulk changes without a false root transition",
    ({ terminalStatus, childStatus, expectedStatus }) => {
      const root = createTask(ctx.handle.db, {
        title: "Terminaler Root",
        status: terminalStatus,
      });
      createTask(ctx.handle.db, {
        title: "Offenes Kind",
        parentTaskId: root.id,
        status: childStatus,
      });
      const before = events().length;

      if (terminalStatus === "done") {
        completeTask(ctx.handle.db, root.id, "complete_children");
      } else {
        cancelTask(ctx.handle.db, root.id, "cancel_children");
      }

      expect(events().slice(before)).toEqual([
        expect.objectContaining({
          kind: "task_descendants_status_changed",
          metadata: {
            nextStatus: expectedStatus,
            affectedCount: 1,
          },
        }),
      ]);
    },
  );

  it("records the actual destination parent for same-project moves", () => {
    const project = createProject(ctx.handle.db, { title: "Projekt" });
    const oldParent = createTask(ctx.handle.db, {
      title: "Alter Parent",
      projectId: project.id,
    });
    const newParent = createTask(ctx.handle.db, {
      title: "Neuer Parent",
      projectId: project.id,
    });
    const child = createTask(ctx.handle.db, {
      title: "Kind",
      parentTaskId: oldParent.id,
    });

    moveTask(ctx.handle.db, child.id, {
      parentTaskId: newParent.id,
      expectedRevision: child.revision,
    });

    expect(events().at(-1)).toMatchObject({
      kind: "task_moved",
      metadata: {
        relatedTaskIds: [newParent.id],
        relatedTaskTitles: ["Neuer Parent"],
      },
    });
    expect(events().at(-1)?.metadata).not.toHaveProperty("relatedProjectIds");
    expect(events().at(-1)?.metadata).not.toHaveProperty(
      "relatedProjectTitles",
    );
  });

  it("does not duplicate helper events for compound create operations", async () => {
    const project = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { title: "Ablauf" },
      })
    ).json();
    const root = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: { title: "Root", projectId: project.id },
      })
    ).json();
    const beforeChild = events().length;
    await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${root.id}/children`,
      payload: { title: "Kind" },
    });
    expect(events()).toHaveLength(beforeChild + 1);

    const beforeSequence = events().length;
    await ctx.app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/task-sequence`,
      payload: { titles: ["Eins", "Zwei", "Drei"] },
    });
    const sequenceEvents = events().slice(beforeSequence);
    expect(sequenceEvents).toHaveLength(1);
    expect(sequenceEvents[0]).toMatchObject({
      kind: "project_updated",
      metadata: {
        changedFields: ["taskSequence"],
        affectedCount: 3,
      },
    });
  });

  it("attributes route mutations to the resolved local actor", async () => {
    const member = ctx.handle.db
      .insert(schema.members)
      .values({ name: "Mira", color: "#123456" })
      .returning()
      .get();

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { [ACTIVITY_ACTOR_HEADER]: String(member.id) },
      payload: { title: "Mit Autor" },
    });

    expect(response.statusCode).toBe(201);
    expect(events().at(-1)?.actorMemberId).toBe(member.id);
  });

  it("retains deletion snapshots after task and project removal", async () => {
    const projectResponse = await ctx.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { title: "Altes Projekt" },
    });
    const projectId = projectResponse.json().id as number;
    const taskResponse = await ctx.app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { title: "Alte Aufgabe", projectId },
    });
    const taskId = taskResponse.json().id as number;

    await ctx.app.inject({ method: "DELETE", url: `/api/tasks/${taskId}` });
    await ctx.app.inject({ method: "DELETE", url: `/api/projects/${projectId}` });

    expect(
      ctx.handle.db
        .select()
        .from(schema.activityEvents)
        .where(eq(schema.activityEvents.kind, "task_deleted"))
        .get(),
    ).toMatchObject({
      entityTitle: "Alte Aufgabe",
      taskId: null,
      projectId: null,
    });
    expect(
      ctx.handle.db
        .select()
        .from(schema.activityEvents)
        .where(eq(schema.activityEvents.kind, "project_deleted"))
        .get(),
    ).toMatchObject({
      entityTitle: "Altes Projekt",
      projectId: null,
    });
  });

  it("records dependency, criterion, tag, project edit, and lifecycle events", async () => {
    const tag = ctx.handle.db
      .insert(schema.tags)
      .values({ name: "Wichtig", color: "#000000" })
      .returning()
      .get();
    const owner = ctx.handle.db
      .insert(schema.members)
      .values({ name: "Lea", color: "#ffffff" })
      .returning()
      .get();
    const project = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { title: "Projekt" },
      })
    ).json();
    await ctx.app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}`,
      payload: {
        ownerMemberId: owner.id,
        dueDate: "2026-09-02",
      },
    });
    await ctx.app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}`,
      payload: { tagIds: [tag.id] },
    });
    await ctx.app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/activate`,
      payload: {},
    });
    const criterionResponse = await ctx.app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/criteria`,
      payload: { text: "Fertig" },
    });
    const criterionId = criterionResponse.json().acceptanceCriteria[0].id as number;
    await ctx.app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}/criteria/${criterionId}`,
      payload: { text: "Wirklich fertig" },
    });
    await ctx.app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/criteria/${criterionId}/check`,
      payload: { checked: true },
    });
    await ctx.app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}/criteria/${criterionId}`,
    });
    const first = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: { title: "Erste", projectId: project.id },
      })
    ).json();
    const second = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: { title: "Zweite", projectId: project.id },
      })
    ).json();
    await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${second.id}/dependencies`,
      payload: { dependsOnTaskId: first.id },
    });
    await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${first.id}/tags`,
      payload: { tagId: tag.id },
    });

    const kinds = events().map((event) => event.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        "project_created",
        "project_updated",
        "project_tags_changed",
        "project_status_changed",
        "project_acceptance_criterion_added",
        "project_acceptance_criterion_updated",
        "project_acceptance_criterion_checked",
        "project_acceptance_criterion_removed",
        "task_created",
        "task_dependencies_changed",
        "task_tags_changed",
      ]),
    );
  });
});
