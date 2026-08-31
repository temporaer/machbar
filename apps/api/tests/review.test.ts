import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../src/db/schema.js";
import { Graph } from "../src/domain/graph.js";
import {
  ACTIVE_REVIEW_DAYS,
  BACKLOG_REVIEW_DAYS,
  SOMEDAY_REVIEW_DAYS,
  buildReviewItems,
} from "../src/domain/reviewItems.js";
import {
  closeTestContext,
  createTestContext,
  type TestContext,
} from "./helpers.js";

describe("review queue", () => {
  let ctx: TestContext;
  const today = "2026-08-31";

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await closeTestContext(ctx);
  });

  function setProjectAge(id: number, date: string) {
    ctx.handle.sqlite
      .prepare("UPDATE projects SET updated_at = ?, reviewed_at = NULL WHERE id = ?")
      .run(`${date}T10:00:00.000Z`, id);
  }

  function setTaskAge(id: number, date: string) {
    ctx.handle.sqlite
      .prepare("UPDATE tasks SET updated_at = ?, reviewed_at = NULL WHERE id = ?")
      .run(`${date}T10:00:00.000Z`, id);
  }

  function reviewItems() {
    return buildReviewItems(Graph.load(ctx.handle.db, today), { today });
  }

  it("derives structural, completion, backlog, active, and standalone someday review reasons deterministically", () => {
    const member = ctx.handle.db
      .insert(schema.members)
      .values({ name: "Mira", color: "#123456" })
      .returning()
      .get();
    const noDriver = ctx.handle.db
      .insert(schema.projects)
      .values({ title: "No driver", status: "active" })
      .returning()
      .get();
    const staleActive = ctx.handle.db
      .insert(schema.projects)
      .values({
        title: "Stale active",
        status: "active",
        ownerMemberId: member.id,
      })
      .returning()
      .get();
    const activeTask = ctx.handle.db
      .insert(schema.tasks)
      .values({ projectId: staleActive.id, title: "Do it" })
      .returning()
      .get();
    const completion = ctx.handle.db
      .insert(schema.projects)
      .values({
        title: "Complete me",
        status: "active",
        ownerMemberId: member.id,
      })
      .returning()
      .get();
    ctx.handle.db.insert(schema.tasks).values({
      projectId: completion.id,
      title: "Done",
      status: "done",
    }).run();
    const backlog = ctx.handle.db
      .insert(schema.projects)
      .values({ title: "Old backlog" })
      .returning()
      .get();
    const dueBacklog = ctx.handle.db
      .insert(schema.projects)
      .values({ title: "Due backlog", dueDate: today })
      .returning()
      .get();
    const someday = ctx.handle.db
      .insert(schema.tasks)
      .values({ title: "Maybe", status: "someday" })
      .returning()
      .get();
    setProjectAge(
      staleActive.id,
      `2026-08-${String(31 - ACTIVE_REVIEW_DAYS).padStart(2, "0")}`,
    );
    setTaskAge(
      activeTask.id,
      `2026-08-${String(31 - ACTIVE_REVIEW_DAYS).padStart(2, "0")}`,
    );
    setProjectAge(backlog.id, "2026-07-01");
    setTaskAge(someday.id, "2026-05-01");

    const reasons = reviewItems().map((item) => [
      item.entityTitle,
      item.reason,
    ]);
    expect(reasons).toEqual(
      expect.arrayContaining([
        ["No driver", "missing_driver"],
        ["No driver", "no_viable_progress_path"],
        ["Complete me", "completion_review"],
        ["Stale active", "active_stale"],
        ["Old backlog", "backlog_stale"],
        ["Due backlog", "backlog_due"],
        ["Maybe", "standalone_someday_stale"],
      ]),
    );
    expect(ACTIVE_REVIEW_DAYS).toBe(14);
    expect(BACKLOG_REVIEW_DAYS).toBe(30);
    expect(SOMEDAY_REVIEW_DAYS).toBe(90);
  });

  it("leases an acknowledged overdue backlog project for 30 days", () => {
    const project = ctx.handle.db
      .insert(schema.projects)
      .values({ title: "Due backlog", dueDate: today })
      .returning()
      .get();
    expect(
      reviewItems().some(
        (item) =>
          item.entityId === project.id && item.reason === "backlog_due",
      ),
    ).toBe(true);

    ctx.handle.sqlite
      .prepare("UPDATE projects SET reviewed_at = ? WHERE id = ?")
      .run(`${today}T10:00:00.000Z`, project.id);
    expect(reviewItems().some((item) => item.entityId === project.id)).toBe(
      false,
    );

    ctx.handle.sqlite
      .prepare("UPDATE projects SET reviewed_at = ? WHERE id = ?")
      .run("2026-08-01T10:00:00.000Z", project.id);
    expect(
      reviewItems().some(
        (item) =>
          item.entityId === project.id && item.reason === "backlog_due",
      ),
    ).toBe(true);
  });

  it("suppresses active staleness for a healthy future wait and does not age project someday tasks", () => {
    const member = ctx.handle.db
      .insert(schema.members)
      .values({ name: "Theo", color: "#654321" })
      .returning()
      .get();
    const project = ctx.handle.db
      .insert(schema.projects)
      .values({
        title: "Waiting well",
        status: "active",
        ownerMemberId: member.id,
      })
      .returning()
      .get();
    const waiting = ctx.handle.db
      .insert(schema.tasks)
      .values({
        projectId: project.id,
        title: "Reply",
        scheduledDate: "2026-09-02",
      })
      .returning()
      .get();
    ctx.handle.db.insert(schema.taskExternalWaits).values({
      taskId: waiting.id,
      waitingFor: "Reply",
    }).run();
    const projectSomeday = ctx.handle.db
      .insert(schema.tasks)
      .values({
        projectId: project.id,
        title: "Later in project",
        status: "someday",
      })
      .returning()
      .get();
    setProjectAge(project.id, "2026-01-01");
    setTaskAge(waiting.id, "2026-01-01");
    setTaskAge(projectSomeday.id, "2026-01-01");

    const items = reviewItems();
    expect(items.some((item) => item.reason === "active_stale")).toBe(false);
    expect(
      items.some(
        (item) =>
          item.entityId === projectSomeday.id &&
          item.reason === "standalone_someday_stale",
      ),
    ).toBe(false);
  });

  it("uses the newest project or descendant update/review as active attention", () => {
    const member = ctx.handle.db
      .insert(schema.members)
      .values({ name: "Attention owner", color: "#112233" })
      .returning()
      .get();
    const project = ctx.handle.db
      .insert(schema.projects)
      .values({
        title: "Recently reviewed",
        status: "active",
        ownerMemberId: member.id,
      })
      .returning()
      .get();
    const task = ctx.handle.db
      .insert(schema.tasks)
      .values({ projectId: project.id, title: "Still viable" })
      .returning()
      .get();
    setProjectAge(project.id, "2026-01-01");
    setTaskAge(task.id, "2026-01-01");
    ctx.handle.sqlite
      .prepare("UPDATE tasks SET reviewed_at = ? WHERE id = ?")
      .run("2026-08-30T10:00:00.000Z", task.id);
    expect(
      reviewItems().some(
        (item) =>
          item.entityId === project.id && item.reason === "active_stale",
      ),
    ).toBe(false);

    ctx.handle.sqlite
      .prepare("UPDATE tasks SET reviewed_at = NULL WHERE id = ?")
      .run(task.id);
    ctx.handle.sqlite
      .prepare("UPDATE projects SET reviewed_at = ? WHERE id = ?")
      .run("2026-08-30T10:00:00.000Z", project.id);
    expect(
      reviewItems().some(
        (item) =>
          item.entityId === project.id && item.reason === "active_stale",
      ),
    ).toBe(false);
  });

  it("emits active staleness only for otherwise healthy projects with a canonical candidate", () => {
    const member = ctx.handle.db
      .insert(schema.members)
      .values({ name: "Healthy owner", color: "#445566" })
      .returning()
      .get();
    const healthy = ctx.handle.db
      .insert(schema.projects)
      .values({
        title: "Healthy but old",
        status: "active",
        ownerMemberId: member.id,
      })
      .returning()
      .get();
    const healthyTask = ctx.handle.db
      .insert(schema.tasks)
      .values({ projectId: healthy.id, title: "Executable" })
      .returning()
      .get();
    const noPath = ctx.handle.db
      .insert(schema.projects)
      .values({
        title: "No path and old",
        status: "active",
        ownerMemberId: member.id,
      })
      .returning()
      .get();
    const completion = ctx.handle.db
      .insert(schema.projects)
      .values({
        title: "Complete and old",
        status: "active",
        ownerMemberId: member.id,
      })
      .returning()
      .get();
    const doneTask = ctx.handle.db
      .insert(schema.tasks)
      .values({
        projectId: completion.id,
        title: "Done",
        status: "done",
      })
      .returning()
      .get();
    const waitingDefect = ctx.handle.db
      .insert(schema.projects)
      .values({
        title: "Waiting defect and old",
        status: "active",
        ownerMemberId: member.id,
      })
      .returning()
      .get();
    const executable = ctx.handle.db
      .insert(schema.tasks)
      .values({ projectId: waitingDefect.id, title: "Still executable" })
      .returning()
      .get();
    const waiting = ctx.handle.db
      .insert(schema.tasks)
      .values({ projectId: waitingDefect.id, title: "Missing followup" })
      .returning()
      .get();
    ctx.handle.db.insert(schema.taskExternalWaits).values({
      taskId: waiting.id,
      waitingFor: "Reply",
    }).run();
    for (const project of [healthy, noPath, completion, waitingDefect]) {
      setProjectAge(project.id, "2026-01-01");
    }
    for (const task of [healthyTask, doneTask, executable, waiting]) {
      setTaskAge(task.id, "2026-01-01");
    }

    const items = reviewItems();
    expect(items).toContainEqual(
      expect.objectContaining({
        entityId: healthy.id,
        reason: "active_stale",
      }),
    );
    for (const project of [noPath, completion, waitingDefect]) {
      expect(
        items.some(
          (item) =>
            item.entityId === project.id && item.reason === "active_stale",
        ),
      ).toBe(false);
    }
    expect(items).toContainEqual(
      expect.objectContaining({
        entityId: noPath.id,
        reason: "no_viable_progress_path",
      }),
    );
    expect(items).toContainEqual(
      expect.objectContaining({
        entityId: completion.id,
        reason: "completion_review",
      }),
    );
    expect(items).toContainEqual(
      expect.objectContaining({
        entityId: waiting.id,
        reason: "waiting_without_followup",
      }),
    );
  });

  it("reports actionable repair roots while omitting redundant captured, unassigned, and reached-followup debt", () => {
    const member = ctx.handle.db
      .insert(schema.members)
      .values({ name: "Repair owner", color: "#abcdef" })
      .returning()
      .get();
    const project = ctx.handle.db
      .insert(schema.projects)
      .values({
        title: "Repair project",
        status: "active",
        ownerMemberId: member.id,
        dueDate: today,
      })
      .returning()
      .get();
    const large = ctx.handle.db
      .insert(schema.tasks)
      .values({
        projectId: project.id,
        title: "Large work",
        status: "actionable",
        size: "XL",
      })
      .returning()
      .get();
    const waiting = ctx.handle.db
      .insert(schema.tasks)
      .values({
        projectId: project.id,
        title: "Wait without date",
        status: "actionable",
      })
      .returning()
      .get();
    ctx.handle.db.insert(schema.taskExternalWaits).values({
      taskId: waiting.id,
      waitingFor: "Reply",
    }).run();
    const captured = ctx.handle.db
      .insert(schema.tasks)
      .values({ title: "Captured prerequisite", status: "captured" })
      .returning()
      .get();
    const downstream = ctx.handle.db
      .insert(schema.tasks)
      .values({ title: "Broken downstream", status: "actionable" })
      .returning()
      .get();
    ctx.handle.db.insert(schema.taskDependencies).values({
      taskId: downstream.id,
      dependsOnTaskId: captured.id,
    }).run();
    const dueWait = ctx.handle.db
      .insert(schema.tasks)
      .values({
        title: "Reached followup",
        status: "actionable",
        scheduledDate: today,
      })
      .returning()
      .get();
    ctx.handle.db.insert(schema.taskExternalWaits).values({
      taskId: dueWait.id,
      waitingFor: "Reached",
    }).run();
    ctx.handle.db.insert(schema.tasks).values({
      title: "Unassigned executable",
      status: "actionable",
    }).run();

    const items = reviewItems();
    expect(items).toContainEqual(
      expect.objectContaining({
        projectId: project.id,
        reason: "due_without_credible_plan",
        suggestedAction: {
          code: "plan_task",
          targetEntityType: "task",
          targetEntityId: large.id,
        },
      }),
    );
    expect(
      ctx.handle.db
        .select({ id: schema.tasks.id })
        .from(schema.tasks)
        .all()
        .some(
          (task) =>
            task.id ===
            items.find(
              (item) =>
                item.projectId === project.id &&
                item.reason === "due_without_credible_plan",
            )?.suggestedAction.targetEntityId,
        ),
    ).toBe(true);
    expect(items).toContainEqual(
      expect.objectContaining({
        entityTitle: "Large work",
        reason: "xl_without_children",
      }),
    );
    expect(items).toContainEqual(
      expect.objectContaining({
        entityId: waiting.id,
        reason: "waiting_without_followup",
      }),
    );
    expect(items).toContainEqual(
      expect.objectContaining({
        entityId: downstream.id,
        reason: "broken_blocker_path",
        suggestedAction: expect.objectContaining({
          targetEntityId: captured.id,
        }),
      }),
    );
    expect(items.some((item) => item.entityId === captured.id)).toBe(false);
    expect(items.some((item) => item.entityId === dueWait.id)).toBe(false);
    expect(
      items.some((item) => item.reason === ("unassigned_actionable" as never)),
    ).toBe(false);
  });

  it("acknowledges project and task review revision-safely without touching updatedAt or awarding points", async () => {
    const project = ctx.handle.db
      .insert(schema.projects)
      .values({ title: "Review project" })
      .returning()
      .get();
    const task = ctx.handle.db
      .insert(schema.tasks)
      .values({ title: "Review task", status: "someday" })
      .returning()
      .get();

    const projectResponse = await ctx.app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/review`,
      payload: { expectedRevision: project.revision },
    });
    const taskResponse = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/review`,
      payload: { expectedRevision: task.revision },
    });

    expect(projectResponse.statusCode).toBe(200);
    expect(projectResponse.json()).toMatchObject({
      revision: project.revision + 1,
      updatedAt: project.updatedAt,
    });
    expect(projectResponse.json().reviewedAt).not.toBeNull();
    expect(taskResponse.statusCode).toBe(200);
    expect(taskResponse.json()).toMatchObject({
      revision: task.revision + 1,
      updatedAt: task.updatedAt,
    });
    expect(taskResponse.json().reviewedAt).not.toBeNull();
    expect(ctx.handle.db.select().from(schema.contributionEvents).all()).toEqual([]);

    const stale = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/review`,
      payload: { expectedRevision: task.revision },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("stale_write_conflict");
  });

  it("returns the same derived queue and count from review endpoints", async () => {
    const project = ctx.handle.db
      .insert(schema.projects)
      .values({ title: "Old backlog" })
      .returning()
      .get();
    setProjectAge(project.id, "2026-01-01");

    const items = reviewItems();
    const endpoint = await ctx.app.inject({
      method: "GET",
      url: "/api/review",
    });
    const counts = await ctx.app.inject({
      method: "GET",
      url: "/api/views/more-counts",
    });
    expect(endpoint.statusCode).toBe(200);
    expect(endpoint.json().length).toBeGreaterThanOrEqual(items.length);
    expect(counts.json()).toEqual({ review: endpoint.json().length });
  });

  it("orders equal review reasons by project and entity titles before stable type and ID ties", () => {
    const member = ctx.handle.db
      .insert(schema.members)
      .values({ name: "Queue owner", color: "#334455" })
      .returning()
      .get();
    const zuluProject = ctx.handle.db
      .insert(schema.projects)
      .values({
        title: "Zulu project",
        status: "active",
        ownerMemberId: member.id,
      })
      .returning()
      .get();
    const alphaProject = ctx.handle.db
      .insert(schema.projects)
      .values({
        title: "Alpha project",
        status: "active",
        ownerMemberId: member.id,
      })
      .returning()
      .get();
    const zuluProjectTask = ctx.handle.db
      .insert(schema.tasks)
      .values({ projectId: zuluProject.id, title: "Alpha entity" })
      .returning()
      .get();
    const alphaProjectTask = ctx.handle.db
      .insert(schema.tasks)
      .values({ projectId: alphaProject.id, title: "Zulu entity" })
      .returning()
      .get();
    const duplicateFirst = ctx.handle.db
      .insert(schema.tasks)
      .values({ projectId: alphaProject.id, title: "Duplicate entity" })
      .returning()
      .get();
    const duplicateSecond = ctx.handle.db
      .insert(schema.tasks)
      .values({ projectId: alphaProject.id, title: "Duplicate entity" })
      .returning()
      .get();
    const standalone = ctx.handle.db
      .insert(schema.tasks)
      .values({ title: "A standalone entity" })
      .returning()
      .get();
    for (const task of [
      zuluProjectTask,
      alphaProjectTask,
      duplicateFirst,
      duplicateSecond,
      standalone,
    ]) {
      ctx.handle.db
        .insert(schema.taskExternalWaits)
        .values({ taskId: task.id, waitingFor: "Reply" })
        .run();
    }

    expect(
      reviewItems()
        .filter((item) => item.reason === "waiting_without_followup")
        .map((item) => item.entityId),
    ).toEqual([
      duplicateFirst.id,
      duplicateSecond.id,
      alphaProjectTask.id,
      zuluProjectTask.id,
      standalone.id,
    ]);
  });
});
