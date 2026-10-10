import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { IntakeDraft, IntakeDraftWorkItem } from "@machbar/shared";
import * as schema from "../src/db/schema.js";
import { createChildTask, createTask, getTaskOrThrow, updateTask } from "../src/domain/taskCrud.js";
import { createProject } from "../src/domain/storyCrud.js";
import { applyIntake } from "../src/intake/apply.js";
import { assertBreakdownDraft, breakdownSnapshot, breakdownTask } from "../src/intake/breakdown.js";
import { getIntake, onIntakeAnalyzed } from "../src/intake/jobs.js";
import { HomeAssistantRequestSignal } from "../src/integrations/homeAssistantRequests.js";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

function item(key: string, parentKey: string | null, title: string): IntakeDraftWorkItem {
  return {
    key, parentKey, title, kind: "action", notes: null, enabled: true,
    ownerMemberId: null, dueDate: null, scheduledDate: null,
    revisitAt: null, notBeforeAt: null, notBeforeDate: null,
    reminders: [], needsClarification: false, relatedCalendarKeys: [],
  };
}

describe("reviewed task breakdown", () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = createTestContext(); });
  afterEach(async () => { await closeTestContext(ctx); });

  function prepare(taskId: number, convert = false) {
    const task = getTaskOrThrow(ctx.handle.db, taskId);
    const root = { ...item("existing-task", null, task.title), notes: task.notes,
      kind: convert ? "project" as const : "action" as const };
    const draft: IntakeDraft = {
      summary: "Small steps", warnings: [], calendarEvents: [], retainSourceInPaperless: false,
      workItems: [root, item("compare", root.key, "Compare options"), item("book", root.key, "Book the chosen option")],
    };
    const id = randomUUID();
    ctx.handle.db.insert(schema.intakeJobs).values({
      id, status: "ready", revision: 1, scope: task.scope,
      breakdownTaskId: taskId, breakdownSnapshotJson: breakdownSnapshot(ctx.handle.db, taskId),
      breakdownInstruction: "Make small steps", draftJson: JSON.stringify(draft),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    }).run();
    return { id, draft };
  }

  const apply = (id: string, draft: IntakeDraft, revision = 1) =>
    applyIntake(ctx.handle.db, { dataDir: ctx.dataDir } as never, undefined,
      new HomeAssistantRequestSignal(), id, { expectedRevision: revision, draft }, {}, null);

  it("applies the enabled root instead of an excluded duplicate", async () => {
    const task = createTask(ctx.handle.db, { title: "Room", status: "actionable" });
    const { id, draft } = prepare(task.id);
    draft.workItems[0]!.title = "Reviewed room";
    draft.workItems.unshift({ ...item("existing-task", null, "Excluded title"), enabled: false, kind: "project" });
    await apply(id, draft);
    expect(getTaskOrThrow(ctx.handle.db, task.id).title).toBe("Reviewed room");
    expect(getTaskOrThrow(ctx.handle.db, task.id).children).toHaveLength(2);
  });

  it("accepts a useful proposal with no new children", async () => {
    const task = createTask(ctx.handle.db, { title: "Send the signed form", status: "actionable" });
    const { id, draft } = prepare(task.id);
    draft.workItems = [draft.workItems[0]!];
    await apply(id, draft);
    expect(getTaskOrThrow(ctx.handle.db, task.id).title).toBe(task.title);
    expect(getTaskOrThrow(ctx.handle.db, task.id).children).toHaveLength(0);
    expect(getIntake(ctx.handle.db, id, null).status).toBe("applied");
  });

  it.each(["recurring", "captured-child", "captured-in-project"])("rejects %s targets before creating an AI job", async (target) => {
    const parent = createTask(ctx.handle.db, { title: "Parent", status: "actionable" });
    const project = createProject(ctx.handle.db, { title: "Project" });
    const task = target === "captured-child"
      ? createChildTask(ctx.handle.db, parent.id, { title: "Child" })
      : createTask(ctx.handle.db, { title: "Target", status: "actionable",
          ...(target === "captured-in-project" ? { projectId: project.id } : {}) });
    ctx.handle.db.update(schema.workItems).set(target === "recurring"
      ? { repeatAfterDays: 7, allowedDeviationDays: 1 }
      : { status: "captured" }).where(eq(schema.workItems.id, task.id)).run();
    const response = await ctx.app.inject({
      method: "POST", url: `/api/intake/task/${task.id}`,
      payload: { expectedRevision: task.revision, instruction: "Make steps" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("task_promotion_invalid");
    expect(ctx.handle.db.select().from(schema.intakeJobs).all()).toHaveLength(0);
    expect(ctx.handle.db.select().from(schema.homeAssistantRequests).all()).toHaveLength(0);
  });

  it("appends only accepted steps in order and preserves the original identity, children, and metadata", async () => {
    const task = createTask(ctx.handle.db, {
      title: "Repair the room", notes: "Keep this context", status: "actionable", dueDate: "2027-01-01",
    });
    const existing = createChildTask(ctx.handle.db, task.id, { title: "Measure the room" });
    const { id, draft } = prepare(task.id);
    draft.workItems.push({ ...item("skip", "existing-task", "Do not create this"), enabled: false });
    await apply(id, draft);
    const updated = getTaskOrThrow(ctx.handle.db, task.id);
    expect(updated.title).toBe(task.title);
    expect(updated.notes).toBe(task.notes);
    expect(updated.dueDate).toBe(task.dueDate);
    expect(updated.children.map((child) => child.title)).toEqual([
      "Measure the room", "Compare options", "Book the chosen option",
    ]);
    expect(updated.children[0]!.id).toBe(existing.id);
    expect(getIntake(ctx.handle.db, id, null).applyResults!.work[0]!.workItemId).toBe(task.id);
    await expect(apply(id, draft, getIntake(ctx.handle.db, id, null).revision)).rejects.toMatchObject({
      code: "intake_state_conflict",
    });
    expect(getTaskOrThrow(ctx.handle.db, task.id).children).toHaveLength(3);
  });

  it("converts the original captured task into a backlog project and creates its reviewed steps atomically", async () => {
    const task = createTask(ctx.handle.db, { title: "Plan the holiday", notes: "Original context" });
    const { id, draft } = prepare(task.id, true);
    await apply(id, draft);
    const row = ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.id, task.id)).get()!;
    expect(row.role).toBe("story");
    expect(row.status).toBe("backlog");
    expect(row.notes).toBe(task.notes);
    const children = ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.parentId, task.id)).all();
    expect(children).toHaveLength(2);
    expect(getIntake(ctx.handle.db, id, null).status).toBe("applied");
  });

  it("rolls back a title edit if a captured task cannot accept children and leaves its proposal editable", async () => {
    const task = createTask(ctx.handle.db, { title: "Holiday" });
    const { id, draft } = prepare(task.id);
    draft.workItems[0]!.title = "Updated holiday";
    await expect(apply(id, draft)).rejects.toMatchObject({ code: "intake_draft_invalid" });
    expect(getTaskOrThrow(ctx.handle.db, task.id).title).toBe("Holiday");
    expect(getTaskOrThrow(ctx.handle.db, task.id).children).toHaveLength(0);
    expect(getIntake(ctx.handle.db, id, null).status).toBe("ready");
    draft.workItems[0]!.kind = "project";
    await apply(id, draft, getIntake(ctx.handle.db, id, null).revision);
    expect(getIntake(ctx.handle.db, id, null).status).toBe("applied");
  });

  it("rejects a proposal when an existing child was edited or another child was added", async () => {
    const task = createTask(ctx.handle.db, { title: "Room", status: "actionable" });
    const child = createChildTask(ctx.handle.db, task.id, { title: "Measure" });
    const { id, draft } = prepare(task.id);
    updateTask(ctx.handle.db, child.id, { title: "Measure twice", expectedRevision: child.revision });
    await expect(apply(id, draft)).rejects.toMatchObject({ code: "stale_write_conflict" });
    expect(getTaskOrThrow(ctx.handle.db, task.id).children).toHaveLength(1);
    const second = prepare(task.id);
    createChildTask(ctx.handle.db, task.id, { title: "New manual step" });
    await expect(apply(second.id, second.draft)).rejects.toMatchObject({ code: "stale_write_conflict" });
    expect(getTaskOrThrow(ctx.handle.db, task.id).children).toHaveLength(2);
  });

  it("uses the existing conversion guard for tasks already inside a project", async () => {
    const project = createProject(ctx.handle.db, { title: "House" });
    const task = createTask(ctx.handle.db, { title: "Room", projectId: project.id });
    const { id, draft } = prepare(task.id, true);
    await expect(apply(id, draft)).rejects.toMatchObject({ code: "role_conversion_invalid" });
    expect(getTaskOrThrow(ctx.handle.db, task.id).children).toHaveLength(0);
  });

  it("does not expose another member's work task as AI context", () => {
    const owner = ctx.handle.db.insert(schema.members).values({ name: "Owner", color: "#123456" }).returning().get();
    const other = ctx.handle.db.insert(schema.members).values({ name: "Other", color: "#654321" }).returning().get();
    const task = createTask(ctx.handle.db, {
      title: "Private", scope: "work", ownerMemberId: owner.id, ownerInheritanceMode: "explicit",
    });
    expect(() => breakdownTask(ctx.handle.db, task.id, other.id)).toThrow();
    expect(breakdownTask(ctx.handle.db, task.id, owner.id).id).toBe(task.id);
  });

  it("rejects invented roots, calendar side effects, and nested structures", () => {
    const task = createTask(ctx.handle.db, { title: "Room", status: "actionable" });
    const { draft } = prepare(task.id);
    draft.workItems[0]!.key = "new-copy";
    expect(() => assertBreakdownDraft(draft)).toThrow();
    draft.workItems[0]!.key = "existing-task";
    draft.workItems[2]!.parentKey = "compare";
    expect(() => assertBreakdownDraft(draft)).toThrow();
    draft.workItems[2]!.parentKey = "existing-task";
    draft.workItems[0]!.dueDate = "2027-01-01";
    expect(() => assertBreakdownDraft(draft)).toThrow();
  });

  it("rejects invalid AI breakdown output before it becomes ready", () => {
    const task = createTask(ctx.handle.db, { title: "Room", status: "actionable" });
    const { id, draft } = prepare(task.id);
    const job = ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, id)).get()!;
    onIntakeAnalyzed(ctx.handle.db, job, {
      ...draft, workItems: draft.workItems.map(({ ownerMemberId: _, ...entry }) => ({
        ...entry, ownerName: null, parentKey: null,
      })),
    });
    expect(getIntake(ctx.handle.db, id, null).status).toBe("analysis_failed");
    expect(getTaskOrThrow(ctx.handle.db, task.id).children).toHaveLength(0);
  });

  it("starts and regenerates proposals through the existing bridge without mutating the source", async () => {
    const code = (await ctx.app.inject({
      method: "POST", url: "/api/integrations/home-assistant/pairing-code",
    })).json().code;
    await ctx.app.inject({
      method: "POST", url: "/api/integrations/home-assistant/pair",
      payload: { pairingCode: code, protocolVersion: 3 },
    });
    const task = createTask(ctx.handle.db, { title: "Room", status: "actionable", notes: "No invented services" });
    const response = await ctx.app.inject({
      method: "POST", url: `/api/intake/task/${task.id}`,
      payload: { expectedRevision: task.revision, instruction: "Make 20-minute steps" },
    });
    expect(response.statusCode).toBe(201);
    const id = response.json().id as string;
    const request = ctx.handle.db.select().from(schema.homeAssistantRequests)
      .where(eq(schema.homeAssistantRequests.intakeJobId, id)).get()!;
    const payload = JSON.parse(request.payloadJson);
    expect(request.kind).toBe("intake_analyze");
    expect(payload.instructions).toContain("Make 20-minute steps");
    expect(payload.instructions).toContain("no web research capability");
    expect(payload.text).toContain("No invented services");
    expect(getTaskOrThrow(ctx.handle.db, task.id).children).toHaveLength(0);
    const job = ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, id)).get()!;
    const proposal = prepare(task.id).draft;
    onIntakeAnalyzed(ctx.handle.db, job, {
      summary: proposal.summary, warnings: [], calendarEvents: [],
      workItems: proposal.workItems.map(({ ownerMemberId: _, enabled: __, ...entry }) => ({ ...entry, ownerName: null })),
    });
    createChildTask(ctx.handle.db, task.id, { title: "Already measured" });
    const retried = await ctx.app.inject({
      method: "POST", url: `/api/intake/${id}/retry`, payload: { hint: "Do not repeat measuring" },
    });
    expect(retried.statusCode).toBe(200);
    const refreshed = ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, id)).get()!;
    expect(refreshed.text).toContain("Already measured");
    expect(refreshed.breakdownSnapshotJson).toBe(breakdownSnapshot(ctx.handle.db, task.id));
    expect(refreshed.breakdownInstruction).toBe("Make 20-minute steps");
    expect(getTaskOrThrow(ctx.handle.db, task.id).children).toHaveLength(1);
  });
});
