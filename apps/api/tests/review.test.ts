import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
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
      .prepare("UPDATE work_items SET updated_at = ?, reviewed_at = NULL WHERE id = ?")
      .run(`${date}T10:00:00.000Z`, id);
  }

  function setTaskAge(id: number, date: string) {
    ctx.handle.sqlite
      .prepare("UPDATE work_items SET updated_at = ?, reviewed_at = NULL WHERE id = ?")
      .run(`${date}T10:00:00.000Z`, id);
  }

  function reviewItems() {
    return buildReviewItems(Graph.load(ctx.handle.db, today), {
      today,
      now: `${today}T12:00:00.000Z`,
    });
  }

  it("derives structural, completion, backlog, active, and standalone someday review reasons deterministically", () => {
    const member = ctx.handle.db
      .insert(schema.members)
      .values({ name: "Mira", color: "#123456" })
      .returning()
      .get();
    const noDriver = ctx.handle.db
      .insert(schema.workItems)
      .values({ role: "story", title: "No driver", status: "active" })
      .returning()
      .get();
    const staleActive = ctx.handle.db
      .insert(schema.workItems)
      .values({ role: "story",
        title: "Stale active",
        status: "active",
        ownerMemberId: member.id,
      })
      .returning()
      .get();
    const activeTask = ctx.handle.db
      .insert(schema.workItems)
      .values({ role: "task", status: "active", parentId: staleActive.id, title: "Do it" })
      .returning()
      .get();
    const completion = ctx.handle.db
      .insert(schema.workItems)
      .values({ role: "story",
        title: "Complete me",
        status: "active",
        ownerMemberId: member.id,
      })
      .returning()
      .get();
    ctx.handle.db.insert(schema.workItems).values({ role: "task",
      parentId: completion.id,
      title: "Done",
      status: "done",
    }).run();
    const backlog = ctx.handle.db
      .insert(schema.workItems)
      .values({ role: "story", status: "backlog", title: "Old backlog" })
      .returning()
      .get();
    const dueBacklog = ctx.handle.db
      .insert(schema.workItems)
      .values({ role: "story", status: "backlog", title: "Due backlog", dueDate: today })
      .returning()
      .get();
    const someday = ctx.handle.db
      .insert(schema.workItems)
      .values({ role: "task", title: "Maybe", status: "backlog" })
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
      .insert(schema.workItems)
      .values({ role: "story", status: "backlog", title: "Due backlog", dueDate: today })
      .returning()
      .get();
    expect(
      reviewItems().some(
        (item) =>
          item.entityId === project.id && item.reason === "backlog_due",
      ),
    ).toBe(true);

    ctx.handle.sqlite
      .prepare("UPDATE work_items SET reviewed_at = ? WHERE id = ?")
      .run(`${today}T10:00:00.000Z`, project.id);
    expect(reviewItems().some((item) => item.entityId === project.id)).toBe(
      false,
    );

    ctx.handle.sqlite
      .prepare("UPDATE work_items SET reviewed_at = ? WHERE id = ?")
      .run("2026-08-01T10:00:00.000Z", project.id);
    expect(
      reviewItems().some(
        (item) =>
          item.entityId === project.id && item.reason === "backlog_due",
      ),
    ).toBe(true);
  });

  it("surfaces reached backlog project revisits in Review", () => {
    const reached = ctx.handle.db
      .insert(schema.workItems)
      .values({
        role: "story",
        status: "backlog",
        title: "Reached revisit",
        revisitAt: `${today}T00:00:00.000Z`,
        reviewedAt: `${today}T12:00:00.000Z`,
      })
      .returning()
      .get();
    const future = ctx.handle.db
      .insert(schema.workItems)
      .values({
        role: "story",
        status: "backlog",
        title: "Future revisit",
        revisitAt: "2026-09-05T00:00:00.000Z",
      })
      .returning()
      .get();

    const items = reviewItems();
    expect(
      items.find(
        (item) =>
          item.entityId === reached.id &&
          item.reason === "backlog_revisit_reached",
      ),
    ).toMatchObject({
      suggestedAction: {
        code: "defer_project",
        targetEntityType: "project",
        targetEntityId: reached.id,
      },
    });
    expect(items.some((item) => item.entityId === future.id)).toBe(false);
  });

  it("does not treat a later revisit as due earlier on the selected day", () => {
    const project = ctx.handle.db
      .insert(schema.workItems)
      .values({
        role: "story",
        status: "backlog",
        title: "Evening revisit",
        revisitAt: `${today}T20:00:00.000Z`,
      })
      .returning()
      .get();
    const graph = Graph.load(ctx.handle.db, today);

    expect(
      buildReviewItems(graph, {
        today,
        now: `${today}T08:00:00.000Z`,
      }).some((item) => item.entityId === project.id),
    ).toBe(false);
    expect(
      buildReviewItems(graph, {
        today,
        now: `${today}T20:00:00.000Z`,
      }).some((item) => item.entityId === project.id),
    ).toBe(true);
  });

  it("suppresses active staleness for a healthy future wait and does not age project someday tasks", () => {
    const member = ctx.handle.db
      .insert(schema.members)
      .values({ name: "Theo", color: "#654321" })
      .returning()
      .get();
    const project = ctx.handle.db
      .insert(schema.workItems)
      .values({ role: "story",
        title: "Waiting well",
        status: "active",
        ownerMemberId: member.id,
      })
      .returning()
      .get();
    const waiting = ctx.handle.db
      .insert(schema.workItems)
      .values({ role: "task", status: "active",
        parentId: project.id,
        title: "Reply",
        scheduledDate: "2026-09-02",
      })
      .returning()
      .get();
    ctx.handle.db.insert(schema.taskExternalWaits).values({
      taskId: waiting.id,
      waitingFor: "Reply",
      revisitDate: "2026-09-02",
    }).run();
    const projectSomeday = ctx.handle.db
      .insert(schema.workItems)
      .values({ role: "task",
        parentId: project.id,
        title: "Later in project",
        status: "backlog",
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

  it("treats a task deferred by a future notBeforeAt as a healthy progress path", () => {
    const member = ctx.handle.db
      .insert(schema.members)
      .values({ name: "Nora", color: "#a1b2c3" })
      .returning()
      .get();
    const project = ctx.handle.db
      .insert(schema.workItems)
      .values({
        role: "story",
        title: "Deferred but healthy",
        status: "active",
        ownerMemberId: member.id,
      })
      .returning()
      .get();
    const deferred = ctx.handle.db
      .insert(schema.workItems)
      .values({
        role: "task",
        status: "active",
        parentId: project.id,
        title: "Not before tonight",
        notBeforeAt: "2099-01-01T18:00:00.000Z",
        notBeforeDate: "2099-01-01",
      })
      .returning()
      .get();
    setProjectAge(project.id, "2026-01-01");
    setTaskAge(deferred.id, "2026-01-01");

    const items = reviewItems();
    expect(
      items.some(
        (item) =>
          item.entityId === project.id &&
          item.reason === "no_viable_progress_path",
      ),
    ).toBe(false);
  });

  it.each([
    ["captured", "captured"],
    ["Someday", "backlog"],
  ] as const)(
    "reports no viable progress for a reached revisit container with %s work",
    async (_label, childStatus) => {
      const owner = ctx.handle.db
        .insert(schema.members)
        .values({ name: "Container owner", color: "#123456" })
        .returning()
        .get();
      const project = ctx.handle.db
        .insert(schema.workItems)
        .values({
          role: "story",
          title: "Container project",
          status: "active",
          ownerMemberId: owner.id,
        })
        .returning()
        .get();
      const parent = ctx.handle.db
        .insert(schema.workItems)
        .values({
          role: "task",
          parentId: project.id,
          title: "Reached parent",
          status: "active",
          revisitAt: "2026-08-30T12:00:00.000Z",
        })
        .returning()
        .get();
      ctx.handle.db
        .insert(schema.workItems)
        .values({
          role: "task",
          parentId: parent.id,
          title: `${_label} child`,
          status: childStatus,
        })
        .run();

      const projectRead = await ctx.app.inject({
        method: "GET",
        url: `/api/projects/${project.id}`,
      });
      expect(projectRead.json()).toMatchObject({
        stuckReason: "no_next_action",
        nextAction: null,
        activationReadiness: {
          ready: false,
          hasViableProgressPath: false,
        },
      });
      const review = await ctx.app.inject({
        method: "GET",
        url: "/api/review",
      });
      expect(review.json()).toContainEqual(
        expect.objectContaining({
          entityType: "project",
          entityId: project.id,
          reason: "no_viable_progress_path",
          suggestedAction: { code: "add_next_action" },
        }),
      );
    },
  );

  it("keeps a future container revisit as a healthy pause in Review", async () => {
    const owner = ctx.handle.db
      .insert(schema.members)
      .values({ name: "Future owner", color: "#123456" })
      .returning()
      .get();
    const project = ctx.handle.db
      .insert(schema.workItems)
      .values({
        role: "story",
        title: "Future container project",
        status: "active",
        ownerMemberId: owner.id,
      })
      .returning()
      .get();
    const parent = ctx.handle.db
      .insert(schema.workItems)
      .values({
        role: "task",
        parentId: project.id,
        title: "Future parent",
        status: "active",
        revisitAt: "2099-01-01T12:00:00.000Z",
      })
      .returning()
      .get();
    ctx.handle.db
      .insert(schema.workItems)
      .values({
        role: "task",
        parentId: parent.id,
        title: "Captured child",
        status: "captured",
      })
      .run();

    const projectRead = await ctx.app.inject({
      method: "GET",
      url: `/api/projects/${project.id}`,
    });
    expect(projectRead.json()).toMatchObject({
      stuckReason: null,
      nextAction: null,
      activationReadiness: {
        ready: true,
        hasViableProgressPath: false,
        hasHealthyFutureRevisit: true,
      },
    });
    const review = await ctx.app.inject({ method: "GET", url: "/api/review" });
    expect(
      review.json().some(
        (item: { projectId: number; reason: string }) =>
          item.projectId === project.id &&
          item.reason === "no_viable_progress_path",
      ),
    ).toBe(false);
  });

  it("keeps an eligible descendant as healthy project progress in Review", async () => {
    const project = ctx.handle.db
      .insert(schema.workItems)
      .values({ role: "story", status: "active", title: "Descendant progress" })
      .returning()
      .get();
    const parent = ctx.handle.db
      .insert(schema.workItems)
      .values({
        role: "task",
        parentId: project.id,
        title: "Reached parent",
        status: "active",
        revisitAt: "2026-08-30T12:00:00.000Z",
      })
      .returning()
      .get();
    const child = ctx.handle.db
      .insert(schema.workItems)
      .values({
        role: "task",
        parentId: parent.id,
        title: "Eligible descendant",
        status: "active",
      })
      .returning()
      .get();

    const projectRead = await ctx.app.inject({
      method: "GET",
      url: `/api/projects/${project.id}`,
    });
    expect(projectRead.json().nextAction.id).toBe(child.id);
    const review = await ctx.app.inject({ method: "GET", url: "/api/review" });
    expect(
      review.json().some(
        (item: { projectId: number; reason: string }) =>
          item.projectId === project.id &&
          item.reason === "no_viable_progress_path",
      ),
    ).toBe(false);
  });

  it.each([
    {
      label: "a reached revisit with only captured work",
      childStatus: "captured",
      embeddedProject: false,
      revisitAt: "2026-08-30T12:00:00.000Z",
      stuckReason: "no_next_action",
      ready: false,
      healthyFutureWaiting: false,
      reviewRepair: true,
    },
    {
      label: "a reached revisit with an executable embedded-project descendant",
      childStatus: "active",
      embeddedProject: true,
      revisitAt: "2026-08-30T12:00:00.000Z",
      stuckReason: null,
      ready: false,
      healthyFutureWaiting: false,
      reviewRepair: false,
    },
    {
      label: "a future container pause",
      childStatus: "captured",
      embeddedProject: false,
      revisitAt: "2099-01-01T12:00:00.000Z",
      stuckReason: null,
      ready: true,
      healthyFutureWaiting: true,
      reviewRepair: false,
    },
  ] as const)(
    "keeps cross-project dependency progress consistent through $label",
    async ({
      childStatus,
      embeddedProject,
      revisitAt,
      stuckReason,
      ready,
      healthyFutureWaiting,
      reviewRepair,
    }) => {
      const owner = ctx.handle.db
        .insert(schema.members)
        .values({ name: "Dependency owner", color: "#123456" })
        .returning()
        .get();
      const prerequisiteProject = ctx.handle.db
        .insert(schema.workItems)
        .values({
          role: "story",
          title: "Prerequisite project",
          status: "active",
          ownerMemberId: owner.id,
          scope: "household",
        })
        .returning()
        .get();
      const dependentProject = ctx.handle.db
        .insert(schema.workItems)
        .values({
          role: "story",
          title: "Dependent project",
          status: "active",
          ownerMemberId: owner.id,
          scope: "household",
        })
        .returning()
        .get();
      const container = ctx.handle.db
        .insert(schema.workItems)
        .values({
          role: "task",
          parentId: prerequisiteProject.id,
          title: "Revisited prerequisite",
          status: "active",
          revisitAt,
          scope: "household",
        })
        .returning()
        .get();
      const childParentId = embeddedProject
        ? ctx.handle.db
            .insert(schema.workItems)
            .values({
              role: "story",
              parentId: container.id,
              title: "Embedded prerequisite project",
              status: "active",
              ownerMemberId: owner.id,
              scope: "household",
            })
            .returning()
            .get().id
        : container.id;
      ctx.handle.db
        .insert(schema.workItems)
        .values({
          role: "task",
          parentId: childParentId,
          title: "Prerequisite child",
          status: childStatus,
          scope: "household",
        })
        .run();
      const dependentTask = ctx.handle.db
        .insert(schema.workItems)
        .values({
          role: "task",
          parentId: dependentProject.id,
          title: "Dependent action",
          status: "active",
          scope: "household",
        })
        .returning()
        .get();
      ctx.handle.db
        .insert(schema.taskDependencies)
        .values({
          taskId: dependentTask.id,
          dependsOnTaskId: container.id,
        })
        .run();

      const eventCount = ctx.handle.db
        .select({ id: schema.activityEvents.id })
        .from(schema.activityEvents)
        .all().length;
      const prerequisiteRead = await ctx.app.inject({
        method: "GET",
        url: `/api/projects/${prerequisiteProject.id}`,
      });
      const prerequisiteTask = (
        prerequisiteRead.json().tasks as Array<{
          id: number;
          status: string;
          executable: boolean;
          revisitAt: string | null;
        }>
      ).find((task) => task.id === container.id);
      expect(prerequisiteTask).toMatchObject({
        status: "actionable",
        executable: false,
        revisitAt,
      });
      const projectRead = await ctx.app.inject({
        method: "GET",
        url: `/api/projects/${dependentProject.id}`,
      });
      expect(projectRead.statusCode).toBe(200);
      expect(
        (projectRead.json().tasks as Array<{
          id: number;
          status: string;
          blocked: boolean;
          executable: boolean;
        }>).find((task) => task.id === dependentTask.id),
      ).toMatchObject({
        status: "actionable",
        blocked: true,
        executable: false,
      });
      expect(projectRead.json()).toMatchObject({
        nextAction: null,
        stuckReason,
        activationReadiness: {
          ready,
          hasViableProgressPath: false,
          hasHealthyFutureWaiting: healthyFutureWaiting,
        },
      });
      const review = await ctx.app.inject({
        method: "GET",
        url: "/api/review",
      });
      expect(
        review.json().some(
          (item: { entityId: number; reason: string }) =>
            item.entityId === dependentProject.id &&
            item.reason === "no_viable_progress_path",
        ),
      ).toBe(reviewRepair);
      expect(
        ctx.handle.db
          .select({ revisitAt: schema.workItems.revisitAt })
          .from(schema.workItems)
          .where(eq(schema.workItems.id, container.id))
          .get()?.revisitAt,
      ).toBe(revisitAt);
      expect(
        ctx.handle.db
          .select({ id: schema.activityEvents.id })
          .from(schema.activityEvents)
          .all(),
      ).toHaveLength(eventCount);
    },
  );

  it("accepts an executable cross-project dependency as a healthy progress path", () => {
    const member = ctx.handle.db
      .insert(schema.members)
      .values({ name: "Lea", color: "#345678" })
      .returning()
      .get();
    const project = ctx.handle.db
      .insert(schema.workItems)
      .values({ role: "story",
        title: "Room setup",
        status: "active",
        ownerMemberId: member.id,
      })
      .returning()
      .get();
    const prerequisite = ctx.handle.db
      .insert(schema.workItems)
      .values({ role: "task",
        title: "Place order",
        status: "active",
        scheduledDate: today,
      })
      .returning()
      .get();
    const blocked = ctx.handle.db
      .insert(schema.workItems)
      .values({ role: "task",
        parentId: project.id,
        title: "Build wardrobe",
        status: "active",
      })
      .returning()
      .get();
    ctx.handle.db.insert(schema.taskDependencies).values({
      taskId: blocked.id,
      dependsOnTaskId: prerequisite.id,
    }).run();

    expect(
      reviewItems().some(
        (item) =>
          item.entityType === "project" && item.entityId === project.id,
      ),
    ).toBe(false);
  });

  it.each([true, false])("does not self-certify a dependency-containment cycle (independent witness: %s)", (independentWitness) => {
    const prerequisiteProject = ctx.handle.db
      .insert(schema.workItems)
      .values({
        role: "story",
        title: "Prerequisite project",
        status: "active",
      })
      .returning()
      .get();
    const dependentProject = ctx.handle.db
      .insert(schema.workItems)
      .values({
        role: "story",
        title: "Dependent project",
        status: "active",
      })
      .returning()
      .get();
    const container = ctx.handle.db
      .insert(schema.workItems)
      .values({
        role: "task",
        parentId: prerequisiteProject.id,
        title: "Reached revisit",
        status: "active",
        revisitAt: "2020-01-01T12:00:00.000Z",
      })
      .returning()
      .get();
    const cyclicDescendant = ctx.handle.db
      .insert(schema.workItems)
      .values({
        role: "task",
        parentId: container.id,
        title: "Depends on its container",
        status: "active",
      })
      .returning()
      .get();
    const healthyDescendant = independentWitness ? ctx.handle.db
      .insert(schema.workItems)
      .values({
        role: "task",
        parentId: container.id,
        title: "Independent healthy progress",
        status: "active",
      })
      .returning()
      .get() : undefined;
    const dependentTask = ctx.handle.db
      .insert(schema.workItems)
      .values({
        role: "task",
        parentId: dependentProject.id,
        title: "Waiting for prerequisite",
        status: "active",
      })
      .returning()
      .get();
    ctx.handle.db
      .insert(schema.taskDependencies)
      .values([
        { taskId: cyclicDescendant.id, dependsOnTaskId: container.id },
        { taskId: dependentTask.id, dependsOnTaskId: container.id },
        { taskId: dependentTask.id, dependsOnTaskId: cyclicDescendant.id },
      ])
      .run();

    const graph = Graph.load(ctx.handle.db, today);
    expect(
      graph.hasHealthyProjectProgressPath(
        dependentTask.id,
        Date.parse(`${today}T12:00:00.000Z`),
      ),
    ).toBe(independentWitness);
    expect(graph.nextActionFor(prerequisiteProject.id)?.id).toBe(
      healthyDescendant?.id,
    );
  });

  it("keeps reached-container path analysis within a polynomial work budget", () => {
    const project = ctx.handle.db
      .insert(schema.workItems)
      .values({ role: "story", title: "Deep container chain", status: "active" })
      .returning()
      .get();
    const depth = 12;
    let parentId = project.id;
    let rootId = 0;
    for (let level = 0; level < depth; level += 1) {
      const parent = ctx.handle.db
        .insert(schema.workItems)
        .values({
          role: "task",
          parentId,
          title: `Reached container ${level}`,
          status: "active",
          revisitAt: "2026-08-30T12:00:00.000Z",
        })
        .returning()
        .get();
      if (level === 0) rootId = parent.id;
      parentId = parent.id;
    }
    ctx.handle.db
      .insert(schema.workItems)
      .values({
        role: "task",
        parentId,
        title: "Captured endpoint",
        status: "captured",
      })
      .run();

    const graph = Graph.load(ctx.handle.db, today);
    const pathExpansionSpy = vi.spyOn(graph, "taskContainsUnfinishedWork");
    expect(
      graph.hasHealthyProjectProgressPath(
        rootId,
        Date.parse(`${today}T12:00:00.000Z`),
      ),
    ).toBe(false);
    expect(pathExpansionSpy.mock.calls.length).toBeLessThanOrEqual(depth * 10);
  });

  it("leaves reached external-wait follow-ups to Today instead of Review", () => {
    const member = ctx.handle.db
      .insert(schema.members)
      .values({ name: "Mira", color: "#456789" })
      .returning()
      .get();
    const project = ctx.handle.db
      .insert(schema.workItems)
      .values({ role: "story",
        title: "Await delivery",
        status: "active",
        ownerMemberId: member.id,
      })
      .returning()
      .get();
    const waiting = ctx.handle.db
      .insert(schema.workItems)
      .values({ role: "task",
        parentId: project.id,
        title: "Receive delivery",
        status: "active",
      })
      .returning()
      .get();
    ctx.handle.db.insert(schema.taskExternalWaits).values({
      taskId: waiting.id,
      waitingFor: "Delivery slot",
      revisitDate: today,
    }).run();

    expect(
      reviewItems().some(
        (item) =>
          item.entityType === "project" && item.entityId === project.id,
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
      .insert(schema.workItems)
      .values({ role: "story",
        title: "Recently reviewed",
        status: "active",
        ownerMemberId: member.id,
      })
      .returning()
      .get();
    const task = ctx.handle.db
      .insert(schema.workItems)
      .values({ role: "task", status: "active", parentId: project.id, title: "Still viable" })
      .returning()
      .get();
    setProjectAge(project.id, "2026-01-01");
    setTaskAge(task.id, "2026-01-01");
    ctx.handle.sqlite
      .prepare("UPDATE work_items SET reviewed_at = ? WHERE id = ?")
      .run("2026-08-30T10:00:00.000Z", task.id);
    expect(
      reviewItems().some(
        (item) =>
          item.entityId === project.id && item.reason === "active_stale",
      ),
    ).toBe(false);

    ctx.handle.sqlite
      .prepare("UPDATE work_items SET reviewed_at = NULL WHERE id = ?")
      .run(task.id);
    ctx.handle.sqlite
      .prepare("UPDATE work_items SET reviewed_at = ? WHERE id = ?")
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
      .insert(schema.workItems)
      .values({ role: "story",
        title: "Healthy but old",
        status: "active",
        ownerMemberId: member.id,
      })
      .returning()
      .get();
    const healthyTask = ctx.handle.db
      .insert(schema.workItems)
      .values({ role: "task", status: "active", parentId: healthy.id, title: "Executable" })
      .returning()
      .get();
    const noPath = ctx.handle.db
      .insert(schema.workItems)
      .values({ role: "story",
        title: "No path and old",
        status: "active",
        ownerMemberId: member.id,
      })
      .returning()
      .get();
    const completion = ctx.handle.db
      .insert(schema.workItems)
      .values({ role: "story",
        title: "Complete and old",
        status: "active",
        ownerMemberId: member.id,
      })
      .returning()
      .get();
    const doneTask = ctx.handle.db
      .insert(schema.workItems)
      .values({ role: "task",
        parentId: completion.id,
        title: "Done",
        status: "done",
      })
      .returning()
      .get();
    const waitingDefect = ctx.handle.db
      .insert(schema.workItems)
      .values({ role: "story",
        title: "Waiting defect and old",
        status: "active",
        ownerMemberId: member.id,
      })
      .returning()
      .get();
    const executable = ctx.handle.db
      .insert(schema.workItems)
      .values({ role: "task", status: "active", parentId: waitingDefect.id, title: "Still executable" })
      .returning()
      .get();
    const waiting = ctx.handle.db
      .insert(schema.workItems)
      .values({ role: "task", status: "active", parentId: waitingDefect.id, title: "Missing followup" })
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
      .insert(schema.workItems)
      .values({ role: "story",
        title: "Repair project",
        status: "active",
        ownerMemberId: member.id,
        dueDate: today,
      })
      .returning()
      .get();
    const large = ctx.handle.db
      .insert(schema.workItems)
      .values({ role: "task",
        parentId: project.id,
        title: "Large work",
        status: "active",
        size: "XL",
      })
      .returning()
      .get();
    const waiting = ctx.handle.db
      .insert(schema.workItems)
      .values({ role: "task",
        parentId: project.id,
        title: "Wait without date",
        status: "active",
      })
      .returning()
      .get();
    ctx.handle.db.insert(schema.taskExternalWaits).values({
      taskId: waiting.id,
      waitingFor: "Reply",
    }).run();
    const captured = ctx.handle.db
      .insert(schema.workItems)
      .values({ role: "task", title: "Captured prerequisite", status: "captured" })
      .returning()
      .get();
    const downstream = ctx.handle.db
      .insert(schema.workItems)
      .values({ role: "task", title: "Broken downstream", status: "active" })
      .returning()
      .get();
    ctx.handle.db.insert(schema.taskDependencies).values({
      taskId: downstream.id,
      dependsOnTaskId: captured.id,
    }).run();
    const dueWait = ctx.handle.db
      .insert(schema.workItems)
      .values({ role: "task",
        title: "Reached followup",
        status: "active",
      })
      .returning()
      .get();
    ctx.handle.db.insert(schema.taskExternalWaits).values({
      taskId: dueWait.id,
      waitingFor: "Reached",
      revisitDate: today,
    }).run();
    ctx.handle.db.insert(schema.workItems).values({ role: "task",
      title: "Unassigned executable",
      status: "active",
    }).run();

    const items = reviewItems();
    expect(
      items.filter(
        (item) => item.entityType === "project" && item.entityId === project.id,
      ),
    ).toEqual([]);
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
  });

  it("flags an XL action whose only child is a reference", () => {
    const member = ctx.handle.db
      .insert(schema.members)
      .values({ name: "XL reference owner", color: "#abcdef" })
      .returning()
      .get();
    const project = ctx.handle.db
      .insert(schema.workItems)
      .values({
        role: "story",
        title: "Reference-only project",
        status: "active",
        ownerMemberId: member.id,
      })
      .returning()
      .get();
    const parent = ctx.handle.db
      .insert(schema.workItems)
      .values({
        role: "task",
        parentId: project.id,
        title: "Large work",
        status: "active",
        size: "XL",
      })
      .returning()
      .get();
    ctx.handle.db
      .insert(schema.workItems)
      .values({
        role: "task",
        parentId: parent.id,
        title: "Reference",
        status: "captured",
        taskKind: "reference",
      })
      .run();

    expect(
      reviewItems().some(
        (item) =>
          item.entityId === parent.id && item.reason === "xl_without_children",
      ),
    ).toBe(true);
  });

  it("does not flag an XL action with an open action below a reference", () => {
    const member = ctx.handle.db
      .insert(schema.members)
      .values({ name: "XL nested owner", color: "#abcdef" })
      .returning()
      .get();
    const project = ctx.handle.db
      .insert(schema.workItems)
      .values({
        role: "story",
        title: "Nested action project",
        status: "active",
        ownerMemberId: member.id,
      })
      .returning()
      .get();
    const parent = ctx.handle.db
      .insert(schema.workItems)
      .values({
        role: "task",
        parentId: project.id,
        title: "Large work",
        status: "active",
        size: "XL",
      })
      .returning()
      .get();
    const reference = ctx.handle.db
      .insert(schema.workItems)
      .values({
        role: "task",
        parentId: parent.id,
        title: "Reference",
        status: "captured",
        taskKind: "reference",
      })
      .returning()
      .get();
    ctx.handle.db
      .insert(schema.workItems)
      .values({
        role: "task",
        parentId: reference.id,
        title: "Open action",
        status: "active",
      })
      .run();

    expect(
      reviewItems().some(
        (item) =>
          item.entityId === parent.id && item.reason === "xl_without_children",
      ),
    ).toBe(false);
  });

  it("preserves XL-without-children review for a done action child", () => {
    const member = ctx.handle.db
      .insert(schema.members)
      .values({ name: "XL done owner", color: "#abcdef" })
      .returning()
      .get();
    const project = ctx.handle.db
      .insert(schema.workItems)
      .values({
        role: "story",
        title: "Done child project",
        status: "active",
        ownerMemberId: member.id,
      })
      .returning()
      .get();
    const parent = ctx.handle.db
      .insert(schema.workItems)
      .values({
        role: "task",
        parentId: project.id,
        title: "Large work",
        status: "active",
        size: "XL",
      })
      .returning()
      .get();
    ctx.handle.db
      .insert(schema.workItems)
      .values({
        role: "task",
        parentId: parent.id,
        title: "Done action",
        status: "done",
      })
      .run();

    expect(
      reviewItems().some(
        (item) =>
          item.entityId === parent.id && item.reason === "xl_without_children",
      ),
    ).toBe(true);
  });

  it("acknowledges project and task review revision-safely without touching updatedAt or awarding points", async () => {
    const project = ctx.handle.db
      .insert(schema.workItems)
      .values({ role: "story", status: "backlog", title: "Review project" })
      .returning()
      .get();
    const task = ctx.handle.db
      .insert(schema.workItems)
      .values({ role: "task", title: "Review task", status: "backlog" })
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

  it("rejects acknowledging review on reference material through the action guard", async () => {
    const reference = ctx.handle.db
      .insert(schema.workItems)
      .values({
        role: "task",
        taskKind: "reference",
        title: "Reference material",
        status: "captured",
      })
      .returning()
      .get();

    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${reference.id}/review`,
      payload: { expectedRevision: reference.revision },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({
      code: "reference_action_not_allowed",
      details: { taskId: reference.id, operation: "acknowledgeTaskReview" },
    });
    expect(
      ctx.handle.db
        .select({ reviewedAt: schema.workItems.reviewedAt })
        .from(schema.workItems)
        .where(eq(schema.workItems.id, reference.id))
        .get(),
    ).toEqual({ reviewedAt: null });
  });

  it("returns the same derived queue and count from review endpoints", async () => {
    const project = ctx.handle.db
      .insert(schema.workItems)
      .values({ role: "story", status: "backlog", title: "Old backlog" })
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
      .insert(schema.workItems)
      .values({ role: "story",
        title: "Zulu project",
        status: "active",
        ownerMemberId: member.id,
      })
      .returning()
      .get();
    const alphaProject = ctx.handle.db
      .insert(schema.workItems)
      .values({ role: "story",
        title: "Alpha project",
        status: "active",
        ownerMemberId: member.id,
      })
      .returning()
      .get();
    const zuluProjectTask = ctx.handle.db
      .insert(schema.workItems)
      .values({ role: "task", status: "active", parentId: zuluProject.id, title: "Alpha entity" })
      .returning()
      .get();
    const alphaProjectTask = ctx.handle.db
      .insert(schema.workItems)
      .values({ role: "task", status: "active", parentId: alphaProject.id, title: "Zulu entity" })
      .returning()
      .get();
    const duplicateFirst = ctx.handle.db
      .insert(schema.workItems)
      .values({ role: "task", status: "active", parentId: alphaProject.id, title: "Duplicate entity" })
      .returning()
      .get();
    const duplicateSecond = ctx.handle.db
      .insert(schema.workItems)
      .values({ role: "task", status: "active", parentId: alphaProject.id, title: "Duplicate entity" })
      .returning()
      .get();
    const standalone = ctx.handle.db
      .insert(schema.workItems)
      .values({ role: "task", status: "active", title: "A standalone entity" })
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

  it("flags a backlog project that already carries actionable open work, not merely scheduled/due dates", () => {
    const actionableWork = ctx.handle.db
      .insert(schema.workItems)
      .values({ role: "story", status: "backlog", title: "Backlog with actionable work" })
      .returning()
      .get();
    ctx.handle.db
      .insert(schema.workItems)
      .values({ role: "task", status: "active", parentId: actionableWork.id, title: "Do now" })
      .run();

    // Backlog dates are intentional planning/constraint signals (Week already
    // surfaces them) and must not by themselves flag repair debt.
    const scheduledWork = ctx.handle.db
      .insert(schema.workItems)
      .values({ role: "story", status: "backlog", title: "Backlog with scheduled task" })
      .returning()
      .get();
    ctx.handle.db
      .insert(schema.workItems)
      .values({
        role: "task",
        status: "backlog",
        parentId: scheduledWork.id,
        title: "Scheduled anyway",
        scheduledDate: today,
      })
      .run();

    const dueWork = ctx.handle.db
      .insert(schema.workItems)
      .values({ role: "story", status: "backlog", title: "Backlog with due task" })
      .returning()
      .get();
    ctx.handle.db
      .insert(schema.workItems)
      .values({
        role: "task",
        status: "backlog",
        parentId: dueWork.id,
        title: "Due anyway",
        dueDate: today,
      })
      .run();

    const cleanBacklog = ctx.handle.db
      .insert(schema.workItems)
      .values({ role: "story", status: "backlog", title: "Genuinely dormant backlog" })
      .returning()
      .get();
    ctx.handle.db
      .insert(schema.workItems)
      .values({ role: "task", status: "backlog", parentId: cleanBacklog.id, title: "Someday" })
      .run();

    const flagged = reviewItems().filter(
      (item) => item.reason === "backlog_planned_work",
    );
    expect(flagged.map((item) => item.entityId)).toEqual([actionableWork.id]);
    expect(flagged.some((item) => item.entityId === scheduledWork.id)).toBe(false);
    expect(flagged.some((item) => item.entityId === dueWork.id)).toBe(false);
    expect(flagged.some((item) => item.entityId === cleanBacklog.id)).toBe(false);
  });

  it("flags a task scheduled or due before its project's resurface date", () => {
    const project = ctx.handle.db
      .insert(schema.workItems)
      .values({
        role: "story",
        status: "backlog",
        title: "Deferred project",
        revisitAt: "2026-09-20T00:00:00.000Z",
      })
      .returning()
      .get();
    const scheduledTooEarly = ctx.handle.db
      .insert(schema.workItems)
      .values({
        role: "task",
        status: "backlog",
        parentId: project.id,
        title: "Planned too early",
        scheduledDate: "2026-09-10",
      })
      .returning()
      .get();
    const dueTooEarly = ctx.handle.db
      .insert(schema.workItems)
      .values({
        role: "task",
        status: "backlog",
        parentId: project.id,
        title: "Due too early",
        dueDate: "2026-09-15",
      })
      .returning()
      .get();
    const consistentTask = ctx.handle.db
      .insert(schema.workItems)
      .values({
        role: "task",
        status: "backlog",
        parentId: project.id,
        title: "Planned after resurface",
        scheduledDate: "2026-09-25",
      })
      .returning()
      .get();

    const items = reviewItems();
    expect(
      items.some(
        (item) =>
          item.entityId === scheduledTooEarly.id &&
          item.reason === "task_scheduled_before_resurface",
      ),
    ).toBe(true);
    expect(
      items.some(
        (item) =>
          item.entityId === dueTooEarly.id &&
          item.reason === "task_due_before_resurface",
      ),
    ).toBe(true);
    expect(
      items.some(
        (item) =>
          item.entityId === consistentTask.id &&
          (item.reason === "task_scheduled_before_resurface" ||
            item.reason === "task_due_before_resurface"),
      ),
    ).toBe(false);
  });

  it("flags a project whose deadline is earlier than its own resurface date", () => {
    const inconsistent = ctx.handle.db
      .insert(schema.workItems)
      .values({
        role: "story",
        status: "backlog",
        title: "Contradictory dates",
        revisitAt: "2026-09-20T00:00:00.000Z",
        dueDate: "2026-09-10",
      })
      .returning()
      .get();
    const consistent = ctx.handle.db
      .insert(schema.workItems)
      .values({
        role: "story",
        status: "backlog",
        title: "Consistent dates",
        revisitAt: "2026-09-10T00:00:00.000Z",
        dueDate: "2026-09-20",
      })
      .returning()
      .get();

    const items = reviewItems();
    expect(
      items.some(
        (item) =>
          item.entityId === inconsistent.id &&
          item.reason === "project_due_before_resurface",
      ),
    ).toBe(true);
    expect(
      items.some(
        (item) =>
          item.entityId === consistent.id &&
          item.reason === "project_due_before_resurface",
      ),
    ).toBe(false);
  });

  it("flags a completed or archived project that still has open work, but not one that is fully done", () => {
    const completedWithOpenWork = ctx.handle.db
      .insert(schema.workItems)
      .values({ role: "story", status: "done", title: "Completed but not really" })
      .returning()
      .get();
    ctx.handle.db
      .insert(schema.workItems)
      .values({
        role: "task",
        status: "active",
        parentId: completedWithOpenWork.id,
        title: "Still open",
        scheduledDate: today,
      })
      .run();

    const archivedWithOpenWork = ctx.handle.db
      .insert(schema.workItems)
      .values({
        role: "story",
        status: "backlog",
        archivedAt: `${today}T10:00:00.000Z`,
        title: "Archived but not really",
      })
      .returning()
      .get();
    ctx.handle.db
      .insert(schema.workItems)
      .values({ role: "task", status: "active", parentId: archivedWithOpenWork.id, title: "Still open too" })
      .run();

    const genuinelyCompleted = ctx.handle.db
      .insert(schema.workItems)
      .values({ role: "story", status: "done", title: "Actually done" })
      .returning()
      .get();
    ctx.handle.db
      .insert(schema.workItems)
      .values({ role: "task", status: "done", parentId: genuinelyCompleted.id, title: "Finished" })
      .run();

    const flagged = reviewItems().filter(
      (item) => item.reason === "completed_project_open_work",
    );
    expect(flagged.map((item) => item.entityId).sort()).toEqual(
      [completedWithOpenWork.id, archivedWithOpenWork.id].sort(),
    );
    expect(
      flagged.some((item) => item.entityId === genuinelyCompleted.id),
    ).toBe(false);
  });
});
