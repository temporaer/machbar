import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { IntakeDraft, IntakeDraftCalendarEvent, IntakeDraftWorkItem } from "@machbar/shared";
import * as schema from "../src/db/schema.js";
import { applyIntake } from "../src/intake/apply.js";
import { getIntake, updateIntakeDraft } from "../src/intake/jobs.js";
import { HomeAssistantRequestSignal } from "../src/integrations/homeAssistantRequests.js";
import { writeAttachment } from "../src/intake/storage.js";
import type { PaperlessClient } from "../src/paperless/client.js";
import { createProject } from "../src/domain/storyCrud.js";
import { createTask } from "../src/domain/taskCrud.js";
import {
  closeTestContext,
  createTestContext,
  type TestContext,
} from "./helpers.js";

const env = (dataDir: string) => ({ dataDir } as never);

describe("intake apply", () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = createTestContext(); });
  afterEach(async () => { await closeTestContext(ctx); });

  async function prepare(name = "Alex") {
    const member = ctx.handle.db.insert(schema.members).values({ name, color: "#123456" }).returning().get();
    const code = (await ctx.app.inject({
      method: "POST",
      url: "/api/integrations/home-assistant/pairing-code",
    })).json().code as string;
    const paired = await ctx.app.inject({
      method: "POST",
      url: "/api/integrations/home-assistant/pair",
      payload: { pairingCode: code, protocolVersion: 3 },
    });
    const token = paired.json().token as string;
    await ctx.app.inject({
      method: "POST",
      url: "/api/integrations/home-assistant/context",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        protocolVersion: 3,
        observedAt: new Date().toISOString(),
        contexts: [],
        people: [],
        intake: {
          aiTask: { entityId: "ai_task.test", state: "ok", supportsAttachments: true },
          calendar: { entityId: "calendar.test", state: "ok" },
        },
      },
    });
    const body = "------apply\r\nContent-Disposition: form-data; name=\"text\"\r\n\r\nsource\r\n------apply--\r\n";
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/intake",
      headers: { "content-type": "multipart/form-data; boundary=----apply" },
      payload: Buffer.from(body),
    });
    const id = created.json().id as string;
    const leased = await ctx.app.inject({
      method: "GET",
      url: "/api/integrations/home-assistant/requests/next?protocolVersion=3&waitSeconds=0",
      headers: { authorization: `Bearer ${token}` },
    });
    await ctx.app.inject({
      method: "POST",
      url: `/api/integrations/home-assistant/requests/${leased.json().id}/complete`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        leaseToken: leased.json().leaseToken,
        outcome: "succeeded",
        result: {
          summary: "Source",
          calendarEvents: [],
          workItems: [],
          warnings: [],
        },
      },
    });
    ctx.handle.db.update(schema.intakeJobs).set({
      createdByMemberId: member.id,
      actorMemberId: member.id,
    }).where(eq(schema.intakeJobs.id, id)).run();
    const job = ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, id)).get()!;
    return { id, member, token, revision: job.revision };
  }

  function draft(
    workItems: IntakeDraftWorkItem[],
    calendarEvents: IntakeDraftCalendarEvent[] = [],
  ): IntakeDraft {
    return {
      summary: "Source",
      calendarEvents,
      workItems,
      warnings: [],
      retainSourceInPaperless: false,
    };
  }

  function action(key: string, extra: Partial<IntakeDraftWorkItem> = {}): IntakeDraftWorkItem {
    return { key, kind: "action", title: key, notes: null, parentKey: null, ownerMemberId: null,
      dueDate: null, scheduledDate: null, revisitAt: null, notBeforeDate: null, notBeforeAt: null,
      reminders: [], needsClarification: false, relatedCalendarKeys: [], enabled: true, ...extra };
  }

  it("adds mixed new work and nested actions to existing active/backlog destinations without activation or Today leakage", async () => {
    const setup = await prepare();
    const active = createProject(ctx.handle.db, { title: "Active", ownerMemberId: setup.member.id });
    const backlog = createProject(ctx.handle.db, { title: "Backlog", ownerMemberId: setup.member.id });
    const waiting = createTask(ctx.handle.db, { title: "Already waiting", projectId: active.id, status: "actionable" });
    ctx.handle.db.insert(schema.taskExternalWaits).values({ taskId: waiting.id, waitingFor: "Permit", revisitDate: "2099-01-01" }).run();
    const originalWait = ctx.handle.db.select().from(schema.taskExternalWaits).all();
    ctx.handle.db.update(schema.workItems).set({ status: "active" }).where(eq(schema.workItems.id, active.id)).run();
    const d = draft([
      action("active-step", { existingProjectId: active.id, existingProjectRevision: active.revision }),
      action("backlog-step", { existingProjectId: backlog.id, existingProjectRevision: backlog.revision, scheduledDate: "2020-01-01" }),
      action("nested", { parentKey: "backlog-step", dueDate: "2020-01-01" }),
      action("standalone"),
      action("new-project", { kind: "project" }),
      action("new-child", { parentKey: "new-project" }),
    ]);
    await applyIntake(ctx.handle.db, env(ctx.dataDir), undefined, new HomeAssistantRequestSignal(), setup.id,
      { expectedRevision: setup.revision, draft: d }, { actorMemberId: setup.member.id }, setup.member.id);
    const record = getIntake(ctx.handle.db, setup.id, setup.member.id);
    expect(record.status).toBe("applied");
    const rows = ctx.handle.db.select().from(schema.workItems).all();
    const byTitle = new Map(rows.map((row) => [row.title, row]));
    expect(byTitle.get("active-step")?.parentId).toBe(active.id);
    expect(byTitle.get("backlog-step")?.parentId).toBe(backlog.id);
    expect(byTitle.get("nested")?.parentId).toBe(byTitle.get("backlog-step")?.id);
    expect(byTitle.get("standalone")?.parentId).toBeNull();
    expect(byTitle.get("new-child")?.parentId).toBe(byTitle.get("new-project")?.id);
    expect(byTitle.get("Backlog")?.status).toBe("backlog");
    expect(byTitle.get("Active")?.status).toBe("active");
    expect(byTitle.get("Already waiting")?.status).toBe("active");
    expect(ctx.handle.db.select().from(schema.taskExternalWaits).all()).toEqual(originalWait);
    const today = await ctx.app.inject({ method: "GET", url: "/api/agenda/today" });
    expect(today.statusCode).toBe(200);
    expect(today.body).not.toContain('"title":"backlog-step"');
    expect(today.body).not.toContain('"title":"nested"');
    // Lost result: replay the immutable accepted work after its destination revision/lifecycle changed.
    ctx.handle.db.update(schema.workItems).set({ revision: 99, status: "done" }).where(eq(schema.workItems.id, backlog.id)).run();
    ctx.handle.db.update(schema.intakeJobs).set({ status: "partially_applied" }).where(eq(schema.intakeJobs.id, setup.id)).run();
    await applyIntake(ctx.handle.db, env(ctx.dataDir), undefined, new HomeAssistantRequestSignal(), setup.id,
      { expectedRevision: record.revision, draft: draft([action("FORGED RETRY")]) }, { actorMemberId: setup.member.id }, setup.member.id);
    expect(ctx.handle.db.select().from(schema.workItems).all()).toHaveLength(rows.length);
    expect(JSON.parse(ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, setup.id)).get()!.acceptedDraftJson!)).toEqual(d);
  });

  it.each(["unknown", "private", "other-work", "out-of-scope", "done", "cancelled", "archived", "stale", "missing-revision", "wrong-kind", "both-parents"] as const)(
    "rejects %s destinations through the real API without partial work or title disclosure", async (failure) => {
      const setup = await prepare();
      const valid = createProject(ctx.handle.db, { title: "Eligible" });
      const target = createProject(ctx.handle.db, { title: "DO NOT DISCLOSE", ownerMemberId: setup.member.id,
        ...(failure === "other-work" || failure === "out-of-scope" ? { scope: "work" as const } : {}) });
      const patch = failure === "private" ? { privacyOwnerMemberId: setup.member.id }
        : failure === "done" || failure === "cancelled" ? { status: failure }
        : failure === "archived" ? { archivedAt: new Date().toISOString() }
        : failure === "stale" ? { revision: target.revision + 1 } : {};
      ctx.handle.db.update(schema.workItems).set({ ...patch, updatedAt: new Date().toISOString() }).where(eq(schema.workItems.id, target.id)).run();
      // Unknown initiating member can see shared household projects, but never private/work targets.
      ctx.handle.db.update(schema.intakeJobs).set({ createdByMemberId: null }).where(eq(schema.intakeJobs.id, setup.id)).run();
      const d = draft([
        action("valid-first", { existingProjectId: valid.id, existingProjectRevision: valid.revision }),
        action("invalid-last", { existingProjectId: failure === "unknown" ? 987654 : target.id,
          existingProjectRevision: failure === "missing-revision" ? null : target.revision,
          ...(failure === "wrong-kind" ? { kind: "project" as const } : {}),
          ...(failure === "both-parents" ? { parentKey: "valid-first" } : {}) }),
      ]);
      const before = {
        work: ctx.handle.db.select().from(schema.workItems).all(),
        activity: ctx.handle.db.select().from(schema.activityEvents).all(),
        outbox: ctx.handle.db.select().from(schema.notificationEvents).all(),
      };
      const response = await ctx.app.inject({ method: "POST", url: `/api/intake/${setup.id}/apply`,
        payload: { expectedRevision: setup.revision, draft: d } });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json().error.code).toBe("intake_draft_invalid");
      expect(response.body).not.toContain("DO NOT DISCLOSE");
      expect(ctx.handle.db.select().from(schema.workItems).all()).toEqual(before.work);
      expect(ctx.handle.db.select().from(schema.activityEvents).all()).toEqual(before.activity);
      expect(ctx.handle.db.select().from(schema.notificationEvents).all()).toEqual(before.outbox);
      expect(getIntake(ctx.handle.db, setup.id, null).existingProjects?.some((project) => project.id === target.id))
        .toBe(!["private", "other-work", "out-of-scope", "done", "cancelled", "archived"].includes(failure));
    },
  );

  it("rolls back existing-destination writes when a later canonical create fails", async () => {
    const setup = await prepare();
    const project = createProject(ctx.handle.db, { title: "Existing" });
    const before = ctx.handle.db.select().from(schema.workItems).all();
    const activity = ctx.handle.db.select().from(schema.activityEvents).all();
    const outbox = ctx.handle.db.select().from(schema.notificationEvents).all();
    const d = draft([
      action("existing-step", { existingProjectId: project.id, existingProjectRevision: project.revision }),
      action("new-project", { kind: "project", dueDate: "2099-01-01" }),
    ]);
    await expect(applyIntake(ctx.handle.db, env(ctx.dataDir), undefined, new HomeAssistantRequestSignal(), setup.id,
      { expectedRevision: setup.revision, draft: d }, { actorMemberId: null }, setup.member.id))
      .rejects.toMatchObject({ code: "project_commitment_resolution_required" });
    expect(ctx.handle.db.select().from(schema.workItems).all()).toEqual(before);
    expect(ctx.handle.db.select().from(schema.activityEvents).all()).toEqual(activity);
    expect(ctx.handle.db.select().from(schema.notificationEvents).all()).toEqual(outbox);
    expect(getIntake(ctx.handle.db, setup.id, setup.member.id).applyResults).toBeNull();
  });

  it("keeps committed work immutable when another destination changes during source retention", async () => {
    let changeDestination!: () => void;
    const upload = vi.fn(async () => ({ taskId: "upload" }));
    const paperless = { upload, awaitDocumentId: async () => { changeDestination(); return 111; },
      getDocument: async () => ({ id: 111, title: "Source", originalFileName: "source.txt", mimeType: "text/plain" }),
    } as unknown as PaperlessClient;
    await closeTestContext(ctx);
    ctx = createTestContext({ paperlessClient: paperless });
    const setup = await prepare();
    const headers = { "x-machbar-actor-member-id": String(setup.member.id) };
    const committedProject = createProject(ctx.handle.db, { title: "Committed project" });
    const pendingProject = createProject(ctx.handle.db, { title: "Pending project" });
    const committed = createTask(ctx.handle.db, { title: "Committed step", projectId: committedProject.id });
    const accepted = { ...draft([
      action("committed", { existingProjectId: committedProject.id, existingProjectRevision: committedProject.revision }),
      action("pending", { existingProjectId: pendingProject.id, existingProjectRevision: pendingProject.revision }),
    ]), retainSourceInPaperless: true };
    const sourceId = randomUUID();
    await writeAttachment(env(ctx.dataDir), setup.id, sourceId, Buffer.from("source"));
    ctx.handle.db.insert(schema.intakeAttachments).values({ id: sourceId, intakeJobId: setup.id, filename: "source.txt",
      mimeType: "text/plain", sizeBytes: 6, sha256: "hash", createdAt: new Date().toISOString() }).run();
    ctx.handle.db.update(schema.workItems).set({ status: "done", revision: 99 }).where(eq(schema.workItems.id, committedProject.id)).run();
    changeDestination = () => {
      ctx.handle.db.update(schema.workItems).set({ revision: 2 }).where(eq(schema.workItems.id, pendingProject.id)).run();
    };
    ctx.handle.db.update(schema.intakeJobs).set({ status: "partially_applied", acceptedDraftJson: JSON.stringify(accepted),
      applyResultsJson: JSON.stringify({ work: [{ key: "committed", kind: "action", workItemId: committed.id, role: "task" }],
        calendar: [], paperlessDocumentIds: [] }) }).where(eq(schema.intakeJobs.id, setup.id)).run();
    const beforeActivity = ctx.handle.db.select().from(schema.activityEvents).all();
    const beforeOutbox = ctx.handle.db.select().from(schema.notificationEvents).all();
    const failed = await ctx.app.inject({ method: "POST", url: `/api/intake/${setup.id}/apply`, headers,
      payload: { expectedRevision: setup.revision, draft: draft([action("replacement")]) } });
    expect(failed.statusCode, failed.body).toBe(400);
    expect(failed.json().error).toMatchObject({ code: "intake_draft_invalid", details: { issues: [
        expect.objectContaining({ path: ["workItems", 1, "existingProjectId"] }),
    ] } });
    const partial = getIntake(ctx.handle.db, setup.id, setup.member.id);
    expect(partial.status).toBe("partially_applied");
    expect(partial.applyResults).toMatchObject({ work: [{ workItemId: committed.id }], paperlessDocumentIds: [111] });
    expect(ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, setup.id)).get()?.acceptedDraftJson)
      .toBe(JSON.stringify(accepted));
    const corrected = draft([action("replacement")]);
    const saved = await ctx.app.inject({ method: "PATCH", url: `/api/intake/${setup.id}/plan`, headers,
      payload: { expectedRevision: partial.revision, draft: corrected } });
    expect(saved.statusCode, saved.body).toBe(409);
    const retried = await ctx.app.inject({ method: "POST", url: `/api/intake/${setup.id}/apply`, headers,
      payload: { expectedRevision: partial.revision, draft: corrected } });
    expect(retried.statusCode, retried.body).toBe(400);
    expect(ctx.handle.db.select().from(schema.workItems).all()).toHaveLength(3);
    expect(ctx.handle.db.select().from(schema.activityEvents).all()).toEqual(beforeActivity);
    expect(ctx.handle.db.select().from(schema.notificationEvents).all()).toEqual(beforeOutbox);
    expect(getIntake(ctx.handle.db, setup.id, setup.member.id).status).toBe("partially_applied");
    expect(ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, setup.id)).get()?.acceptedDraftJson)
      .toBe(JSON.stringify(accepted));
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it.each(["household", "work"] as const)("preserves owner-only private %s destinations and nested child visibility", async (scope) => {
    const setup = await prepare();
    const other = ctx.handle.db.insert(schema.members).values({ name: "Other", color: "#123456" }).returning().get();
    const project = createProject(ctx.handle.db, { title: "Private", scope, ownerMemberId: setup.member.id });
    ctx.handle.db.update(schema.workItems).set({ privacyOwnerMemberId: setup.member.id }).where(eq(schema.workItems.id, project.id)).run();
    ctx.handle.db.update(schema.intakeJobs).set({ scope }).where(eq(schema.intakeJobs.id, setup.id)).run();
    const d = draft([
      action("private-step", { existingProjectId: project.id, existingProjectRevision: project.revision }),
      action("private-nested", { parentKey: "private-step" }),
    ]);
    const ownerHeaders = { "x-machbar-actor-member-id": String(setup.member.id) };
    const response = await ctx.app.inject({ method: "POST", url: `/api/intake/${setup.id}/apply`,
      headers: ownerHeaders, payload: { expectedRevision: setup.revision, draft: d } });
    expect(response.statusCode, response.body).toBe(200);
    for (const work of response.json().applyResults.work) {
      const ownerRead = await ctx.app.inject({ method: "GET", url: `/api/tasks/${work.workItemId}`, headers: ownerHeaders });
      expect(ownerRead.statusCode).toBe(200);
      expect(ownerRead.json()).toMatchObject({ scope, privacyOwnerMemberId: setup.member.id });
      for (const headers of [{}, { "x-machbar-actor-member-id": String(other.id) }]) {
        expect((await ctx.app.inject({ method: "GET", url: `/api/tasks/${work.workItemId}`, headers })).statusCode).toBe(404);
      }
    }
  });

  it.each(["revision", "access", "lifecycle"] as const)("reopens source-only destination failure after a held upload (%s) and applies explicit correction without duplicate retention", async (change) => {
    let uploaded!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { uploaded = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const upload = vi.fn(async () => { uploaded(); await held; return { taskId: "upload" }; });
    const paperless = {
      upload, awaitDocumentId: vi.fn(async () => 111),
      getDocument: async () => ({ id: 111, title: "Source", originalFileName: "source.txt", mimeType: "text/plain" }),
    } as unknown as PaperlessClient;
    await closeTestContext(ctx);
    ctx = createTestContext({ paperlessClient: paperless });
    const setup = await prepare();
    const headers = { "x-machbar-actor-member-id": String(setup.member.id) };
    const other = ctx.handle.db.insert(schema.members).values({ name: "Other", color: "#123456" }).returning().get();
    const first = createProject(ctx.handle.db, { title: "First" });
    const last = createProject(ctx.handle.db, { title: "Last" });
    const sourceId = randomUUID();
    await writeAttachment(env(ctx.dataDir), setup.id, sourceId, Buffer.from("source"));
    ctx.handle.db.insert(schema.intakeAttachments).values({ id: sourceId, intakeJobId: setup.id, filename: "source.txt",
      mimeType: "text/plain", sizeBytes: 6, sha256: "hash", createdAt: new Date().toISOString() }).run();
    const d = { ...draft([
      action("first-step", { existingProjectId: first.id, existingProjectRevision: first.revision }),
      action("last-step", { existingProjectId: last.id, existingProjectRevision: last.revision }),
    ]), retainSourceInPaperless: true };
    const beforeActivity = ctx.handle.db.select().from(schema.activityEvents).all();
    const beforeOutbox = ctx.handle.db.select().from(schema.notificationEvents).all();
    const beforeRequests = ctx.handle.db.select().from(schema.homeAssistantRequests).all();
    const applying = ctx.app.inject({ method: "POST", url: `/api/intake/${setup.id}/apply`, headers,
      payload: { expectedRevision: setup.revision, draft: d } }).then((response) => response);
    await started;
    ctx.handle.db.update(schema.workItems).set(change === "revision" ? { revision: last.revision + 1 }
      : change === "access" ? { privacyOwnerMemberId: other.id } : { status: "done" }).where(eq(schema.workItems.id, last.id)).run();
    const changedWork = ctx.handle.db.select().from(schema.workItems).all();
    release();
    const failed = await applying;
    expect(failed.statusCode, failed.body).toBe(400);
    expect(failed.json().error.code).toBe("intake_draft_invalid");
    expect(failed.body).not.toContain("First");
    expect(failed.body).not.toContain("Last");
    const recovered = (await ctx.app.inject({ method: "GET", url: `/api/intake/${setup.id}`, headers })).json();
    expect(recovered.status).toBe("ready");
    expect(recovered.draft).toEqual(d);
    if (change !== "revision") expect(recovered.existingProjects.some((project: { id: number }) => project.id === last.id)).toBe(false);
    expect(recovered.applyResults).toEqual({ work: [], calendar: [], paperlessDocumentIds: [111] });
    expect(ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, setup.id)).get()).toMatchObject({
      acceptedDraftJson: null, applyClaimToken: null, applyClaimExpiresAt: null,
    });
    expect(ctx.handle.db.select().from(schema.workItems).all()).toEqual(changedWork);
    expect(ctx.handle.db.select().from(schema.activityEvents).all()).toEqual(beforeActivity);
    expect(ctx.handle.db.select().from(schema.notificationEvents).all()).toEqual(beforeOutbox);
    expect(ctx.handle.db.select().from(schema.homeAssistantRequests).all()).toEqual(beforeRequests);
    const stale = await ctx.app.inject({ method: "POST", url: `/api/intake/${setup.id}/apply`, headers,
      payload: { expectedRevision: recovered.revision, draft: d } });
    expect(stale.statusCode, stale.body).toBe(400);
    expect(ctx.handle.db.select().from(schema.workItems).all()).toEqual(changedWork);
    expect(upload).toHaveBeenCalledTimes(1);
    const destinationId = change === "access" ? null : change === "revision" ? last.id : first.id;
    const destination = recovered.existingProjects.find((project: { id: number }) => project.id === destinationId);
    const corrected = { ...d, workItems: d.workItems.map((item, index) => index === 1 ? {
      ...item, existingProjectId: destinationId, existingProjectRevision: destination?.revision ?? null,
    } : item) };
    const saved = await ctx.app.inject({ method: "PATCH", url: `/api/intake/${setup.id}/plan`, headers,
      payload: { expectedRevision: recovered.revision, draft: corrected } });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().applyResults.paperlessDocumentIds).toEqual([111]);
    const applied = await ctx.app.inject({ method: "POST", url: `/api/intake/${setup.id}/apply`, headers,
      payload: { expectedRevision: saved.json().revision, draft: corrected } });
    expect(applied.statusCode, applied.body).toBe(200);
    expect(applied.json().status).toBe("applied");
    const created = ctx.handle.db.select().from(schema.workItems).all();
    expect(created).toHaveLength(changedWork.length + 2);
    expect(created.find((row) => row.title === "last-step")?.parentId).toBe(destinationId);
    expect(created.find((row) => row.title === "first-step")?.notes).toContain("paperless:111");
    const activityAfter = ctx.handle.db.select().from(schema.activityEvents).all();
    // Lost result: the accepted work remains immutable and its ledger prevents duplicate creation/upload.
    ctx.handle.db.update(schema.intakeJobs).set({ status: "partially_applied" }).where(eq(schema.intakeJobs.id, setup.id)).run();
    const replay = await ctx.app.inject({ method: "POST", url: `/api/intake/${setup.id}/apply`, headers,
      payload: { expectedRevision: applied.json().revision, draft: draft([action("replacement")]) } });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().status).toBe("applied");
    expect(ctx.handle.db.select().from(schema.workItems).all()).toEqual(created);
    expect(ctx.handle.db.select().from(schema.activityEvents).all()).toEqual(activityAfter);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(paperless.awaitDocumentId).toHaveBeenCalledTimes(1);
    expect(JSON.parse(ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, setup.id)).get()!.acceptedDraftJson!)).toEqual(corrected);
  });

  it("reopens an already-stranded source-only partial and preserves its ledger across explicit reanalysis", async () => {
    const upload = vi.fn();
    await closeTestContext(ctx);
    ctx = createTestContext({ paperlessClient: { upload } as unknown as PaperlessClient });
    const setup = await prepare();
    const headers = { "x-machbar-actor-member-id": String(setup.member.id) };
    const project = createProject(ctx.handle.db, { title: "Existing" });
    const stale = { ...draft([action("step", { existingProjectId: project.id, existingProjectRevision: project.revision })]),
      retainSourceInPaperless: true };
    const sourceId = randomUUID();
    await writeAttachment(env(ctx.dataDir), setup.id, sourceId, Buffer.from("source"));
    ctx.handle.db.insert(schema.intakeAttachments).values({ id: sourceId, intakeJobId: setup.id, filename: "source.txt",
      mimeType: "text/plain", sizeBytes: 6, sha256: "hash", createdAt: new Date().toISOString() }).run();
    ctx.handle.db.update(schema.workItems).set({ revision: project.revision + 1 }).where(eq(schema.workItems.id, project.id)).run();
    const results = { work: [], calendar: [], paperlessDocumentIds: [111] };
    ctx.handle.db.update(schema.intakeJobs).set({
      status: "partially_applied", acceptedDraftJson: JSON.stringify(stale), applyResultsJson: JSON.stringify(results),
    }).where(eq(schema.intakeJobs.id, setup.id)).run();
    const failed = await ctx.app.inject({ method: "POST", url: `/api/intake/${setup.id}/apply`, headers,
      payload: { expectedRevision: setup.revision, draft: draft([action("unconfirmed correction")]) } });
    expect(failed.statusCode, failed.body).toBe(400);
    expect(failed.json().error.code).toBe("intake_draft_invalid");
    const recovered = getIntake(ctx.handle.db, setup.id, setup.member.id);
    expect(recovered).toMatchObject({ status: "ready", draft: stale, applyResults: results });
    expect(ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, setup.id)).get()?.acceptedDraftJson).toBeNull();
    const retried = await ctx.app.inject({ method: "POST", url: `/api/intake/${setup.id}/retry`, headers });
    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json()).toMatchObject({ status: "queued", draft: stale, applyResults: results });
    const leased = await ctx.app.inject({ method: "GET",
      url: "/api/integrations/home-assistant/requests/next?protocolVersion=3&waitSeconds=0",
      headers: { authorization: `Bearer ${setup.token}` } });
    const completed = await ctx.app.inject({ method: "POST",
      url: `/api/integrations/home-assistant/requests/${leased.json().id}/complete`,
      headers: { authorization: `Bearer ${setup.token}` },
      payload: { leaseToken: leased.json().leaseToken, outcome: "succeeded",
        result: { summary: "Reanalyzed source", calendarEvents: [], workItems: [], warnings: [] } } });
    expect(completed.statusCode, completed.body).toBe(204);
    const reviewed = getIntake(ctx.handle.db, setup.id, setup.member.id);
    expect(reviewed).toMatchObject({ status: "ready", applyResults: results, draft: { summary: "Reanalyzed source" } });
    expect(ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, setup.id)).get()?.acceptedDraftJson).toBeNull();
    expect(upload).not.toHaveBeenCalled();
  });

  it.each([
    ["direct", "missing"],
    ["read-first", "missing"],
    ["direct", "empty"],
    ["read-first", "empty"],
  ] as const)("reopens an expired claim with a changed destination (%s retry, %s ledger)", async (entry, ledger) => {
    const setup = await prepare();
    const headers = { "x-machbar-actor-member-id": String(setup.member.id) };
    const project = createProject(ctx.handle.db, { title: "Existing" });
    const accepted = draft([
      action("standalone"),
      action("destination-step", { existingProjectId: project.id, existingProjectRevision: project.revision }),
    ]);
    const results = ledger === "missing" ? null : { work: [], calendar: [], paperlessDocumentIds: [] };
    ctx.handle.db.update(schema.workItems).set({ revision: project.revision + 1 }).where(eq(schema.workItems.id, project.id)).run();
    ctx.handle.db.update(schema.intakeJobs).set({
      status: "applying", acceptedDraftJson: JSON.stringify(accepted),
      applyResultsJson: results === null ? null : JSON.stringify(results),
      applyClaimToken: "interrupted-before-results",
      applyClaimExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      revision: setup.revision + 1,
    }).where(eq(schema.intakeJobs.id, setup.id)).run();
    const revision = entry === "read-first"
      ? getIntake(ctx.handle.db, setup.id, setup.member.id).revision
      : setup.revision + 1;
    const before = {
      work: ctx.handle.db.select().from(schema.workItems).all(),
      activity: ctx.handle.db.select().from(schema.activityEvents).all(),
      outbox: ctx.handle.db.select().from(schema.notificationEvents).all(),
      requests: ctx.handle.db.select().from(schema.homeAssistantRequests).all(),
    };
    const failed = await ctx.app.inject({ method: "POST", url: `/api/intake/${setup.id}/apply`, headers,
      payload: { expectedRevision: revision, draft: draft([action("unconfirmed replacement")]) } });
    expect(failed.statusCode, failed.body).toBe(400);
    expect(failed.json().error.code).toBe("intake_draft_invalid");
    const recovered = getIntake(ctx.handle.db, setup.id, setup.member.id);
    expect(recovered).toMatchObject({ status: "ready", draft: accepted, applyResults: results });
    expect(ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, setup.id)).get()).toMatchObject({
      acceptedDraftJson: null, applyClaimToken: null, applyClaimExpiresAt: null,
    });
    const unchanged = await ctx.app.inject({ method: "POST", url: `/api/intake/${setup.id}/apply`, headers,
      payload: { expectedRevision: recovered.revision, draft: recovered.draft } });
    expect(unchanged.statusCode, unchanged.body).toBe(400);
    expect(unchanged.json().error.code).toBe("intake_draft_invalid");
    expect(ctx.handle.db.select().from(schema.workItems).all()).toEqual(before.work);
    expect(ctx.handle.db.select().from(schema.activityEvents).all()).toEqual(before.activity);
    expect(ctx.handle.db.select().from(schema.notificationEvents).all()).toEqual(before.outbox);
    expect(ctx.handle.db.select().from(schema.homeAssistantRequests).all()).toEqual(before.requests);
    const corrected = draft([
      action("standalone"),
      action("destination-step", { existingProjectId: project.id, existingProjectRevision: project.revision + 1 }),
    ]);
    const saved = await ctx.app.inject({ method: "PATCH", url: `/api/intake/${setup.id}/plan`, headers,
      payload: { expectedRevision: recovered.revision, draft: corrected } });
    expect(saved.statusCode, saved.body).toBe(200);
    const applied = await ctx.app.inject({ method: "POST", url: `/api/intake/${setup.id}/apply`, headers,
      payload: { expectedRevision: saved.json().revision, draft: corrected } });
    expect(applied.statusCode, applied.body).toBe(200);
    expect(applied.json().status).toBe("applied");
    expect(ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.title, "standalone")).all()).toHaveLength(1);
    expect(ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.title, "destination-step")).all())
      .toMatchObject([{ parentId: project.id }]);
  });

  it("applies the reported work date and early reminder without inventing a revisit", async () => {
    const setup = await prepare();
    const d = draft([{ key: "register", kind: "action", title: "Register", notes: null, parentKey: null,
      ownerMemberId: null, dueDate: null, scheduledDate: "2026-10-16", revisitAt: null,
      notBeforeDate: "2026-10-16", notBeforeAt: "2026-10-16T18:00:00+02:00",
      reminders: [{ kind: "absolute", at: "2026-10-16T17:30:00+02:00" }],
      needsClarification: true, relatedCalendarKeys: [], enabled: true }]);
    await applyIntake(ctx.handle.db, env(ctx.dataDir), undefined, new HomeAssistantRequestSignal(), setup.id,
      { expectedRevision: setup.revision, draft: d }, { actorMemberId: setup.member.id }, setup.member.id);
    const record = getIntake(ctx.handle.db, setup.id, setup.member.id);
    expect(record.status).toBe("applied");
    expect(ctx.handle.db.select().from(schema.workItems).all()).toMatchObject([
      { scheduledDate: "2026-10-16", revisitAt: null, needsClarification: true,
        notes: "Source availability: 2026-10-16T18:00:00+02:00" },
    ]);
    expect(ctx.handle.db.select().from(schema.taskReminders).all()).toMatchObject([
      { kind: "absolute", at: "2026-10-16T17:30:00+02:00" },
    ]);
  });

  it("rolls back failed ordinary creation, retains concrete errors, and retries corrected work once", async () => {
    const setup = await prepare();
    const item: IntakeDraftWorkItem = { key: "first", kind: "action", title: "First", notes: null,
      parentKey: null, ownerMemberId: null, dueDate: null, scheduledDate: "2026-10-16", revisitAt: null,
      notBeforeDate: null, notBeforeAt: null, reminders: [{ kind: "absolute", at: "2026-10-16T17:30:00+02:00" }],
      needsClarification: false, relatedCalendarKeys: [], enabled: true };
    // A project deadline activates the project and needs a driver; validation cannot decide this from the draft alone.
    const d = draft([item, { ...item, key: "project", title: "Project", kind: "project", scheduledDate: null,
      dueDate: "2026-10-20", reminders: [] }]);
    updateIntakeDraft(ctx.handle.db, setup.id, setup.member.id, { expectedRevision: setup.revision, draft: d });
    const saved = getIntake(ctx.handle.db, setup.id, setup.member.id);
    const beforeActivity = ctx.handle.db.select().from(schema.activityEvents).all();
    await expect(applyIntake(ctx.handle.db, env(ctx.dataDir), undefined, new HomeAssistantRequestSignal(), setup.id,
      { expectedRevision: saved.revision, draft: d }, { actorMemberId: null }, setup.member.id)).rejects.toMatchObject({
        code: "project_commitment_resolution_required",
      });
    const recovered = getIntake(ctx.handle.db, setup.id, setup.member.id);
    expect(recovered.status).toBe("ready");
    expect(recovered.error).toMatchObject({ code: "project_commitment_resolution_required", retryable: true });
    expect(recovered.error?.details).toBeDefined();
    expect(recovered.draft).toEqual(d);
    expect(recovered.applyResults).toBeNull();
    expect(ctx.handle.db.select().from(schema.workItems).all()).toHaveLength(0);
    expect(ctx.handle.db.select().from(schema.taskReminders).all()).toHaveLength(0);
    expect(ctx.handle.db.select().from(schema.activityEvents).all()).toEqual(beforeActivity);
    const corrected = draft([item]);
    await applyIntake(ctx.handle.db, env(ctx.dataDir), undefined, new HomeAssistantRequestSignal(), setup.id,
      { expectedRevision: recovered.revision, draft: corrected }, { actorMemberId: setup.member.id }, setup.member.id);
    expect(ctx.handle.db.select().from(schema.workItems).all()).toHaveLength(1);
    expect(ctx.handle.db.select().from(schema.taskReminders).all()).toHaveLength(1);
    expect(getIntake(ctx.handle.db, setup.id, setup.member.id).status).toBe("applied");
  });

  it("uses the selected driver when retrying an ordinary project intake", async () => {
    const setup = await prepare();
    const d = draft([
      {
        key: "project", kind: "project", title: "Mathematik vorbereiten", notes: null,
        parentKey: null, ownerMemberId: null, dueDate: "2026-10-22", scheduledDate: null,
        revisitAt: null, notBeforeDate: null, notBeforeAt: null, reminders: [],
        needsClarification: false, relatedCalendarKeys: [], enabled: true,
      },
      {
        key: "action", kind: "action", title: "Übungen bearbeiten", notes: null,
        parentKey: "project", ownerMemberId: null, dueDate: null, scheduledDate: null,
        revisitAt: null, notBeforeDate: null, notBeforeAt: null, reminders: [],
        needsClarification: false, relatedCalendarKeys: [], enabled: true,
      },
    ]);
    await expect(applyIntake(ctx.handle.db, env(ctx.dataDir), undefined, new HomeAssistantRequestSignal(), setup.id, {
      expectedRevision: setup.revision,
      draft: d,
    }, { actorMemberId: setup.member.id }, setup.member.id)).rejects.toMatchObject({
      code: "project_commitment_resolution_required",
    });

    const recovered = getIntake(ctx.handle.db, setup.id, setup.member.id);
    await applyIntake(ctx.handle.db, env(ctx.dataDir), undefined, new HomeAssistantRequestSignal(), setup.id, {
      expectedRevision: recovered.revision,
      draft: d,
      projectDriverMemberId: setup.member.id,
    }, { actorMemberId: setup.member.id }, setup.member.id);

    const project = ctx.handle.db.select().from(schema.workItems)
      .where(eq(schema.workItems.title, "Mathematik vorbereiten")).get()!;
    const action = ctx.handle.db.select().from(schema.workItems)
      .where(eq(schema.workItems.title, "Übungen bearbeiten")).get()!;
    expect(project).toMatchObject({ role: "story", ownerMemberId: setup.member.id, status: "active" });
    expect(action.parentId).toBe(project.id);
    expect(getIntake(ctx.handle.db, setup.id, setup.member.id).status).toBe("applied");
  });

  it("creates nested projects, actions, and references with domain activity", async () => {
    const setup = await prepare();
    const signal = new HomeAssistantRequestSignal();
    const d = draft([
      { key: "project", kind: "project", title: "Renovate", notes: "Plan", parentKey: null, dueDate: "2026-10-10", scheduledDate: null, notBeforeDate: null, notBeforeAt: null, reminders: [], needsClarification: false, relatedCalendarKeys: [], enabled: true, ownerMemberId: setup.member.id },
      { key: "action", kind: "action", title: "Buy paint", notes: null, parentKey: "project", dueDate: "2026-10-01", scheduledDate: "2026-09-29", notBeforeDate: null, notBeforeAt: null, reminders: [{ kind: "absolute", at: "2026-09-28T09:00:00.000Z" }], needsClarification: false, relatedCalendarKeys: [], enabled: true, ownerMemberId: setup.member.id },
      { key: "reference", kind: "reference", title: "Colour chart", notes: "Keep", parentKey: "action", dueDate: null, scheduledDate: null, notBeforeDate: null, notBeforeAt: null, reminders: [], needsClarification: false, relatedCalendarKeys: [], enabled: true, ownerMemberId: null },
      { key: "root", kind: "action", title: "Call contractor", notes: null, parentKey: null, dueDate: null, scheduledDate: null, notBeforeDate: null, notBeforeAt: null, reminders: [], needsClarification: true, relatedCalendarKeys: [], enabled: true, ownerMemberId: setup.member.id },
    ]);
    await applyIntake(ctx.handle.db, env(ctx.dataDir), undefined, signal, setup.id, {
      expectedRevision: setup.revision,
      draft: d,
    }, { actorMemberId: setup.member.id }, setup.member.id);
    const project = ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.title, "Renovate")).get()!;
    const action = ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.title, "Buy paint")).get()!;
    const reference = ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.title, "Colour chart")).get()!;
    expect(project.role).toBe("story");
    expect(action.parentId).toBe(project.id);
    expect(reference.parentId).toBe(action.id);
    expect(action.ownerMemberId).toBe(setup.member.id);
    expect(ctx.handle.db.select().from(schema.taskReminders).where(eq(schema.taskReminders.taskId, action.id)).get()?.at).toContain("2026-09-28");
    expect(ctx.handle.db.select().from(schema.activityEvents).all().some((row) => row.actorMemberId === setup.member.id)).toBe(true);
    expect((await ctx.app.inject({ method: "GET", url: `/api/projects/${project.id}` })).json().tasks).toEqual(expect.any(Array));
    expect((await ctx.app.inject({ method: "GET", url: `/api/tasks/${action.id}` })).json().kind).toBe("action");
  });

  it("rejects unresolved semantic errors at Apply without creating work", async () => {
    const setup = await prepare();
    const signal = new HomeAssistantRequestSignal();
    const invalid = draft([{
      key: "clarify",
      kind: "action",
      title: "Clarify",
      notes: null,
      parentKey: null,
      dueDate: null,
      scheduledDate: null,
      notBeforeDate: null,
      notBeforeAt: null,
      reminders: [{ kind: "absolute", at: "not-a-date" }],
      needsClarification: true,
      relatedCalendarKeys: [],
      enabled: true,
      ownerMemberId: setup.member.id,
    }]);
    await expect(applyIntake(ctx.handle.db, env(ctx.dataDir), undefined, signal, setup.id, {
      expectedRevision: setup.revision,
      draft: invalid,
    }, { actorMemberId: setup.member.id }, setup.member.id)).rejects.toMatchObject({
      code: "intake_draft_invalid",
    });
    expect(ctx.handle.db.select().from(schema.workItems).all()).toHaveLength(0);
  });

  it("accepts incomplete optional metadata and persists the prepared draft", async () => {
    const setup = await prepare();
    const signal = new HomeAssistantRequestSignal();
    const original = {
      ...draft([{
      key: "clarify",
      kind: "action",
      title: "Clarify",
      notes: null,
      parentKey: null,
      dueDate: "not-a-date",
      scheduledDate: "also-not-a-date",
      notBeforeDate: "2026-10-08",
      notBeforeAt: "2026-10-08T09:00",
      reminders: [
        { kind: "absolute", at: "not-a-date" },
        { kind: "absolute", at: "2026-10-01T08:00:00.000Z" },
        { kind: "absolute", at: "2026-10-01T09:00" },
        { kind: "deadline_relative", daysBefore: 1, time: "08:00", timezone: "Europe/Berlin" },
      ],
      needsClarification: true,
      relatedCalendarKeys: [],
      enabled: true,
      ownerMemberId: 999,
      }, {
        key: "project-with-task-fields",
        kind: "project",
        title: "Project",
        notes: null,
        parentKey: null,
        dueDate: null,
        scheduledDate: null,
        notBeforeDate: "not-a-date",
        notBeforeAt: null,
        reminders: [{ kind: "absolute", at: "not-a-date" }],
        needsClarification: true,
        relatedCalendarKeys: [],
        enabled: false,
        ownerMemberId: setup.member.id,
      }]),
      retainSourceInPaperless: false,
    };
    updateIntakeDraft(ctx.handle.db, setup.id, setup.member.id, {
      expectedRevision: setup.revision,
      draft: original,
    }, { paperlessAvailable: false, hasFiles: false });
    const edited = ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, setup.id)).get()!;

    await applyIntake(ctx.handle.db, env(ctx.dataDir), undefined, signal, setup.id, {
      expectedRevision: edited.revision,
      draft: original,
      acceptIncomplete: true,
      timezone: "America/New_York",
    }, { actorMemberId: setup.member.id }, setup.member.id);

    const job = ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, setup.id)).get()!;
    const accepted = JSON.parse(job.acceptedDraftJson!) as IntakeDraft;
    const storedDraft = JSON.parse(job.draftJson!) as IntakeDraft;
    expect(accepted.workItems[0]).toMatchObject({
      enabled: true,
      dueDate: null,
      scheduledDate: null,
      notBeforeDate: "2026-10-08",
      notBeforeAt: "2026-10-08T09:00:00-04:00",
      ownerMemberId: null,
      needsClarification: true,
    });
    expect(accepted.workItems[0]?.reminders).toEqual([
      { kind: "absolute", at: "2026-10-01T08:00:00.000Z" },
      { kind: "absolute", at: "2026-10-01T09:00:00-04:00" },
    ]);
    expect(accepted.workItems[1]).toMatchObject({
      enabled: false,
      ownerMemberId: setup.member.id,
      notBeforeDate: null,
      notBeforeAt: null,
      reminders: [],
      needsClarification: false,
    });
    expect(accepted.warnings).toEqual([
      { message: "Ignored task-only fields on project 'project-with-task-fields'." },
    ]);
    expect(accepted.retainSourceInPaperless).toBe(false);
    expect(storedDraft.workItems[0]?.dueDate).toBe("not-a-date");
    expect(job.planJson).not.toBe(job.acceptedDraftJson);
    const task = ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.title, "Clarify")).get()!;
    expect(ctx.handle.db.select().from(schema.taskReminders).where(eq(schema.taskReminders.taskId, task.id)).all()).toHaveLength(2);
    expect(task.status).toBe("captured");
  });

  it("applies only valid selected proposals when an invalid item is disabled", async () => {
    const setup = await prepare();
    const selected = draft([
      {
        key: "valid",
        kind: "action",
        title: "Keep this",
        notes: null,
        parentKey: null,
        dueDate: null,
        scheduledDate: null,
        notBeforeDate: null,
        notBeforeAt: null,
        reminders: [],
        needsClarification: false,
        relatedCalendarKeys: [],
        enabled: true,
        ownerMemberId: null,
      },
      {
        key: "invalid-disabled",
        kind: "action",
        title: "Do not create",
        notes: null,
        parentKey: null,
        dueDate: null,
        scheduledDate: null,
        notBeforeDate: null,
        notBeforeAt: null,
        reminders: [{ kind: "absolute", at: "2026-10-01T08:00:00.000Z" }],
        needsClarification: true,
        relatedCalendarKeys: [],
        enabled: false,
        ownerMemberId: null,
      },
    ]);
    await applyIntake(ctx.handle.db, env(ctx.dataDir), undefined, new HomeAssistantRequestSignal(), setup.id, {
      expectedRevision: setup.revision,
      draft: selected,
    }, { actorMemberId: setup.member.id }, setup.member.id);
    expect(ctx.handle.db.select().from(schema.workItems).all().map((item) => item.title)).toEqual(["Keep this"]);
  });

  it("rejects an enabled child whose parent is disabled", async () => {
    const setup = await prepare();
    const selected = draft([
      {
        key: "parent",
        kind: "action",
        title: "Disabled parent",
        notes: null,
        parentKey: null,
        dueDate: null,
        scheduledDate: null,
        notBeforeDate: null,
        notBeforeAt: null,
        reminders: [],
        needsClarification: false,
        relatedCalendarKeys: [],
        enabled: false,
        ownerMemberId: null,
      },
      {
        key: "child",
        kind: "action",
        title: "Enabled child",
        notes: null,
        parentKey: "parent",
        dueDate: null,
        scheduledDate: null,
        notBeforeDate: null,
        notBeforeAt: null,
        reminders: [],
        needsClarification: false,
        relatedCalendarKeys: [],
        enabled: true,
        ownerMemberId: null,
      },
    ]);
    await expect(applyIntake(ctx.handle.db, env(ctx.dataDir), undefined, new HomeAssistantRequestSignal(), setup.id, {
      expectedRevision: setup.revision,
      draft: selected,
    }, { actorMemberId: setup.member.id }, setup.member.id)).rejects.toMatchObject({
      code: "intake_draft_invalid",
      details: {
        issues: expect.arrayContaining([
          expect.objectContaining({ code: "parent_disabled", path: ["workItems", 1, "parentKey"] }),
        ]),
      },
    });
    expect(ctx.handle.db.select().from(schema.workItems).all()).toHaveLength(0);
  });

  it("retries an immutable legacy project date after committed work without duplicate work or changed external payloads", async () => {
    const setup = await prepare();
    const project = createProject(ctx.handle.db, { title: "Committed project", ownerMemberId: setup.member.id }, { actorMemberId: setup.member.id });
    const d = draft([{ key: "project", kind: "project", title: "Committed project", notes: null, parentKey: null,
      ownerMemberId: setup.member.id, dueDate: null, scheduledDate: "2026-10-16", revisitAt: null,
      notBeforeDate: null, notBeforeAt: null, reminders: [], needsClarification: false,
      relatedCalendarKeys: ["event"], enabled: true }], [{
      key: "event", title: "Accepted appointment", description: "Accepted description", location: "Library", allDay: false,
      startDate: null, endDate: null, startDateTime: "2026-10-16T18:00:00+02:00", endDateTime: "2026-10-16T19:00:00+02:00",
      relatedWorkKeys: ["project"], enabled: true, durationAssumed: false,
    }]);
    const signal = new HomeAssistantRequestSignal();
    // The same project date is rejected for new acceptance and for uncommitted partial work.
    await expect(applyIntake(ctx.handle.db, env(ctx.dataDir), undefined, signal, setup.id,
      { expectedRevision: setup.revision, draft: d }, { actorMemberId: setup.member.id }, setup.member.id))
      .rejects.toMatchObject({ code: "intake_draft_invalid", details: { issues: expect.arrayContaining([
        expect.objectContaining({ code: "project_field_not_allowed", path: ["workItems", 0, "scheduledDate"] }),
      ]) } });
    const results = { work: [{ key: "project", kind: "project", workItemId: project.id, role: "story" }],
      calendar: [{ key: "event", correlationId: "b724f23a-90df-45cb-9e37-9881182b1ffe", status: "failed", error: { code: "calendar_create_failed", message: "Retry", retryable: true }, event: null }],
      paperlessDocumentIds: [] };
    ctx.handle.db.update(schema.intakeJobs).set({ status: "partially_applied", acceptedDraftJson: JSON.stringify(d),
      draftJson: JSON.stringify(d), applyResultsJson: JSON.stringify(results) }).where(eq(schema.intakeJobs.id, setup.id)).run();
    const invalidExternal = structuredClone(d);
    invalidExternal.calendarEvents[0]!.startDateTime = "not-a-date";
    ctx.handle.db.update(schema.intakeJobs).set({ acceptedDraftJson: JSON.stringify(invalidExternal) }).where(eq(schema.intakeJobs.id, setup.id)).run();
    await expect(applyIntake(ctx.handle.db, env(ctx.dataDir), undefined, signal, setup.id,
      { expectedRevision: setup.revision }, { actorMemberId: setup.member.id }, setup.member.id))
      .rejects.toMatchObject({ code: "intake_draft_invalid" });
    ctx.handle.db.update(schema.intakeJobs).set({ acceptedDraftJson: JSON.stringify(d),
      applyResultsJson: JSON.stringify({ ...results, work: [] }) }).where(eq(schema.intakeJobs.id, setup.id)).run();
    await expect(applyIntake(ctx.handle.db, env(ctx.dataDir), undefined, signal, setup.id,
      { expectedRevision: setup.revision }, { actorMemberId: setup.member.id }, setup.member.id))
      .rejects.toMatchObject({ code: "intake_draft_invalid" });
    ctx.handle.db.update(schema.intakeJobs).set({ applyResultsJson: JSON.stringify(results) }).where(eq(schema.intakeJobs.id, setup.id)).run();
    const edited = structuredClone(d);
    edited.calendarEvents[0]!.title = "Unaccepted replacement";
    await applyIntake(ctx.handle.db, env(ctx.dataDir), undefined, signal, setup.id,
      { expectedRevision: setup.revision, draft: edited }, { actorMemberId: setup.member.id }, setup.member.id);
    expect(ctx.handle.db.select().from(schema.workItems).all()).toHaveLength(1);
    const retried = getIntake(ctx.handle.db, setup.id, setup.member.id);
    expect(retried.applyResults?.calendar[0]).toMatchObject({ correlationId: "b724f23a-90df-45cb-9e37-9881182b1ffe", status: "pending" });
    const request = ctx.handle.db.select().from(schema.homeAssistantRequests).where(eq(schema.homeAssistantRequests.kind, "calendar_create")).get()!;
    expect(JSON.parse(request.payloadJson)).toMatchObject({ correlationId: "b724f23a-90df-45cb-9e37-9881182b1ffe", title: "Accepted appointment", description: "Accepted description" });
    const leased = await ctx.app.inject({ method: "GET", url: "/api/integrations/home-assistant/requests/next?protocolVersion=3&waitSeconds=0",
      headers: { authorization: `Bearer ${setup.token}` } });
    const completed = await ctx.app.inject({ method: "POST", url: `/api/integrations/home-assistant/requests/${leased.json().id}/complete`,
      headers: { authorization: `Bearer ${setup.token}` }, payload: { leaseToken: leased.json().leaseToken, outcome: "succeeded",
        result: { correlationId: "b724f23a-90df-45cb-9e37-9881182b1ffe", calendarEntityId: "calendar.test", uid: "legacy-event", recurrenceId: null, summary: "Accepted appointment", start: "2026-10-16T18:00:00+02:00", end: "2026-10-16T19:00:00+02:00" } } });
    expect(completed.statusCode, completed.body).toBe(204);
    expect(getIntake(ctx.handle.db, setup.id, setup.member.id).status).toBe("applied");
    expect(ctx.handle.db.select().from(schema.workItems).all()).toHaveLength(1);
    expect(JSON.parse(ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, setup.id)).get()!.acceptedDraftJson!)).toEqual(d);
  });

  it("does not duplicate work when a calendar apply is retried", async () => {
    const setup = await prepare();
    const signal = new HomeAssistantRequestSignal();
    const d = draft([
      { key: "task", kind: "action", title: "Unique task", notes: null, parentKey: null, dueDate: null, scheduledDate: null, notBeforeDate: null, notBeforeAt: null, reminders: [], needsClarification: false, relatedCalendarKeys: ["event"], enabled: true, ownerMemberId: null },
    ], [{
      key: "event", title: "Appointment", description: null, location: null, allDay: false,
      startDate: null, endDate: null, startDateTime: "2026-10-01T10:00:00+02:00", endDateTime: "2026-10-01T11:00:00+02:00",
      relatedWorkKeys: ["task"], enabled: true, durationAssumed: false,
    }]);
    ctx.handle.db.update(schema.intakeJobs).set({
      planJson: JSON.stringify({
        summary: "Source",
        calendarEvents: d.calendarEvents,
        workItems: d.workItems,
        warnings: [],
      }),
    }).where(eq(schema.intakeJobs.id, setup.id)).run();
    await applyIntake(ctx.handle.db, env(ctx.dataDir), undefined, signal, setup.id, { expectedRevision: setup.revision, draft: d }, { actorMemberId: setup.member.id }, setup.member.id);
    const first = ctx.handle.db.select().from(schema.homeAssistantRequests).where(eq(schema.homeAssistantRequests.kind, "calendar_create")).get()!;
    const firstJob = ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, setup.id)).get()!;
    const results = JSON.parse(firstJob.applyResultsJson!);
    results.calendar[0]!.status = "failed";
    results.calendar[0]!.error = { code: "calendar_uid_not_recovered", message: "retry", retryable: true };
    ctx.handle.db.update(schema.intakeJobs).set({ status: "partially_applied", applyResultsJson: JSON.stringify(results), revision: firstJob.revision + 1 }).where(eq(schema.intakeJobs.id, setup.id)).run();
    await applyIntake(ctx.handle.db, env(ctx.dataDir), undefined, signal, setup.id, { expectedRevision: firstJob.revision + 1, draft: d }, { actorMemberId: setup.member.id }, setup.member.id);
    const second = ctx.handle.db.select().from(schema.homeAssistantRequests).where(eq(schema.homeAssistantRequests.kind, "calendar_create")).orderBy(schema.homeAssistantRequests.createdAt).all();
    expect(second).toHaveLength(2);
    expect(JSON.parse(second[1]!.payloadJson).correlationId).toBe(JSON.parse(first.payloadJson).correlationId);
    expect(ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.title, "Unique task")).all()).toHaveLength(1);
  });

  it("rejects a second apply with the original revision and creates work once", async () => {
    const setup = await prepare();
    const signal = new HomeAssistantRequestSignal();
    const d = draft([
      { key: "task", kind: "action", title: "Only once", notes: null, parentKey: null, dueDate: null, scheduledDate: null, notBeforeDate: null, notBeforeAt: null, reminders: [], needsClarification: false, relatedCalendarKeys: [], enabled: true, ownerMemberId: null },
    ]);
    const input = { expectedRevision: setup.revision, draft: d };
    await applyIntake(ctx.handle.db, env(ctx.dataDir), undefined, signal, setup.id, input, { actorMemberId: setup.member.id }, setup.member.id);
    await expect(applyIntake(ctx.handle.db, env(ctx.dataDir), undefined, signal, setup.id, input, { actorMemberId: setup.member.id }, setup.member.id))
      .rejects.toThrowError(/not ready|changed since it was read/);
    expect(ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.title, "Only once")).all()).toHaveLength(1);
  });

  it("keeps the originally accepted work when a partial apply is retried with a changed draft", async () => {
    const setup = await prepare();
    const signal = new HomeAssistantRequestSignal();
    const parentDraft = draft([
      { key: "parent", kind: "action", title: "Existing parent", notes: null, parentKey: null, dueDate: null, scheduledDate: null, notBeforeDate: null, notBeforeAt: null, reminders: [], needsClarification: false, relatedCalendarKeys: [], enabled: true, ownerMemberId: null },
    ]);
    await applyIntake(ctx.handle.db, env(ctx.dataDir), undefined, signal, setup.id, { expectedRevision: setup.revision, draft: parentDraft }, { actorMemberId: setup.member.id }, setup.member.id);
    const applied = ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, setup.id)).get()!;
    ctx.handle.db.update(schema.intakeJobs).set({ status: "partially_applied", revision: applied.revision + 1 }).where(eq(schema.intakeJobs.id, setup.id)).run();
    const childDraft = draft([
      ...parentDraft.workItems,
      { key: "child", kind: "action", title: "New child", notes: null, parentKey: "parent", dueDate: null, scheduledDate: null, notBeforeDate: null, notBeforeAt: null, reminders: [], needsClarification: false, relatedCalendarKeys: [], enabled: true, ownerMemberId: null },
    ]);
    const partial = ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, setup.id)).get()!;
    expect(() => updateIntakeDraft(ctx.handle.db, setup.id, setup.member.id, {
      expectedRevision: partial.revision,
      draft: childDraft,
    })).toThrowError(/only be edited before Apply starts/);
    await applyIntake(ctx.handle.db, env(ctx.dataDir), undefined, signal, setup.id, {
      expectedRevision: partial.revision,
      draft: childDraft,
    }, { actorMemberId: setup.member.id }, setup.member.id);
    const parent = ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.title, "Existing parent")).get()!;
    const child = ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.title, "New child")).get();
    expect(child).toBeUndefined();
    expect(parent).toBeDefined();
  });

  it("assigns a work-scope root action to the actor when no owner is selected", async () => {
    const setup = await prepare();
    ctx.handle.db.update(schema.intakeJobs).set({ scope: "work" }).where(eq(schema.intakeJobs.id, setup.id)).run();
    const signal = new HomeAssistantRequestSignal();
    await applyIntake(ctx.handle.db, env(ctx.dataDir), undefined, signal, setup.id, {
      expectedRevision: setup.revision,
      draft: draft([{ key: "task", kind: "action", title: "Owned by actor", notes: null, parentKey: null, dueDate: null, scheduledDate: null, notBeforeDate: null, notBeforeAt: null, reminders: [], needsClarification: false, relatedCalendarKeys: [], enabled: true, ownerMemberId: null }]),
    }, { actorMemberId: setup.member.id }, setup.member.id);
    const task = ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.title, "Owned by actor")).get()!;
    expect(task.ownerMemberId).toBe(setup.member.id);
  });

  it("reports an expired cleanup race as intake_expired", async () => {
    const setup = await prepare();
    ctx.handle.db.update(schema.intakeJobs).set({ expiresAt: new Date(0).toISOString() }).where(eq(schema.intakeJobs.id, setup.id)).run();
    await expect(applyIntake(ctx.handle.db, env(ctx.dataDir), undefined, new HomeAssistantRequestSignal(), setup.id, {
      expectedRevision: setup.revision,
      draft: draft([]),
    }, { actorMemberId: setup.member.id }, setup.member.id)).rejects.toThrowError(/expired/);
  });

  it("recovers an abandoned local apply lease without changing the accepted draft", async () => {
    const setup = await prepare();
    const accepted = draft([
      { key: "task-a", kind: "action", title: "Accepted task A", notes: null, parentKey: null, dueDate: null, scheduledDate: null, notBeforeDate: null, notBeforeAt: null, reminders: [], needsClarification: false, relatedCalendarKeys: [], enabled: true, ownerMemberId: null },
    ]);
    ctx.handle.db.update(schema.intakeJobs).set({
      status: "applying",
      acceptedDraftJson: JSON.stringify(accepted),
      applyClaimToken: "dead-claim",
      applyClaimExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      revision: setup.revision + 1,
    }).where(eq(schema.intakeJobs.id, setup.id)).run();

    const recovered = getIntake(ctx.handle.db, setup.id, setup.member.id);
    expect(recovered.status).toBe("partially_applied");
    expect(recovered.error).toMatchObject({
      code: "intake_apply_partial",
      message: "The previous Apply was interrupted and can be retried.",
    });
    const saved = ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, setup.id)).get()!;
    expect(saved.applyClaimToken).toBeNull();
    expect(saved.applyClaimExpiresAt).toBeNull();
    expect(saved.acceptedDraftJson).toBe(JSON.stringify(accepted));

    await applyIntake(ctx.handle.db, env(ctx.dataDir), undefined, new HomeAssistantRequestSignal(), setup.id, {
      expectedRevision: recovered.revision,
    }, { actorMemberId: setup.member.id }, setup.member.id);
    expect(ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.title, "Accepted task A")).all()).toHaveLength(1);
    const completed = ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, setup.id)).get()!;
    expect(completed.status).toBe("applied");
    expect(completed.acceptedDraftJson).toBe(JSON.stringify(accepted));
  });

  it("directly retries an expired apply claim using its frozen draft and previous revision", async () => {
    const setup = await prepare();
    const accepted = draft([
      { key: "accepted", kind: "action", title: "Recovered accepted task", notes: null, parentKey: null, dueDate: null, scheduledDate: null, notBeforeDate: null, notBeforeAt: null, reminders: [], needsClarification: false, relatedCalendarKeys: [], enabled: true, ownerMemberId: null },
    ]);
    ctx.handle.db.update(schema.intakeJobs).set({
      status: "applying",
      acceptedDraftJson: JSON.stringify(accepted),
      applyClaimToken: "expired-direct-claim",
      applyClaimExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      revision: setup.revision + 1,
    }).where(eq(schema.intakeJobs.id, setup.id)).run();
    const before = ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, setup.id)).get()!;
    const changedDraft = draft([
      { key: "changed", kind: "action", title: "Should not be created", notes: null, parentKey: null, dueDate: null, scheduledDate: null, notBeforeDate: null, notBeforeAt: null, reminders: [], needsClarification: false, relatedCalendarKeys: [], enabled: true, ownerMemberId: null },
    ]);
    await applyIntake(ctx.handle.db, env(ctx.dataDir), undefined, new HomeAssistantRequestSignal(), setup.id, {
      expectedRevision: before.revision,
      draft: changedDraft,
    }, { actorMemberId: setup.member.id }, setup.member.id);
    expect(ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.title, "Recovered accepted task")).all()).toHaveLength(1);
    expect(ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.title, "Should not be created")).all()).toHaveLength(0);
    const completed = ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, setup.id)).get()!;
    expect(completed.status).toBe("applied");
    expect(completed.revision).toBe(before.revision + 3);
    expect(completed.acceptedDraftJson).toBe(JSON.stringify(accepted));
  });

  it("rejects a stale direct retry before recovering an expired claim", async () => {
    const setup = await prepare();
    const accepted = draft([
      { key: "accepted", kind: "action", title: "Not created by stale retry", notes: null, parentKey: null, dueDate: null, scheduledDate: null, notBeforeDate: null, notBeforeAt: null, reminders: [], needsClarification: false, relatedCalendarKeys: [], enabled: true, ownerMemberId: null },
    ]);
    const expiredAt = new Date(Date.now() - 60_000).toISOString();
    ctx.handle.db.update(schema.intakeJobs).set({
      status: "applying",
      acceptedDraftJson: JSON.stringify(accepted),
      applyClaimToken: "expired-stale-claim",
      applyClaimExpiresAt: expiredAt,
      revision: setup.revision + 1,
    }).where(eq(schema.intakeJobs.id, setup.id)).run();

    await expect(applyIntake(ctx.handle.db, env(ctx.dataDir), undefined, new HomeAssistantRequestSignal(), setup.id, {
      expectedRevision: setup.revision,
    }, { actorMemberId: setup.member.id }, setup.member.id)).rejects.toMatchObject({ code: "stale_write_conflict" });
    const unchanged = ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, setup.id)).get()!;
    expect(unchanged).toMatchObject({
      status: "applying",
      revision: setup.revision + 1,
      applyClaimToken: "expired-stale-claim",
      applyClaimExpiresAt: expiredAt,
      acceptedDraftJson: JSON.stringify(accepted),
    });
    expect(unchanged.applyResultsJson).toBeNull();
    expect(ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.title, "Not created by stale retry")).all()).toHaveLength(0);
    expect(ctx.handle.db.select().from(schema.homeAssistantRequests).where(eq(schema.homeAssistantRequests.kind, "calendar_create")).all()).toHaveLength(0);
  });

  it("does not disclose a Paperless failure cause in the Apply API response", async () => {
    await closeTestContext(ctx);
    const secret = "private-paperless-failure-detail-91";
    const paperlessClient: PaperlessClient = {
      upload: async () => { throw new Error(secret); },
      awaitDocumentId: async () => { throw new Error("unexpected document resolution"); },
      getDocument: async () => { throw new Error("unexpected document lookup"); },
      search: async () => ({ results: [], count: 0, next: null, previous: null }),
      thumbnail: async () => ({ contentType: "text/plain", contentLength: 0, filename: null, body: Readable.from([]) }),
      preview: async () => ({ contentType: "text/plain", contentLength: 0, filename: null, body: Readable.from([]) }),
      download: async () => ({ contentType: "text/plain", contentLength: 0, filename: null, body: Readable.from([]) }),
    };
    ctx = createTestContext({ paperlessClient });
    const setup = await prepare();
    const attachmentId = randomUUID();
    const bytes = Buffer.from("Paperless source");
    await writeAttachment(env(ctx.dataDir), setup.id, attachmentId, bytes);
    ctx.handle.db.insert(schema.intakeAttachments).values({
      id: attachmentId,
      intakeJobId: setup.id,
      filename: "source.txt",
      mimeType: "text/plain",
      sizeBytes: bytes.length,
      sha256: "hash",
      createdAt: new Date().toISOString(),
    }).run();
    ctx.handle.db.update(schema.intakeJobs).set({ createdByMemberId: null })
      .where(eq(schema.intakeJobs.id, setup.id)).run();
    const accepted = draft([
      { key: "task", kind: "action", title: "Retain source", notes: null, parentKey: null, dueDate: null, scheduledDate: null, notBeforeDate: null, notBeforeAt: null, reminders: [], needsClarification: false, relatedCalendarKeys: [], enabled: true, ownerMemberId: null },
    ]);
    accepted.retainSourceInPaperless = true;

    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/intake/${setup.id}/apply`,
      payload: { expectedRevision: setup.revision, draft: accepted },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().error).toEqual({
      code: "intake_source_retention_failed",
      message: "The source could not be retained in Paperless.",
    });
    expect(response.body).not.toContain(secret);
    const detail = await ctx.app.inject({ method: "GET", url: `/api/intake/${setup.id}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().status).toBe("ready");
    expect(detail.body).not.toContain(secret);
  });

  it("persists only a generic error for unexpected post-claim failures", async () => {
    const setup = await prepare();
    const unsafeMessage = "sensitive internal detail must not be persisted";
    const calendarDraft = draft([], [{
      key: "event",
      title: "Local apply failure",
      description: null,
      location: null,
      allDay: false,
      startDate: null,
      endDate: null,
      startDateTime: "2026-10-03T10:00:00+02:00",
      endDateTime: "2026-10-03T11:00:00+02:00",
      relatedWorkKeys: [],
      enabled: true,
      durationAssumed: false,
    }]);
    const signal = new HomeAssistantRequestSignal();
    signal.notify = () => { throw new Error(unsafeMessage); };
    const logger = { error: vi.fn() } as unknown as Pick<FastifyBaseLogger, "error">;
    await expect(applyIntake(ctx.handle.db, env(ctx.dataDir), undefined, signal, setup.id, {
      expectedRevision: setup.revision,
      draft: calendarDraft,
    }, { actorMemberId: setup.member.id }, setup.member.id, logger)).rejects.toThrow(unsafeMessage);
    const record = getIntake(ctx.handle.db, setup.id, setup.member.id);
    expect(record.status).toBe("ready");
    expect(record.error).toEqual({
      code: "intake_apply_failed",
      message: "Nothing was applied. Review the proposal and retry.",
      retryable: true,
    });
    expect(JSON.stringify(record.error)).not.toContain(unsafeMessage);
    expect(logger.error).toHaveBeenCalledWith({ err: expect.any(Error) }, "Intake Apply failed.");
  });

  it("does not recover calendar-wait or active local apply states", async () => {
    const waiting = await prepare();
    const waitResults = { work: [], calendar: [{ key: "event", correlationId: "event-correlation", status: "pending", error: null, event: null }], paperlessDocumentIds: [] };
    ctx.handle.db.update(schema.intakeJobs).set({
      status: "applying",
      acceptedDraftJson: JSON.stringify(draft([])),
      applyResultsJson: JSON.stringify(waitResults),
      applyClaimToken: null,
      applyClaimExpiresAt: null,
    }).where(eq(schema.intakeJobs.id, waiting.id)).run();
    expect(getIntake(ctx.handle.db, waiting.id, waiting.member.id).status).toBe("applying");

    const active = await prepare("Jordan");
    ctx.handle.db.update(schema.intakeJobs).set({
      status: "applying",
      acceptedDraftJson: JSON.stringify(draft([])),
      applyClaimToken: "active-claim",
      applyClaimExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    }).where(eq(schema.intakeJobs.id, active.id)).run();
    expect(getIntake(ctx.handle.db, active.id, active.member.id).status).toBe("applying");
    const activeRow = ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, active.id)).get()!;
    expect(activeRow.applyClaimToken).toBe("active-claim");
  });

  it("uses the accepted draft for calendar refs and exposes project refs on project details", async () => {
    const setup = await prepare();
    const signal = new HomeAssistantRequestSignal();
    const d = draft([
      { key: "project", kind: "project", title: "Calendar project", notes: null, parentKey: null, dueDate: null, scheduledDate: null, notBeforeDate: null, notBeforeAt: null, reminders: [], needsClarification: false, relatedCalendarKeys: ["event"], enabled: true, ownerMemberId: setup.member.id },
      { key: "disabled-task", kind: "action", title: "Disabled task", notes: null, parentKey: null, dueDate: null, scheduledDate: null, notBeforeDate: null, notBeforeAt: null, reminders: [], needsClarification: false, relatedCalendarKeys: ["event", "disabled-event"], enabled: false, ownerMemberId: null },
    ], [{
      key: "event", title: "Appointment", description: "Accepted event detail", location: "Library", allDay: false,
      startDate: null, endDate: null, startDateTime: "2026-10-01T10:00:00+02:00", endDateTime: "2026-10-01T11:00:00+02:00",
      relatedWorkKeys: ["project", "disabled-task"], enabled: true, durationAssumed: false,
    }, {
      key: "disabled-event", title: "Disabled event", description: null, location: null, allDay: false,
      startDate: null, endDate: null, startDateTime: "2026-10-02T10:00:00+02:00", endDateTime: "2026-10-02T11:00:00+02:00",
      relatedWorkKeys: ["disabled-task"], enabled: false, durationAssumed: false,
    }]);
    ctx.handle.db.update(schema.intakeJobs).set({
      planJson: JSON.stringify({
        summary: "Source",
        calendarEvents: [{ ...d.calendarEvents[0], relatedWorkKeys: ["disabled-task"] }],
        workItems: [{ ...d.workItems[1], relatedCalendarKeys: ["event"] }],
        warnings: [],
      }),
    }).where(eq(schema.intakeJobs.id, setup.id)).run();
    await applyIntake(ctx.handle.db, env(ctx.dataDir), undefined, signal, setup.id, { expectedRevision: setup.revision, draft: d }, { actorMemberId: setup.member.id }, setup.member.id);
    const accepted = ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, setup.id)).get()!;
    expect(JSON.parse(accepted.acceptedDraftJson!)).toEqual(d);
    expect(accepted.status).toBe("applying");
    expect(accepted.applyClaimToken).toBeNull();
    expect(accepted.applyClaimExpiresAt).toBeNull();
    const requests = ctx.handle.db.select().from(schema.homeAssistantRequests).where(eq(schema.homeAssistantRequests.kind, "calendar_create")).all();
    expect(requests).toHaveLength(1);
    const initialRequest = requests[0]!;
    ctx.handle.db.update(schema.homeAssistantRequests).set({
      status: "leased",
      leaseToken: "failed-attempt",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    }).where(eq(schema.homeAssistantRequests.id, initialRequest.id)).run();
    await ctx.app.inject({
      method: "POST",
      url: `/api/integrations/home-assistant/requests/${initialRequest.id}/complete`,
      headers: { authorization: `Bearer ${setup.token}` },
      payload: {
        leaseToken: "failed-attempt",
        outcome: "failed",
        error: { code: "calendar_create_failed", message: "Retry this accepted event." },
      },
    });
    const failedJob = ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, setup.id)).get()!;
    expect(() => updateIntakeDraft(ctx.handle.db, setup.id, setup.member.id, {
      expectedRevision: failedJob.revision,
      draft: d,
    })).toThrowError(/only be edited before Apply starts/);
    const changedDraft = draft([
      { ...d.workItems[0]!, title: "Changed project", dueDate: null, ownerMemberId: null },
      ...d.workItems.slice(1),
    ], [
      { ...d.calendarEvents[0]!, title: "Changed appointment", description: "Unaccepted", relatedWorkKeys: ["disabled-task"] },
      { ...d.calendarEvents[1]!, enabled: true },
    ]);
    await applyIntake(ctx.handle.db, env(ctx.dataDir), undefined, signal, setup.id, {
      expectedRevision: failedJob.revision,
      draft: changedDraft,
    }, { actorMemberId: setup.member.id }, setup.member.id);
    const retriedRequests = ctx.handle.db.select().from(schema.homeAssistantRequests)
      .where(eq(schema.homeAssistantRequests.kind, "calendar_create")).all();
    expect(retriedRequests).toHaveLength(2);
    const request = retriedRequests[1]!;
    expect(JSON.parse(request.payloadJson)).toMatchObject({
      title: "Appointment",
      description: "Accepted event detail",
      location: "Library",
    });
    const lease = { ...request, leaseToken: "test" };
    ctx.handle.db.update(schema.homeAssistantRequests).set({
      status: "leased",
      leaseToken: lease.leaseToken,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    }).where(eq(schema.homeAssistantRequests.id, request.id)).run();
    const completion = await ctx.app.inject({
      method: "POST",
      url: `/api/integrations/home-assistant/requests/${request.id}/complete`,
      headers: { authorization: `Bearer ${setup.token}` },
      payload: {
        leaseToken: lease.leaseToken,
        outcome: "succeeded",
        result: { calendarEntityId: "calendar.family", uid: "uid-1", recurrenceId: "rec-1", summary: "Appointment", start: "2026-10-01T10:00:00+02:00", end: "2026-10-01T11:00:00+02:00", correlationId: JSON.parse(request.payloadJson).correlationId },
      },
    });
    expect(completion.statusCode, completion.body).toBe(204);
    const completedJob = ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, setup.id)).get()!;
    expect(JSON.parse(completedJob.acceptedDraftJson!)).toEqual(d);
    const project = ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.title, "Calendar project")).get()!;
    const disabledTask = ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.title, "Disabled task")).get();
    const refs = ctx.handle.db.select().from(schema.externalWorkItemRefs).where(eq(schema.externalWorkItemRefs.workItemId, project.id)).all();
    expect(refs).toHaveLength(1);
    expect(refs[0]!.source).toBe("home_assistant_calendar");
    expect(refs[0]!.externalId).toBe("calendar.family:uid-1");
    expect(refs[0]!.metadataJson).toContain("rec-1");
    expect(disabledTask).toBeUndefined();
    expect(project.ownerMemberId).toBe(setup.member.id);
    expect(project.dueDate).toBeNull();
    const projectDetail = await ctx.app.inject({ method: "GET", url: `/api/projects/${project.id}` });
    expect(projectDetail.json().externalRefs).toHaveLength(1);
  });

  it("persists successful Paperless uploads and retries only the failed attachment", async () => {
    const setup = await prepare();
    const existingTask = createTask(ctx.handle.db, {
      title: "Retained",
      notes: "Keep this note\n\n[older document](paperless:10)",
    });
    ctx.handle.db.update(schema.intakeJobs).set({
      applyResultsJson: JSON.stringify({
        work: [{ key: "retention", kind: "action", workItemId: existingTask.id, role: "task" }],
        calendar: [],
        paperlessDocumentIds: [],
      }),
    }).where(eq(schema.intakeJobs.id, setup.id)).run();
    const attachments = [
      { id: randomUUID(), filename: "one.txt", mimeType: "text/plain", data: Buffer.from("one") },
      { id: randomUUID(), filename: "two.txt", mimeType: "text/plain", data: Buffer.from("two") },
    ];
    for (const attachment of attachments) {
      await writeAttachment(env(ctx.dataDir), setup.id, attachment.id, attachment.data);
      ctx.handle.db.insert(schema.intakeAttachments).values({
        id: attachment.id,
        intakeJobId: setup.id,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.data.length,
        sha256: "hash",
        createdAt: new Date().toISOString(),
      }).run();
    }
    const draftWithRetention = draft([
      { key: "retention", kind: "action", title: "Retained", notes: null, parentKey: null, dueDate: null, scheduledDate: null, notBeforeDate: null, notBeforeAt: null, reminders: [], needsClarification: false, relatedCalendarKeys: [], enabled: true, ownerMemberId: null },
    ]);
    draftWithRetention.retainSourceInPaperless = true;
    let uploadCount = 0;
    let acceptedDraftAtUpload: unknown;
    let patchBlockedAfterClaim = false;
    let firstClaimToken: string | null = null;
    let firstClaimExpiry: string | null = null;
    let firstClaimRevision: number | null = null;
    let heartbeatVerified = false;
    const paperless: PaperlessClient = {
      upload: async () => {
        const job = ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, setup.id)).get()!;
        acceptedDraftAtUpload = JSON.parse(job.acceptedDraftJson!);
        if (uploadCount === 0) {
          firstClaimToken = job.applyClaimToken;
          firstClaimExpiry = job.applyClaimExpiresAt;
          firstClaimRevision = job.revision;
        } else {
          heartbeatVerified = job.applyClaimToken === firstClaimToken
            && job.applyClaimExpiresAt !== null
            && job.applyClaimExpiresAt > firstClaimExpiry!
            && job.revision === firstClaimRevision;
        }
        try {
          updateIntakeDraft(ctx.handle.db, setup.id, setup.member.id, {
            expectedRevision: job.revision,
            draft: draft([{ key: "changed", kind: "action", title: "Changed", notes: null, parentKey: null, dueDate: null, scheduledDate: null, notBeforeDate: null, notBeforeAt: null, reminders: [], needsClarification: false, relatedCalendarKeys: [], enabled: true, ownerMemberId: null }]),
          }, { paperlessAvailable: true, hasFiles: true });
        } catch {
          patchBlockedAfterClaim = true;
        }
        return { taskId: `task-${++uploadCount}` };
      },
      awaitDocumentId: async (taskId) => {
        if (taskId === "task-1") return new Promise<number>((resolve) => setTimeout(() => resolve(101), 10));
        if (taskId === "task-2" && uploadCount === 2) throw new Error("temporary failure");
        return taskId === "task-1" ? 101 : 202;
      },
      getDocument: async (id) => ({ id, title: `doc-${id}`, originalFileName: `doc-${id}.txt`, mimeType: "text/plain" }),
      search: async () => ({ results: [], count: 0, next: null, previous: null }),
      thumbnail: async () => ({ contentType: "text/plain", contentLength: 0, filename: null, body: Readable.from([]) }),
      preview: async () => ({ contentType: "text/plain", contentLength: 0, filename: null, body: Readable.from([]) }),
      download: async () => ({ contentType: "text/plain", contentLength: 0, filename: null, body: Readable.from([]) }),
    };
    const signal = new HomeAssistantRequestSignal();
    await expect(applyIntake(ctx.handle.db, env(ctx.dataDir), paperless, signal, setup.id, {
      expectedRevision: setup.revision,
      draft: draftWithRetention,
    }, { actorMemberId: setup.member.id }, setup.member.id)).rejects.toThrow();
    expect(uploadCount).toBe(2);
    expect(acceptedDraftAtUpload).toEqual(draftWithRetention);
    expect(patchBlockedAfterClaim).toBe(true);
    expect(heartbeatVerified).toBe(true);
    const partial = ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, setup.id)).get()!;
    expect(partial.status).toBe("partially_applied");
    expect(partial.status === "ready" && partial.acceptedDraftJson !== null).toBe(false);
    expect(partial.applyClaimToken).toBeNull();
    expect(partial.applyClaimExpiresAt).toBeNull();
    expect(JSON.parse(partial.applyResultsJson!).paperlessDocumentIds).toEqual([101]);
    expect(JSON.parse(partial.acceptedDraftJson!)).toEqual(draftWithRetention);
    expect(partial.acceptedDraftJson).not.toBeNull();
    expect(() => updateIntakeDraft(ctx.handle.db, setup.id, setup.member.id, {
      expectedRevision: partial.revision,
      draft: draftWithRetention,
    })).toThrowError(/only be edited before Apply starts/);
    const changedRetryDraft = draft([
      { key: "changed", kind: "action", title: "Changed during retry", notes: null, parentKey: null, dueDate: "2026-12-31", scheduledDate: null, notBeforeDate: null, notBeforeAt: null, reminders: [], needsClarification: false, relatedCalendarKeys: [], enabled: true, ownerMemberId: setup.member.id },
    ]);
    await applyIntake(ctx.handle.db, env(ctx.dataDir), paperless, signal, setup.id, {
      expectedRevision: partial.revision,
      draft: changedRetryDraft,
    }, { actorMemberId: setup.member.id }, setup.member.id);
    expect(uploadCount).toBe(3);
    expect(ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.title, "Retained")).all()).toHaveLength(1);
    expect(ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.title, "Changed during retry")).get()).toBeUndefined();
    const retained = ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.id, existingTask.id)).get()!;
    expect(retained.notes).toContain("Keep this note");
    expect(retained.notes).toContain("paperless:10");
    expect(retained.notes).toContain("paperless:101");
    expect(retained.notes.match(/paperless:101/g)).toHaveLength(1);
    expect(retained.notes.match(/paperless:202/g)).toHaveLength(1);
    const completed = ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, setup.id)).get()!;
    expect(JSON.parse(completed.acceptedDraftJson!)).toEqual(draftWithRetention);
  });

  it("retains Paperless references on a project target", async () => {
    const setup = await prepare();
    const project = createProject(ctx.handle.db, { title: "Paperless project", notes: "Existing project note" });
    const attachmentId = randomUUID();
    await writeAttachment(env(ctx.dataDir), setup.id, attachmentId, Buffer.from("source"));
    ctx.handle.db.insert(schema.intakeAttachments).values({
      id: attachmentId,
      intakeJobId: setup.id,
      filename: "source.txt",
      mimeType: "text/plain",
      sizeBytes: 6,
      sha256: "hash",
      createdAt: new Date().toISOString(),
    }).run();
    let uploads = 0;
    const paperless: PaperlessClient = {
      upload: async () => ({ taskId: `upload-${++uploads}` }),
      awaitDocumentId: async () => 303,
      getDocument: async (id) => ({ id, title: "source", originalFileName: "source.txt", mimeType: "text/plain" }),
      search: async () => ({ results: [], count: 0, next: null, previous: null }),
      thumbnail: async () => ({ contentType: "text/plain", contentLength: 0, filename: null, body: Readable.from([]) }),
      preview: async () => ({ contentType: "text/plain", contentLength: 0, filename: null, body: Readable.from([]) }),
      download: async () => ({ contentType: "text/plain", contentLength: 0, filename: null, body: Readable.from([]) }),
    };
    const acceptedDraft = draft([
      { key: "project", kind: "project", title: "Paperless project", notes: null, parentKey: null, dueDate: null, scheduledDate: null, notBeforeDate: null, notBeforeAt: null, reminders: [], needsClarification: false, relatedCalendarKeys: [], enabled: true, ownerMemberId: null },
    ]);
    acceptedDraft.retainSourceInPaperless = true;
    ctx.handle.db.update(schema.intakeJobs).set({
      applyResultsJson: JSON.stringify({
        work: [{ key: "project", kind: "project", workItemId: project.id, role: "story" }],
        calendar: [],
        paperlessDocumentIds: [],
      }),
    }).where(eq(schema.intakeJobs.id, setup.id)).run();
    await applyIntake(ctx.handle.db, env(ctx.dataDir), paperless, new HomeAssistantRequestSignal(), setup.id, {
      expectedRevision: setup.revision,
      draft: acceptedDraft,
    }, { actorMemberId: setup.member.id }, setup.member.id);
    const retained = ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.id, project.id)).get()!;
    expect(uploads).toBe(1);
    expect(retained.notes).toContain("Existing project note");
    expect(retained.notes).toContain("paperless:303");
  });
});
