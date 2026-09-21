import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACTIVITY_ACTOR_HEADER } from "@machbar/shared";
import { Graph } from "../src/domain/graph.js";
import * as schema from "../src/db/schema.js";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

/** Recursively searches an arbitrary JSON response for `{ id: <id> }`. Used
 * to assert a reference is absent from a projection regardless of exactly
 * how deeply nested/grouped the response shape is. */
function containsTaskId(value: unknown, id: number): boolean {
  if (Array.isArray(value)) return value.some((v) => containsTaskId(v, id));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.id === id && "title" in record) return true;
    return Object.values(record).some((v) => containsTaskId(v, id));
  }
  return false;
}

describe("task kind (reference/material nodes)", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await closeTestContext(ctx);
  });

  async function createProject(payload: Record<string, unknown> = {}) {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { title: "Project", ...payload },
    });
    expect(res.statusCode).toBe(201);
    const project = res.json();
    ctx.handle.sqlite
      .prepare("UPDATE work_items SET status = 'active' WHERE id = ?")
      .run(project.id);
    return project;
  }

  async function createTask(payload: Record<string, unknown>) {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { status: "actionable", ...payload },
    });
    return res;
  }

  async function createReference(payload: Record<string, unknown>) {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { kind: "reference", ...payload },
    });
    return res;
  }

  function graph() {
    return Graph.load(ctx.handle.db, "2026-08-31");
  }

  it("new tasks default to kind=action", async () => {
    const project = await createProject();
    const res = await createTask({ title: "Do it", projectId: project.id });
    expect(res.statusCode).toBe(201);
    expect(res.json().kind).toBe("action");
  });

  it("rejects task-only fields when creating a reference", async () => {
    const project = await createProject();
    const res = await createReference({
      title: "Camping Wang",
      projectId: project.id,
      dueDate: "2026-09-01",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("reference_field_not_allowed");
  });

  it("allows references nested under project/action/reference, and actions under references", async () => {
    const project = await createProject();
    const topRef = await createReference({
      title: "Unterkunft",
      projectId: project.id,
    });
    expect(topRef.statusCode).toBe(201);
    expect(topRef.json().kind).toBe("reference");

    const nestedRef = await createReference({
      title: "Hotels",
      parentTaskId: topRef.json().id,
    });
    expect(nestedRef.statusCode).toBe(201);

    const actionUnderRef = await createTask({
      title: "Hotel buchen",
      parentTaskId: nestedRef.json().id,
    });
    expect(actionUnderRef.statusCode).toBe(201);
    expect(actionUnderRef.json().kind).toBe("action");

    const actionUnderProject = await createTask({
      title: "Packliste schreiben",
      projectId: project.id,
    });
    expect(actionUnderProject.statusCode).toBe(201);

    const refUnderAction = await createReference({
      title: "Notiz",
      parentTaskId: actionUnderProject.json().id,
    });
    expect(refUnderAction.statusCode).toBe(201);
  });

  it("an action is not selected as next action if its only child is a reference containing an open action", async () => {
    const project = await createProject();
    const parentAction = await createTask({
      title: "Reise organisieren",
      projectId: project.id,
    });
    const ref = await createReference({
      title: "Unterkunft",
      parentTaskId: parentAction.json().id,
    });
    const childAction = await createTask({
      title: "Ferienwohnung buchen",
      parentTaskId: ref.json().id,
    });

    const g = graph();
    const candidateIds = g
      .nextActionCandidatesFor(project.id)
      .map((t) => t.id);
    expect(candidateIds).not.toContain(parentAction.json().id);
    expect(candidateIds).toContain(childAction.json().id);
  });

  it("an action nested two reference containers deep is still a valid next-action candidate", async () => {
    const project = await createProject();
    const outerRef = await createReference({
      title: "Outer reference",
      projectId: project.id,
    });
    const innerRef = await createReference({
      title: "Inner reference",
      parentTaskId: outerRef.json().id,
    });
    const action = await createTask({
      title: "Deep action",
      parentTaskId: innerRef.json().id,
    });

    const g = graph();
    const candidateIds = g
      .nextActionCandidatesFor(project.id)
      .map((t) => t.id);
    expect(candidateIds).toContain(action.json().id);
    expect(g.nextActionFor(project.id)?.id).toBe(action.json().id);
  });

  it("a project containing only references is not activation-ready / has no next action", async () => {
    const project = await createProject();
    await createReference({ title: "Just material", projectId: project.id });
    await createReference({ title: "More material", projectId: project.id });

    const g = graph();
    expect(g.nextActionFor(project.id)).toBeNull();
    const computed = g.projectWithComputed(project.id);
    expect(computed?.stuckReason).toBe("no_next_action");
  });

  it("references do not count toward project openCount/doneCount", async () => {
    const project = await createProject();
    const action = await createTask({ title: "Do it", projectId: project.id });
    await createReference({ title: "Material", projectId: project.id });

    const g = graph();
    const computed = g.projectWithComputed(project.id);
    expect(computed?.openCount).toBe(1);
    expect(computed?.doneCount).toBe(0);
    expect(action.statusCode).toBe(201);
  });

  it("completes an action with only a reference descendant without a descendants policy prompt", async () => {
    const project = await createProject();
    const action = await createTask({
      title: "Zug buchen",
      projectId: project.id,
    });
    await createReference({
      title: "Fahrplan",
      parentTaskId: action.json().id,
    });

    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${action.json().id}/complete`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("done");
  });

  it("still requires the descendants policy when an open action hides beneath a reference container", async () => {
    const project = await createProject();
    const action = await createTask({
      title: "Urlaub organisieren",
      projectId: project.id,
    });
    const ref = await createReference({
      title: "Unterkunft",
      parentTaskId: action.json().id,
    });
    await createTask({
      title: "Hotel buchen",
      parentTaskId: ref.json().id,
    });

    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${action.json().id}/complete`,
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("descendants_policy_required");

    const withPolicy = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${action.json().id}/complete`,
      payload: { descendantsPolicy: "complete_children" },
    });
    expect(withPolicy.statusCode).toBe(200);

    // The reference itself must never be mutated by the cascade.
    const refAfter = await ctx.app.inject({
      method: "GET",
      url: `/api/tasks/${ref.json().id}`,
    });
    expect(refAfter.json().status).not.toBe("done");
    expect(refAfter.json().status).not.toBe("cancelled");
  });

  it("rejects lifecycle transitions on a reference", async () => {
    const project = await createProject();
    const ref = await createReference({
      title: "Material",
      projectId: project.id,
    });
    const refId = ref.json().id;

    const complete = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${refId}/complete`,
      payload: {},
    });
    expect(complete.statusCode).toBe(409);
    expect(complete.json().error.code).toBe("reference_action_not_allowed");

    const cancel = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${refId}/cancel`,
      payload: {},
    });
    expect(cancel.statusCode).toBe(409);
    expect(cancel.json().error.code).toBe("reference_action_not_allowed");

    const reopen = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${refId}/reopen`,
      payload: {},
    });
    expect(reopen.statusCode).toBe(409);
    expect(reopen.json().error.code).toBe("reference_action_not_allowed");
  });

  it("rejects task-only metadata via PATCH on a reference", async () => {
    const project = await createProject();
    const ref = await createReference({
      title: "Material",
      projectId: project.id,
    });
    const res = await ctx.app.inject({
      method: "PATCH",
      url: `/api/tasks/${ref.json().id}`,
      payload: { priority: 1 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("reference_field_not_allowed");
  });

  it("rejects dependencies involving a reference on either side", async () => {
    const project = await createProject();
    const action = await createTask({ title: "Do it", projectId: project.id });
    const otherAction = await createTask({
      title: "Do it too",
      projectId: project.id,
    });
    const ref = await createReference({
      title: "Material",
      projectId: project.id,
    });

    const refDependsOnAction = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${ref.json().id}/dependencies`,
      payload: { dependsOnTaskId: action.json().id },
    });
    expect(refDependsOnAction.statusCode).toBe(409);
    expect(refDependsOnAction.json().error.code).toBe(
      "reference_dependency_not_allowed",
    );

    const actionDependsOnRef = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${otherAction.json().id}/dependencies`,
      payload: { dependsOnTaskId: ref.json().id },
    });
    expect(actionDependsOnRef.statusCode).toBe(409);
    expect(actionDependsOnRef.json().error.code).toBe(
      "reference_dependency_not_allowed",
    );
  });

  it("references never appear in Today/Week/Waiting/Inbox/Review/Refinement", async () => {
    const project = await createProject();
    const ref = await createReference({
      title: "A Reference That Must Stay Invisible",
      projectId: project.id,
    });
    const refId = ref.json().id;

    const today = await ctx.app.inject({ method: "GET", url: "/api/agenda/today" });
    expect(today.statusCode).toBe(200);
    expect(containsTaskId(today.json(), refId)).toBe(false);

    const week = await ctx.app.inject({
      method: "GET",
      url: "/api/agenda/week?start=2026-08-31",
    });
    expect(week.statusCode).toBe(200);
    expect(containsTaskId(week.json(), refId)).toBe(false);

    const waiting = await ctx.app.inject({ method: "GET", url: "/api/waiting" });
    expect(waiting.statusCode).toBe(200);
    expect(containsTaskId(waiting.json(), refId)).toBe(false);

    const inbox = await ctx.app.inject({ method: "GET", url: "/api/inbox" });
    expect(inbox.statusCode).toBe(200);
    expect(containsTaskId(inbox.json(), refId)).toBe(false);

    const review = await ctx.app.inject({ method: "GET", url: "/api/review" });
    expect(review.statusCode).toBe(200);
    expect(containsTaskId(review.json(), refId)).toBe(false);

    const refinement = await ctx.app.inject({
      method: "GET",
      url: "/api/refinement/tasks",
    });
    expect(refinement.statusCode).toBe(200);
    expect(containsTaskId(refinement.json(), refId)).toBe(false);
  });

  it("defensively excludes a reference from Today/Week/Waiting even if its status/dates were corrupted directly in storage", async () => {
    // Simulates data that bypassed the application-level guards (e.g. a
    // manual/legacy write), verifying the kind-based filters added to each
    // projection are a real second line of defense, not merely redundant
    // with the status-based guards.
    const project = await createProject();
    const ref = await createReference({
      title: "Corrupted Reference",
      projectId: project.id,
    });
    const refId = ref.json().id;
    ctx.handle.sqlite
      .prepare(
        "UPDATE work_items SET status = 'active', scheduled_date = '2026-08-31' WHERE id = ?",
      )
      .run(refId);
    ctx.handle.sqlite
      .prepare(
        "INSERT INTO task_external_waits (task_id, waiting_for, revisit_date) VALUES (?, 'x', '2026-08-31')",
      )
      .run(refId);

    const today = await ctx.app.inject({ method: "GET", url: "/api/agenda/today" });
    expect(containsTaskId(today.json(), refId)).toBe(false);

    const week = await ctx.app.inject({
      method: "GET",
      url: "/api/agenda/week?start=2026-08-31",
    });
    expect(containsTaskId(week.json(), refId)).toBe(false);

    const waiting = await ctx.app.inject({ method: "GET", url: "/api/waiting" });
    expect(containsTaskId(waiting.json(), refId)).toBe(false);
  });

  it("finds a reference by title, note text, and URL in search", async () => {
    const project = await createProject();
    await createReference({
      title: "Camping Wang",
      notes: "https://camping-wang.ch/ Direkt am See",
      projectId: project.id,
    });

    const g = graph();
    const { searchTasks } = await import("../src/domain/search.js");
    const both = searchTasks(g, { text: "Camping Wang" });
    expect(both.some((t) => t.title === "Camping Wang")).toBe(true);

    const byUrl = searchTasks(g, { text: "camping-wang" });
    expect(byUrl.some((t) => t.title === "Camping Wang")).toBe(true);

    const actionsOnly = searchTasks(g, { text: "Camping Wang", kinds: ["action"] });
    expect(actionsOnly.some((t) => t.title === "Camping Wang")).toBe(false);
  });

  describe("make-action promotion", () => {
    it("preserves id/title/notes/parent/project/position/children and switches to a normal actionable task", async () => {
      const project = await createProject();
      const refRes = await createReference({
        title: "Unterkunft",
        notes: "https://example.com/ notes here",
        projectId: project.id,
      });
      const ref = refRes.json();
      const childRes = await createReference({
        title: "Hotels",
        projectId: project.id,
        parentTaskId: ref.id,
      });
      const child = childRes.json();
      // Paperless attachments live in `notes` as markdown references, not a
      // separate table (per the feature's scope discipline) — simulate one
      // via a PATCH.
      await ctx.app.inject({
        method: "PATCH",
        url: `/api/tasks/${ref.id}`,
        payload: {
          notes: `${ref.notes}\n\npaperless:99`,
          expectedRevision: ref.revision,
        },
      });

      const promote = await ctx.app.inject({
        method: "POST",
        url: `/api/tasks/${ref.id}/make-action`,
        payload: {},
      });
      expect(promote.statusCode).toBe(200);
      const promoted = promote.json();
      expect(promoted.id).toBe(ref.id);
      expect(promoted.title).toBe("Unterkunft");
      expect(promoted.notes).toContain("paperless:99");
      expect(promoted.notes).toContain("https://example.com/");
      expect(promoted.projectId).toBe(project.id);
      expect(promoted.parentTaskId).toBeNull();
      expect(promoted.kind).toBe("action");
      expect(promoted.status).toBe("actionable");

      const g = graph();
      const projectTasks = g.tasksForProject(project.id);
      const childInTree = projectTasks.find((t) => t.id === child.id);
      expect(childInTree).toBeTruthy();
      expect(childInTree?.parentTaskId).toBe(ref.id);
    });

    it("rejects promotion when task.kind is already action", async () => {
      const action = await createTask({ title: "Real task" });
      const actionBody = action.json();
      const promote = await ctx.app.inject({
        method: "POST",
        url: `/api/tasks/${actionBody.id}/make-action`,
        payload: {},
      });
      expect(promote.statusCode).toBe(409);
    });

    it("records a project_next_action_added contribution only when promotion creates the first next action", async () => {
      const project = await createProject();
      const refRes = await createReference({ title: "Only ref", projectId: project.id });
      const ref = refRes.json();
      const member = ctx.handle.db
        .insert(schema.members)
        .values({ name: "Mira", color: "#123456" })
        .returning()
        .get();

      const before = ctx.handle.sqlite
        .prepare(
          "SELECT COUNT(*) as c FROM contribution_events WHERE reason = 'project_next_action_added' AND entity_id = ?",
        )
        .get(project.id) as { c: number };
      expect(before.c).toBe(0);

      await ctx.app.inject({
        method: "POST",
        url: `/api/tasks/${ref.id}/make-action`,
        payload: {},
        headers: { [ACTIVITY_ACTOR_HEADER]: String(member.id) },
      });

      const after = ctx.handle.sqlite
        .prepare(
          "SELECT COUNT(*) as c FROM contribution_events WHERE reason = 'project_next_action_added' AND entity_id = ?",
        )
        .get(project.id) as { c: number };
      expect(after.c).toBe(1);
    });

    it("does not record a second next-action contribution when a next action already exists", async () => {
      const project = await createProject();
      await createTask({ title: "Existing action", projectId: project.id });
      const refRes = await createReference({ title: "Extra ref", projectId: project.id });
      const ref = refRes.json();
      const member = ctx.handle.db
        .insert(schema.members)
        .values({ name: "Mira", color: "#123456" })
        .returning()
        .get();

      const before = ctx.handle.sqlite
        .prepare(
          "SELECT COUNT(*) as c FROM contribution_events WHERE reason = 'project_next_action_added' AND entity_id = ?",
        )
        .get(project.id) as { c: number };

      await ctx.app.inject({
        method: "POST",
        url: `/api/tasks/${ref.id}/make-action`,
        payload: {},
        headers: { [ACTIVITY_ACTOR_HEADER]: String(member.id) },
      });

      const after = ctx.handle.sqlite
        .prepare(
          "SELECT COUNT(*) as c FROM contribution_events WHERE reason = 'project_next_action_added' AND entity_id = ?",
        )
        .get(project.id) as { c: number };
      expect(after.c).toBe(before.c);
    });
  });
});
