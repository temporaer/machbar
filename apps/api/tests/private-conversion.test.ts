import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACTIVITY_ACTOR_HEADER, type IntakeDraft, type IntakeDraftWorkItem } from "@machbar/shared";
import * as schema from "../src/db/schema.js";
import { createProject } from "../src/domain/storyCrud.js";
import { createTask } from "../src/domain/taskCrud.js";
import { breakdownSnapshot } from "../src/intake/breakdown.js";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

describe("private generated work", () => {
  let ctx: TestContext;
  let owner: number;
  let other: number;
  const headers = () => ({ [ACTIVITY_ACTOR_HEADER]: String(owner) });
  beforeEach(() => {
    ctx = createTestContext();
    owner = ctx.handle.db.insert(schema.members).values({ name: "Owner", color: "#111111" }).returning().get().id;
    other = ctx.handle.db.insert(schema.members).values({ name: "Other", color: "#222222" }).returning().get().id;
  });
  afterEach(async () => closeTestContext(ctx));

  async function assertPrivate(id: number, title: string, notes: string) {
    const row = ctx.handle.sqlite.prepare("SELECT privacy_owner_member_id FROM work_items WHERE id = ?").get(id);
    expect(row).toEqual({ privacy_owner_member_id: owner });
    const own = await ctx.app.inject({ method: "GET", url: `/api/tasks/${id}`, headers: headers() });
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json().title).toBe(title);
    expect(own.json().notes).toBe(notes);
    for (const viewerHeaders of [{ [ACTIVITY_ACTOR_HEADER]: String(other) }, {}]) {
      const read = await ctx.app.inject({ method: "GET", url: `/api/tasks/${id}`, headers: viewerHeaders });
      expect(read.statusCode, read.body).toBe(404);
      expect(read.body).not.toContain(title);
      if (notes) expect(read.body).not.toContain(notes);
      const activity = await ctx.app.inject({ method: "GET", url: "/api/activity", headers: viewerHeaders });
      expect(activity.statusCode, activity.body).toBe(200);
      expect(activity.body).not.toContain(title);
      if (notes) expect(activity.body).not.toContain(notes);
    }
  }

  it.each(["direct", "batch", "breakdown"] as const)(
    "keeps preserved and newly generated actions private after %s conversion",
    async (mode) => {
      const title = "Confidential source title";
      const notes = "Confidential source notes";
      const source = createTask(ctx.handle.db, { title, notes, status: "actionable", privacyOwnerMemberId: owner });
      if (mode === "direct") {
        const response = await ctx.app.inject({
          method: "POST", url: `/api/tasks/${source.id}/convert-to-story`, headers: headers(),
          payload: { status: "backlog", expectedRevision: source.revision },
        });
        expect(response.statusCode, response.body).toBe(201);
      } else if (mode === "batch") {
        const response = await ctx.app.inject({
          method: "POST", url: `/api/tasks/${source.id}/children/batch`, headers: headers(),
          payload: { expectedRevision: source.revision, convertParentToProject: true, steps: [{ title: "Confidential batch step" }] },
        });
        expect(response.statusCode, response.body).toBe(201);
      } else {
        const item = (key: string, parentKey: string | null, itemTitle: string): IntakeDraftWorkItem => ({
          key, parentKey, title: itemTitle, kind: "action", notes: null, enabled: true,
          ownerMemberId: null, dueDate: null, scheduledDate: null, revisitAt: null,
          notBeforeAt: null, notBeforeDate: null, reminders: [], needsClarification: false, relatedCalendarKeys: [],
        });
        const draft: IntakeDraft = {
          summary: "Private breakdown", warnings: [], calendarEvents: [], retainSourceInPaperless: false,
          workItems: [{ ...item("existing-task", null, title), kind: "project", notes }, item("step", "existing-task", "Confidential breakdown step")],
        };
        const id = randomUUID();
        const now = new Date();
        ctx.handle.db.insert(schema.intakeJobs).values({
          id, status: "ready", revision: 1, scope: "household", createdByMemberId: owner,
          breakdownTaskId: source.id, breakdownSnapshotJson: breakdownSnapshot(ctx.handle.db, source.id),
          draftJson: JSON.stringify(draft), createdAt: now.toISOString(), updatedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 86400000).toISOString(),
        }).run();
        const response = await ctx.app.inject({
          method: "POST", url: `/api/intake/${id}/apply`, headers: headers(),
          payload: { expectedRevision: 1, draft },
        });
        expect(response.statusCode, response.body).toBe(200);
      }
      const children = ctx.handle.sqlite.prepare("SELECT id, title, notes FROM work_items WHERE parent_id = ? AND role = 'task'").all(source.id) as Array<{ id: number; title: string; notes: string }>;
      expect(children).toHaveLength(mode === "direct" ? 1 : 2);
      expect(children).toContainEqual(expect.objectContaining({ title, notes }));
      for (const child of children) await assertPrivate(child.id, child.title, child.notes);
    },
  );

  it("keeps an activation-created next action private", async () => {
    const project = createProject(ctx.handle.db, { title: "Private project" });
    ctx.handle.sqlite.prepare("UPDATE work_items SET privacy_owner_member_id = ? WHERE id = ?").run(owner, project.id);
    const response = await ctx.app.inject({
      method: "POST", url: `/api/projects/${project.id}/activate`, headers: headers(),
      payload: { expectedRevision: project.revision, ownerMemberId: owner, nextActionTitle: "Private next action" },
    });
    expect(response.statusCode, response.body).toBe(200);
    const child = ctx.handle.sqlite.prepare("SELECT id FROM work_items WHERE parent_id = ? AND role = 'task'").get(project.id) as { id: number };
    await assertPrivate(child.id, "Private next action", "");
  });
});
