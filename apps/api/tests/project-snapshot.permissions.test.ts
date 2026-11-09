import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTIVITY_ACTOR_HEADER } from "@machbar/shared";
import { eq } from "drizzle-orm";
import { ChangeNotifier } from "../src/changeNotifier.js";
import { createProject } from "../src/domain/storyCrud.js";
import { createTask } from "../src/domain/taskCrud.js";
import * as schema from "../src/db/schema.js";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

const cases = [true, false].flatMap(ancestorVisible => ["read", "stale-deadline", "fresh-deadline"].map(operation => ({ ancestorVisible, operation })));

describe("project activation snapshot visibility at every public exit", () => {
  let ctx: TestContext;
  afterEach(async () => closeTestContext(ctx));
  it.each(cases)("$operation with ancestor visible: $ancestorVisible", async ({ ancestorVisible, operation }) => {
    const notifier = new ChangeNotifier();
    const notified = vi.fn(); notifier.subscribe(notified);
    ctx = createTestContext({ changeNotifier: notifier });
    const member = (name: string) => ctx.handle.db.insert(schema.members).values({ name, color: "#111111" }).returning().get();
    const viewer = member("Viewer"), other = member("Other");
    const ancestor = createProject(ctx.handle.db, { title: "Ancestor-only confidential title", scope: "work", ownerMemberId: ancestorVisible ? viewer.id : other.id });
    const source = createProject(ctx.handle.db, { title: "Viewer-owned child", parentId: ancestor.id, ownerMemberId: viewer.id });
    const before = createHash("sha256").update(ctx.handle.sqlite.serialize()).digest("hex");
    notified.mockClear();
    const headers = { [ACTIVITY_ACTOR_HEADER]: String(viewer.id) };
    const response = await ctx.app.inject(operation === "read"
      ? { method: "GET", url: `/api/projects/${source.id}`, headers }
      : { method: "PATCH", url: `/api/projects/${source.id}`, headers, payload: { dueDate: "2027-01-15", expectedRevision: source.revision + (operation === "stale-deadline" ? 5 : 0) } });
    expect(response.statusCode, response.body).toBe(operation === "read" ? 200 : ancestorVisible ? 409 : 404);
    if (!ancestorVisible) expect(response.body).not.toContain(ancestor.title);
    if (operation === "read") {
      if (ancestorVisible) expect(response.json().activationDecisionSnapshot.expectedProjects).toEqual(expect.arrayContaining([{ projectId: ancestor.id, revision: ancestor.revision }]));
      else expect(response.json()).not.toHaveProperty("activationDecisionSnapshot");
      expect(response.json().directActivationDecisionSnapshot.expectedProjects).toEqual([{ projectId: source.id, revision: source.revision }]);
    } else if (ancestorVisible) {
      expect(response.json().error.code).toBe("project_commitment_resolution_required");
      expect(response.json().error.details.expectedProjects).toEqual(expect.arrayContaining([{ projectId: ancestor.id, revision: ancestor.revision }]));
    }
    expect(createHash("sha256").update(ctx.handle.sqlite.serialize()).digest("hex")).toBe(before);
    expect(notified).not.toHaveBeenCalled();
  });
});

describe("viewer-aware project next actions", () => {
  let ctx: TestContext;
  afterEach(async () => closeTestContext(ctx));

  it.each(["work", "private"] as const)(
    "skips a visible task blocked by a hidden terminal prerequisite for %s",
    async (scope) => {
      const notifier = new ChangeNotifier();
      const notified = vi.fn();
      notifier.subscribe(notified);
      ctx = createTestContext({ changeNotifier: notifier });
      const member = (name: string) =>
        ctx.handle.db
          .insert(schema.members)
          .values({ name, color: "#111111" })
          .returning()
          .get();
      const owner = member("Private owner");
      const other = member("Other viewer");
      const project = createProject(ctx.handle.db, {
        title: "Shared project",
      });
      const hiddenPrerequisite = createTask(ctx.handle.db, {
        title: "Confidential prerequisite",
        status: "done",
        ...(scope === "work"
          ? {
              scope: "work",
              ownerMemberId: owner.id,
              ownerInheritanceMode: "explicit" as const,
            }
          : { scope: "household", privacyOwnerMemberId: owner.id }),
      });
      const dependent = createTask(ctx.handle.db, {
        title: "First shared action",
        projectId: project.id,
      });
      const fallback = createTask(ctx.handle.db, {
        title: "Later executable action",
        projectId: project.id,
      });
      const readinessProject = createProject(ctx.handle.db, {
        title: "Project with only hidden prerequisite work",
      });
      const readinessDependent = createTask(ctx.handle.db, {
        title: "Action blocked by private work",
        projectId: readinessProject.id,
      });
      ctx.handle.db
        .insert(schema.taskDependencies)
        .values([
          {
            taskId: dependent.id,
            dependsOnTaskId: hiddenPrerequisite.id,
          },
          {
            taskId: readinessDependent.id,
            dependsOnTaskId: hiddenPrerequisite.id,
          },
        ])
        .run();

      const before = createHash("sha256")
        .update(ctx.handle.sqlite.serialize())
        .digest("hex");
      notified.mockClear();
      for (const viewer of [
        {
          headers: { [ACTIVITY_ACTOR_HEADER]: String(owner.id) },
          expected: dependent,
          canSeePrerequisite: true,
        },
        {
          headers: { [ACTIVITY_ACTOR_HEADER]: String(other.id) },
          expected: fallback,
          canSeePrerequisite: false,
        },
        { headers: {}, expected: fallback, canSeePrerequisite: false },
      ]) {
        const response = await ctx.app.inject({
          method: "GET",
          url: `/api/projects/${project.id}`,
          headers: viewer.headers,
        });
        expect(response.statusCode, response.body).toBe(200);
        const body = response.json();
        expect(body.nextAction).toMatchObject({
          id: viewer.expected.id,
          title: viewer.expected.title,
        });
        const dependentInTree = body.tasks.find(
          (task: { id: number }) => task.id === dependent.id,
        );
        if (!viewer.canSeePrerequisite) {
          expect(response.body).not.toContain(hiddenPrerequisite.title);
          expect(dependentInTree.dependencies).not.toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                dependsOnTaskId: hiddenPrerequisite.id,
              }),
            ]),
          );
          expect(dependentInTree.blockers).not.toEqual(
            expect.arrayContaining([
              expect.objectContaining({ taskId: hiddenPrerequisite.id }),
            ]),
          );
          expect(dependentInTree.blocked).toBe(true);
          expect(dependentInTree.executable).toBe(false);
        } else {
          expect(dependentInTree.dependencies).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                dependsOnTaskId: hiddenPrerequisite.id,
                title: hiddenPrerequisite.title,
                resolved: true,
              }),
            ]),
          );
          expect(dependentInTree.blocked).toBe(false);
          expect(dependentInTree.executable).toBe(true);
        }
        expect(
          createHash("sha256")
            .update(ctx.handle.sqlite.serialize())
            .digest("hex"),
        ).toBe(before);
        expect(notified).not.toHaveBeenCalled();

        const readinessResponse = await ctx.app.inject({
          method: "GET",
          url: `/api/projects/${readinessProject.id}`,
          headers: viewer.headers,
        });
        expect(readinessResponse.statusCode, readinessResponse.body).toBe(200);
        const readinessBody = readinessResponse.json();
        expect(readinessBody.activationReadiness.hasViableProgressPath).toBe(
          viewer.canSeePrerequisite,
        );
        expect(readinessBody.nextAction?.id ?? null).toBe(
          viewer.canSeePrerequisite ? readinessDependent.id : null,
        );
        const readinessTaskInTree = readinessBody.tasks.find(
          (task: { id: number }) => task.id === readinessDependent.id,
        );
        if (!viewer.canSeePrerequisite) {
          expect(readinessResponse.body).not.toContain(
            hiddenPrerequisite.title,
          );
          expect(readinessTaskInTree.dependencies).not.toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                dependsOnTaskId: hiddenPrerequisite.id,
              }),
            ]),
          );
          expect(readinessTaskInTree.blocked).toBe(true);
          expect(readinessTaskInTree.executable).toBe(false);
        }
        expect(
          createHash("sha256")
            .update(ctx.handle.sqlite.serialize())
            .digest("hex"),
        ).toBe(before);
        expect(notified).not.toHaveBeenCalled();
      }
    },
  );

  it("keeps reached ordinary revisits available and future pauses deferred", async () => {
    ctx = createTestContext();
    const reachedProject = createProject(ctx.handle.db, {
      title: "Reached revisit project",
    });
    const reachedAt = "2020-01-01T12:00:00.000Z";
    const reached = createTask(ctx.handle.db, {
      title: "Reached ordinary revisit",
      projectId: reachedProject.id,
      revisitAt: reachedAt,
    });
    createTask(ctx.handle.db, {
      title: "Later executable action",
      projectId: reachedProject.id,
    });

    const reachedResponse = await ctx.app.inject({
      method: "GET",
      url: `/api/projects/${reachedProject.id}`,
    });
    expect(reachedResponse.statusCode, reachedResponse.body).toBe(200);
    expect(reachedResponse.json().nextAction).toMatchObject({
      id: reached.id,
      title: reached.title,
      revisitAt: reachedAt,
      blocked: false,
      executable: false,
    });
    expect(
      ctx.handle.db
        .select({ revisitAt: schema.workItems.revisitAt })
        .from(schema.workItems)
        .where(eq(schema.workItems.id, reached.id))
        .get()?.revisitAt,
    ).toBe(reachedAt);

    const pausedProject = createProject(ctx.handle.db, {
      title: "Future pause project",
    });
    const futurePause = createTask(ctx.handle.db, {
      title: "Future pause",
      projectId: pausedProject.id,
      revisitAt: "2099-01-01T12:00:00.000Z",
    });
    const available = createTask(ctx.handle.db, {
      title: "Available action",
      projectId: pausedProject.id,
    });
    const pausedResponse = await ctx.app.inject({
      method: "GET",
      url: `/api/projects/${pausedProject.id}`,
    });
    expect(pausedResponse.statusCode, pausedResponse.body).toBe(200);
    expect(pausedResponse.json().nextAction?.id).toBe(available.id);
    expect(pausedResponse.json().deferredNextAction).toMatchObject({
      id: futurePause.id,
      title: futurePause.title,
    });
  });
});
