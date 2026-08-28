import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACTIVITY_ACTOR_HEADER } from "@machbar/shared";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema.js";
import {
  completeTask,
  createTask,
  type CreateTaskInput,
  updateTask,
} from "../src/domain/mutations.js";
import {
  closeTestContext,
  createTestContext,
  type TestContext,
} from "./helpers.js";

describe("fixed-day recurring tasks", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await closeTestContext(ctx);
  });

  function recurring(overrides: Partial<CreateTaskInput> = {}) {
    return createTask(ctx.handle.db, {
      title: "Filter wechseln",
      status: "actionable",
      scheduledDate: "2026-08-20",
      repeatAfterDays: 7,
      allowedDeviationDays: 2,
      ...overrides,
    });
  }

  it("validates explicit recurrence and derives the inclusive deadline", () => {
    expect(() =>
      createTask(ctx.handle.db, {
        title: "Ohne Termin",
        repeatAfterDays: 7,
        allowedDeviationDays: 1,
      }),
    ).toThrow(/scheduled date/i);

    const task = recurring();
    expect(task).toMatchObject({
      repeatAfterDays: 7,
      allowedDeviationDays: 2,
      scheduledDate: "2026-08-20",
      dueDate: "2026-08-22",
    });

    expect(() =>
      updateTask(ctx.handle.db, task.id, { dueDate: "2026-08-23" }),
    ).toThrow(/derived/i);
  });

  it.each([
    ["2026-08-19", "hit"],
    ["2026-08-22", "hit"],
    ["2026-08-23", "miss"],
  ] as const)(
    "records %s as %s and schedules from the browser-local completion date",
    (completedOn, result) => {
      const task = recurring();
      const updated = completeTask(
        ctx.handle.db,
        task.id,
        undefined,
        undefined,
        completedOn,
        task.revision,
      );

      expect(updated).toMatchObject({
        id: task.id,
        status: "actionable",
        completedAt: null,
        scheduledDate:
          completedOn === "2026-08-19"
            ? "2026-08-26"
            : completedOn === "2026-08-22"
              ? "2026-08-29"
              : "2026-08-30",
      });
      const occurrence = ctx.handle.db
        .select()
        .from(schema.taskRecurrenceOccurrences)
        .get();
      expect(occurrence).toMatchObject({
        taskId: task.id,
        scheduledDate: "2026-08-20",
        deadlineDate: "2026-08-22",
        completedOn,
        result,
      });
    },
  );

  it("keeps occurrence snapshots immutable when recurrence settings change", () => {
    const task = recurring();
    completeTask(
      ctx.handle.db,
      task.id,
      undefined,
      undefined,
      "2026-08-21",
      task.revision,
    );
    const updated = updateTask(ctx.handle.db, task.id, {
      repeatAfterDays: 30,
      allowedDeviationDays: 5,
      scheduledDate: "2026-09-01",
    });
    expect(updated.dueDate).toBe("2026-09-06");

    expect(
      ctx.handle.db.select().from(schema.taskRecurrenceOccurrences).get(),
    ).toMatchObject({
      scheduledDate: "2026-08-20",
      deadlineDate: "2026-08-22",
      completedOn: "2026-08-21",
      result: "hit",
    });
  });

  it("retains dates when recurrence is disabled", () => {
    const task = recurring();
    const updated = updateTask(ctx.handle.db, task.id, {
      repeatAfterDays: null,
      allowedDeviationDays: null,
    });
    expect(updated).toMatchObject({
      repeatAfterDays: null,
      allowedDeviationDays: null,
      scheduledDate: "2026-08-20",
      dueDate: "2026-08-22",
    });
  });

  it("enforces leaf-only recurrence in both directions", async () => {
    const parent = createTask(ctx.handle.db, {
      title: "Parent",
      status: "actionable",
    });
    createTask(ctx.handle.db, {
      title: "Child",
      parentTaskId: parent.id,
    });
    expect(() =>
      updateTask(ctx.handle.db, parent.id, {
        scheduledDate: "2026-08-20",
        repeatAfterDays: 7,
        allowedDeviationDays: 0,
      }),
    ).toThrow(/without subtasks/i);

    const recurringTask = recurring();
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${recurringTask.id}/children`,
      payload: { title: "Nicht erlaubt" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("recurring_parent_forbidden");
  });

  it("does not let ancestor bulk completion bypass a recurring child", () => {
    const parent = createTask(ctx.handle.db, {
      title: "Parent",
      status: "actionable",
    });
    recurring({ parentTaskId: parent.id });

    expect(() =>
      completeTask(ctx.handle.db, parent.id, "complete_children"),
    ).toThrow(/completed individually/i);
    expect(
      ctx.handle.db.select().from(schema.taskRecurrenceOccurrences).all(),
    ).toEqual([]);
  });

  it("rejects move and indent paths under a recurring parent", async () => {
    const parent = recurring();
    const candidate = createTask(ctx.handle.db, {
      title: "Candidate",
      status: "actionable",
    });

    const moved = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${candidate.id}/move`,
      payload: { parentTaskId: parent.id },
    });
    expect(moved.statusCode).toBe(409);
    expect(moved.json().error.code).toBe("recurring_parent_forbidden");

    const indented = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${candidate.id}/indent`,
    });
    expect(indented.statusCode).toBe(409);
    expect(indented.json().error.code).toBe("recurring_parent_forbidden");
  });

  it("requires completedOn and prevents direct status completion from bypassing recurrence", async () => {
    const task = recurring();
    const rejected = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/status`,
      payload: { status: "done" },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.code).toBe(
      "recurrence_completion_date_required",
    );

    const completed = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/status`,
      payload: {
        status: "done",
        completedOn: "2026-08-21",
        expectedRevision: task.revision,
      },
    });
    expect(completed.json()).toMatchObject({
      status: "actionable",
      scheduledDate: "2026-08-28",
      dueDate: "2026-08-30",
    });

    const patchedTask = recurring({ scheduledDate: "2026-09-01" });
    const patched = await ctx.app.inject({
      method: "PATCH",
      url: `/api/tasks/${patchedTask.id}`,
      payload: {
        status: "done",
        completedOn: "2026-09-01",
        expectedRevision: patchedTask.revision,
      },
    });
    expect(patched.json().status).toBe("actionable");
  });

  it("rejects a replayed completion for an already advanced occurrence", async () => {
    const task = recurring();
    const payload = {
      completedOn: "2026-08-21",
      expectedRevision: task.revision,
    };
    const first = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/complete`,
      payload,
    });
    expect(first.statusCode).toBe(200);

    const replay = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/complete`,
      payload,
    });
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error.code).toBe("stale_write_conflict");
    expect(
      ctx.handle.db.select().from(schema.taskRecurrenceOccurrences).all(),
    ).toHaveLength(1);
  });

  it("does not advance recurrence when cancelled", async () => {
    const task = recurring();
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/cancel`,
      payload: {},
    });
    expect(response.json()).toMatchObject({
      status: "cancelled",
      scheduledDate: "2026-08-20",
      dueDate: "2026-08-22",
    });
    expect(
      ctx.handle.db.select().from(schema.taskRecurrenceOccurrences).all(),
    ).toEqual([]);
  });

  it("returns newest-first history with an empty and populated summary", async () => {
    const task = recurring();
    const empty = await ctx.app.inject({
      method: "GET",
      url: `/api/tasks/${task.id}/recurrence-history`,
    });
    expect(empty.json()).toEqual({
      summary: { hitCount: 0, missCount: 0, totalCount: 0, hitRate: null },
      occurrences: [],
    });

    const firstCompletion = completeTask(
      ctx.handle.db,
      task.id,
      undefined,
      undefined,
      "2026-08-23",
      task.revision,
    );
    completeTask(
      ctx.handle.db,
      task.id,
      undefined,
      undefined,
      "2026-08-30",
      firstCompletion.revision,
    );
    const populated = await ctx.app.inject({
      method: "GET",
      url: `/api/tasks/${task.id}/recurrence-history`,
    });
    expect(populated.json().summary).toEqual({
      hitCount: 1,
      missCount: 1,
      totalCount: 2,
      hitRate: 0.5,
    });
    expect(
      populated
        .json()
        .occurrences.map((row: { completedOn: string }) => row.completedOn),
    ).toEqual(["2026-08-30", "2026-08-23"]);
  });

  it("awards each occurrence and attributes a separate miss penalty to the effective owner", async () => {
    const owner = ctx.handle.db
      .insert(schema.members)
      .values({ name: "Mira", color: "#123456" })
      .returning()
      .get();
    const actor = ctx.handle.db
      .insert(schema.members)
      .values({ name: "Lea", color: "#654321" })
      .returning()
      .get();
    const task = recurring({
      ownerMemberId: owner.id,
      ownerInheritanceMode: "explicit",
      repeatAfterDays: 2,
    });

    let expectedRevision = task.revision;
    for (const completedOn of ["2026-08-23", "2026-08-28"]) {
      const response = await ctx.app.inject({
        method: "POST",
        url: `/api/tasks/${task.id}/complete`,
        headers: { [ACTIVITY_ACTOR_HEADER]: String(actor.id) },
        payload: { completedOn, expectedRevision },
      });
      expect(response.statusCode).toBe(200);
      expectedRevision = response.json().revision;
    }

    const rows = ctx.handle.db
      .select()
      .from(schema.contributionEvents)
      .all();
    expect(rows.filter((row) => row.reason === "task_completed")).toEqual([
      expect.objectContaining({ sharedPoints: 2 }),
      expect.objectContaining({ sharedPoints: 2 }),
    ]);
    expect(rows.filter((row) => row.reason === "recurrence_missed")).toEqual([
      expect.objectContaining({
        actorMemberId: owner.id,
        sharedPoints: -1,
        personalPoints: -1,
      }),
      expect.objectContaining({
        actorMemberId: owner.id,
        sharedPoints: -1,
        personalPoints: -1,
      }),
    ]);
    expect(
      ctx.handle.db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.id, task.id))
        .get()?.status,
    ).toBe("actionable");
  });
});
