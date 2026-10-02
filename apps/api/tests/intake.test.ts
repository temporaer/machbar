import { existsSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema.js";
import { purgeExpiredIntakes } from "../src/intake/jobs.js";
import { updateIntakeDraft } from "../src/intake/jobs.js";
import {
  closeTestContext,
  createTestContext,
  type TestContext,
} from "./helpers.js";

const validPlan = {
  summary: "Elternabend",
  calendarEvents: [],
  workItems: [{
    key: "task",
    kind: "action",
    title: "Zettel abgeben",
    notes: null,
    parentKey: null,
    ownerName: null,
    dueDate: null,
    scheduledDate: null,
    notBeforeDate: null,
    notBeforeAt: null,
    reminders: [],
    needsClarification: false,
    relatedCalendarKeys: [],
  }],
  warnings: [],
};

function multipart(parts: Array<{ name: string; value?: string; filename?: string; type?: string; data?: Buffer }>) {
  const boundary = "----machbarIntakeTest";
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const disposition = part.filename
      ? `form-data; name="${part.name}"; filename="${part.filename}"`
      : `form-data; name="${part.name}"`;
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: ${disposition}\r\n`));
    if (part.filename) chunks.push(Buffer.from(`Content-Type: ${part.type}\r\n`));
    chunks.push(Buffer.from("\r\n"));
    chunks.push(part.data ?? Buffer.from(part.value ?? ""));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { boundary, body: Buffer.concat(chunks) };
}

describe("intake lifecycle", () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = createTestContext(); });
  afterEach(async () => { await closeTestContext(ctx); });

  async function pairAndSnapshot(aiState: "ok" | "not_configured" = "ok", supportsAttachments = true) {
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
          aiTask: { entityId: aiState === "ok" ? "ai_task.test" : null, state: aiState, supportsAttachments },
          calendar: { entityId: "calendar.test", state: "ok" },
        },
      },
    });
    return token;
  }

  async function createIntake(token?: string, file = false) {
    const image = await sharp({
      create: { width: 1, height: 1, channels: 3, background: { r: 255, g: 0, b: 0 } },
    }).png().toBuffer();
    const body = multipart(file
      ? [{ name: "text", value: "Bitte prüfen" }, { name: "files", filename: "note.png", type: "image/png", data: image }]
      : [{ name: "text", value: "Bitte prüfen" }]);
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/intake",
      headers: { "content-type": `multipart/form-data; boundary=${body.boundary}`, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      payload: body.body,
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().id as string;
  }

  async function lease(token: string) {
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/integrations/home-assistant/requests/next?protocolVersion=3&waitSeconds=0",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    return response.json() as { id: string; leaseToken: string };
  }

  it("creates text and image intakes with one analysis request", async () => {
    const token = await pairAndSnapshot();
    const textId = await createIntake(token);
    const textRequest = ctx.handle.db.select().from(schema.homeAssistantRequests)
      .where(eq(schema.homeAssistantRequests.intakeJobId, textId)).get()!;
    expect(textRequest.kind).toBe("intake_analyze");
    expect(JSON.parse(textRequest.payloadJson)).toMatchObject({
      text: "Bitte prüfen",
      instructions: expect.stringContaining("Europe/Berlin"),
      attachments: [],
    });
    const imageId = await createIntake(token, true);
    const imageRequest = ctx.handle.db.select().from(schema.homeAssistantRequests)
      .where(eq(schema.homeAssistantRequests.intakeJobId, imageId)).get()!;
    expect(JSON.parse(imageRequest.payloadJson).attachments).toHaveLength(1);
    expect(readdirSync(`${ctx.dataDir}/intake/${imageId}`)).toHaveLength(1);
  });

  it("sends text files as bounded UTF-8 source text, not as AI Task attachments", async () => {
    await pairAndSnapshot();
    const textFile = { name: "files", filename: "meeting.txt", type: "text/plain", data: Buffer.from("Bring the forms.", "utf8") };
    const textOnly = multipart([textFile]);
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/intake",
      headers: { "content-type": `multipart/form-data; boundary=${textOnly.boundary}` },
      payload: textOnly.body,
    });
    expect(response.statusCode, response.body).toBe(201);
    const textRequest = ctx.handle.db.select().from(schema.homeAssistantRequests)
      .where(eq(schema.homeAssistantRequests.intakeJobId, response.json().id)).get()!;
    expect(JSON.parse(textRequest.payloadJson)).toMatchObject({
      text: "SOURCE FILE: meeting.txt\n<<<\nBring the forms.\n>>>",
      attachments: [],
    });

    const pdf = { name: "files", filename: "agenda.pdf", type: "application/pdf", data: Buffer.from("%PDF-test") };
    const mixed = multipart([textFile, pdf]);
    const mixedResponse = await ctx.app.inject({
      method: "POST",
      url: "/api/intake",
      headers: { "content-type": `multipart/form-data; boundary=${mixed.boundary}` },
      payload: mixed.body,
    });
    expect(mixedResponse.statusCode, mixedResponse.body).toBe(201);
    const mixedRequest = ctx.handle.db.select().from(schema.homeAssistantRequests)
      .where(eq(schema.homeAssistantRequests.intakeJobId, mixedResponse.json().id)).get()!;
    expect(JSON.parse(mixedRequest.payloadJson)).toMatchObject({
      text: "SOURCE FILE: meeting.txt\n<<<\nBring the forms.\n>>>",
      attachments: [expect.objectContaining({ filename: "agenda.pdf", mimeType: "application/pdf" })],
    });
  });

  it("rejects invalid UTF-8 and text beyond the source safety limit", async () => {
    await pairAndSnapshot();
    for (const [data, expectedCode, expectedMessage] of [
      [Buffer.from([0xc3, 0x28]), "intake_file_rejected", "not valid UTF-8"],
      [Buffer.from("x".repeat(20_001)), "intake_file_too_large", "20,000 character limit"],
    ] as const) {
      const body = multipart([{ name: "files", filename: "source.txt", type: "text/plain", data }]);
      const response = await ctx.app.inject({
        method: "POST",
        url: "/api/intake",
        headers: { "content-type": `multipart/form-data; boundary=${body.boundary}` },
        payload: body.body,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe(expectedCode);
      expect(response.json().error.message).toContain(expectedMessage);
      if (expectedCode === "intake_file_rejected") {
        expect(response.json().error.details.reason).toBe("invalid_utf8");
      }
    }
  });

  it("normalizes intake images to a useful long edge", async () => {
    await pairAndSnapshot();
    const image = await sharp({
      create: { width: 3200, height: 1800, channels: 3, background: { r: 20, g: 80, b: 120 } },
    }).png().toBuffer();
    const body = multipart([{ name: "files", filename: "large.png", type: "image/png", data: image }]);
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/intake",
      headers: { "content-type": `multipart/form-data; boundary=${body.boundary}` },
      payload: body.body,
    });
    expect(response.statusCode, response.body).toBe(201);
    const intakeId = response.json().id as string;
    const attachment = ctx.handle.db.select().from(schema.intakeAttachments)
      .where(eq(schema.intakeAttachments.intakeJobId, intakeId)).get()!;
    expect(attachment.mimeType).toBe("image/jpeg");
    const storedImage = await import("node:fs/promises").then(({ readFile }) =>
      readFile(`${ctx.dataDir}/intake/${intakeId}/${attachment.id}`));
    const metadata = await sharp(storedImage).metadata();
    expect(Math.max(metadata.width ?? 0, metadata.height ?? 0)).toBe(2048);
    expect(Math.min(metadata.width ?? 0, metadata.height ?? 0)).toBe(1152);
  });

  it("requires text or a file and surfaces capability failures", async () => {
    const empty = multipart([]);
    const emptyResponse = await ctx.app.inject({
      method: "POST",
      url: "/api/intake",
      headers: { "content-type": `multipart/form-data; boundary=${empty.boundary}` },
      payload: empty.body,
    });
    expect(emptyResponse.statusCode).toBe(400);
    await pairAndSnapshot("not_configured");
    const textBody = multipart([{ name: "text", value: "x" }]);
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/intake",
      headers: { "content-type": `multipart/form-data; boundary=${textBody.boundary}` },
      payload: textBody.body,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("ai_task_not_configured");
  });

  it("completes valid analysis, rejects invalid analysis, and retries without new attachments", async () => {
    const token = await pairAndSnapshot();
    const id = await createIntake(token, true);
    const request = await lease(token);
    await ctx.app.inject({
      method: "POST",
      url: `/api/integrations/home-assistant/requests/${request.id}/complete`,
      headers: { authorization: `Bearer ${token}` },
      payload: { leaseToken: request.leaseToken, outcome: "succeeded", result: { nope: true } },
    });
    const failed = ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, id)).get()!;
    expect(failed.status).toBe("analysis_failed");
    expect(JSON.parse(failed.errorJson!).code).toBe("intake_plan_invalid");
    expect(JSON.parse(failed.errorJson!).details.issues[0]).toMatchObject({
      path: ["summary"],
      code: "schema_invalid",
    });
    const retry = await ctx.app.inject({
      method: "POST",
      url: `/api/intake/${id}/retry`,
      payload: { hint: "Bitte den vollständigen Plan mit den fehlenden Feldern zurückgeben." },
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().retryHint).toContain("vollständigen Plan");
    const retryRequest = ctx.handle.db.select().from(schema.homeAssistantRequests)
      .where(eq(schema.homeAssistantRequests.intakeJobId, id)).orderBy(schema.homeAssistantRequests.createdAt).all()[1]!;
    expect(JSON.parse(retryRequest.payloadJson).instructions).toContain("schema_invalid");
    expect(JSON.parse(retryRequest.payloadJson).instructions).toContain("vollständigen Plan");
    expect(ctx.handle.db.select().from(schema.homeAssistantRequests)
      .where(eq(schema.homeAssistantRequests.intakeJobId, id)).all()).toHaveLength(2);
    expect(readdirSync(`${ctx.dataDir}/intake/${id}`)).toHaveLength(1);
  });

  it("keeps malformed nonempty dates reviewable with an actionable issue", async () => {
    const token = await pairAndSnapshot();
    const id = await createIntake(token);
    const request = await lease(token);
    const malformed = {
      ...validPlan,
      workItems: [{ ...validPlan.workItems[0], dueDate: "not-a-date" }],
    };
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/integrations/home-assistant/requests/${request.id}/complete`,
      headers: { authorization: `Bearer ${token}` },
      payload: { leaseToken: request.leaseToken, outcome: "succeeded", result: malformed },
    });
    expect(response.statusCode, response.body).toBe(204);
    const record = await ctx.app.inject({ method: "GET", url: `/api/intake/${id}` });
    expect(record.json().status).toBe("ready");
    expect(record.json().draft.workItems[0].dueDate).toBe("not-a-date");
    expect(record.json().error).toBeNull();
  });

  it("repairs long keys on AI completion and keeps plan relationships intact", async () => {
    const token = await pairAndSnapshot();
    const id = await createIntake(token);
    const request = await lease(token);
    const source = {
      summary: "Long keys",
      calendarEvents: [{
        key: "calendar-kur-haushaltshilfe-2026-10-05-26",
        title: "Termin",
        allDay: true,
        startDate: "2026-10-05",
        endDate: "2026-10-05",
        relatedWorkKeys: ["Child Task with a very long generated identity"],
      }],
      workItems: [{
        key: "Project with a very long generated identity",
        kind: "project",
        title: "Project",
      }, {
        key: "Child Task with a very long generated identity",
        kind: "action",
        title: "Task",
        parentKey: "Project with a very long generated identity",
        relatedCalendarKeys: ["calendar-kur-haushaltshilfe-2026-10-05-26"],
      }],
      warnings: [],
    };
    const completion = await ctx.app.inject({
      method: "POST",
      url: `/api/integrations/home-assistant/requests/${request.id}/complete`,
      headers: { authorization: "Bearer " + token },
      payload: { leaseToken: request.leaseToken, outcome: "succeeded", result: source },
    });

    expect(completion.statusCode, completion.body).toBe(204);
    const record = await ctx.app.inject({ method: "GET", url: `/api/intake/${id}` });
    expect(record.json().status).toBe("ready");
    const storedJob = ctx.handle.db.select().from(schema.intakeJobs)
      .where(eq(schema.intakeJobs.id, id)).get()!;
    const { calendarEvents, workItems } = JSON.parse(storedJob.planJson!) as typeof source;
    const calendarKey = calendarEvents[0]!.key;
    const projectKey = workItems[0]!.key;
    const taskKey = workItems[1]!.key;
    expect([calendarKey, projectKey, taskKey].every((key) =>
      /^[a-z0-9][a-z0-9_-]{0,39}$/.test(key),
    )).toBe(true);
    expect(calendarEvents[0]!.relatedWorkKeys).toEqual([taskKey]);
    expect(workItems[1]!.parentKey).toBe(projectKey);
    expect(workItems[1]!.relatedCalendarKeys).toEqual([calendarKey]);
  });

  it("reports the received type for structurally rejected contract fields", async () => {
    const token = await pairAndSnapshot();
    const id = await createIntake(token);
    const request = await lease(token);
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/integrations/home-assistant/requests/${request.id}/complete`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        leaseToken: request.leaseToken,
        outcome: "succeeded",
        result: {
          ...validPlan,
          workItems: [{ ...validPlan.workItems[0], dueDate: 42 }],
        },
      },
    });
    expect(response.statusCode, response.body).toBe(204);
    const failed = ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, id)).get()!;
    expect(failed.status).toBe("analysis_failed");
    expect(JSON.parse(failed.errorJson!).details.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: ["workItems", 0, "dueDate"],
        message: expect.stringContaining("Received number"),
      }),
    ]));
  });

  it("becomes reviewable without mutating work before apply", async () => {
    const token = await pairAndSnapshot();
    const id = await createIntake(token);
    const request = await lease(token);
    await ctx.app.inject({
      method: "POST",
      url: `/api/integrations/home-assistant/requests/${request.id}/complete`,
      headers: { authorization: `Bearer ${token}` },
      payload: { leaseToken: request.leaseToken, outcome: "succeeded", result: validPlan },
    });

    const record = await ctx.app.inject({ method: "GET", url: `/api/intake/${id}` });
    expect(record.statusCode).toBe(200);
    expect(record.json().status).toBe("ready");
    expect(ctx.handle.db.select().from(schema.workItems).all()).toHaveLength(0);
    expect(ctx.handle.db.select().from(schema.homeAssistantRequests)
      .where(eq(schema.homeAssistantRequests.kind, "calendar_create")).all()).toHaveLength(0);
  });

  it("normalizes draft payloads before structural validation and preserves review state", async () => {
    const token = await pairAndSnapshot();
    const id = await createIntake(token);
    const request = await lease(token);
    await ctx.app.inject({
      method: "POST",
      url: `/api/integrations/home-assistant/requests/${request.id}/complete`,
      headers: { authorization: "Bearer " + token },
      payload: { leaseToken: request.leaseToken, outcome: "succeeded", result: validPlan },
    });
    const record = await ctx.app.inject({ method: "GET", url: `/api/intake/${id}` });
    const response = await ctx.app.inject({
      method: "PATCH",
      url: `/api/intake/${id}/plan`,
      payload: {
        expectedRevision: record.json().revision,
        draft: {
          summary: "Draft",
          calendarEvents: null,
          workItems: [{
            key: "project",
            kind: "project",
            title: "Project",
            notes: null,
            parentKey: null,
            dueDate: "2026-10-10",
            scheduledDate: null,
            notBeforeDate: 42,
            notBeforeAt: {},
            reminders: { malformed: true },
            needsClarification: true,
            relatedCalendarKeys: null,
            enabled: false,
            ownerMemberId: 7,
          }],
          warnings: null,
          retainSourceInPaperless: false,
        },
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().draft).toMatchObject({
      calendarEvents: [],
      warnings: [{ message: "Ignored task-only fields on project 'project'." }],
      workItems: [{
        dueDate: "2026-10-10",
        notBeforeDate: null,
        notBeforeAt: null,
        reminders: [],
        needsClarification: false,
        relatedCalendarKeys: [],
        enabled: false,
        ownerMemberId: 7,
      }],
    });
  });

  it("keeps semantic conflicts reviewable and sends them when reanalyzing", async () => {
    const token = await pairAndSnapshot();
    const id = await createIntake(token);
    const request = await lease(token);
    const conflicted = {
      ...validPlan,
      workItems: [{
        ...validPlan.workItems[0],
        needsClarification: true,
        reminders: [{ kind: "absolute", at: "not-a-date" }],
      }],
    };
    await ctx.app.inject({
      method: "POST",
      url: `/api/integrations/home-assistant/requests/${request.id}/complete`,
      headers: { authorization: `Bearer ${token}` },
      payload: { leaseToken: request.leaseToken, outcome: "succeeded", result: conflicted },
    });
    const ready = await ctx.app.inject({ method: "GET", url: `/api/intake/${id}` });
    expect(ready.json().status).toBe("ready");
    expect(ready.json().error).toBeNull();
    expect(ready.json().draft.workItems[0].reminders).toHaveLength(1);
    const retry = await ctx.app.inject({
      method: "POST",
      url: `/api/intake/${id}/retry`,
      payload: { hint: "Bitte Konflikte korrigieren." },
    });
    expect(retry.statusCode).toBe(200);
    const retryRequest = ctx.handle.db.select().from(schema.homeAssistantRequests)
      .where(eq(schema.homeAssistantRequests.intakeJobId, id)).orderBy(schema.homeAssistantRequests.createdAt).all()[1]!;
    const instructions = JSON.parse(retryRequest.payloadJson).instructions as string;
    expect(instructions).toContain("invalid_datetime");
    expect(instructions).toContain("Bitte Konflikte korrigieren.");
  });

  it("reprocesses a valid proposal with context and retains it until replacement succeeds", async () => {
    const token = await pairAndSnapshot();
    const id = await createIntake(token, true);
    const firstRequest = await lease(token);
    const originalPlan = {
      ...validPlan,
      summary: "Current proposal",
      workItems: [
        { ...validPlan.workItems[0]!, key: "first", title: "First task" },
        { ...validPlan.workItems[0]!, key: "second", title: "Second task" },
      ],
    };
    await ctx.app.inject({
      method: "POST",
      url: `/api/integrations/home-assistant/requests/${firstRequest.id}/complete`,
      headers: { authorization: "Bearer " + token },
      payload: { leaseToken: firstRequest.leaseToken, outcome: "succeeded", result: originalPlan },
    });
    const initialRecord = await ctx.app.inject({ method: "GET", url: `/api/intake/${id}` });
    expect(initialRecord.json().status).toBe("ready");

    const retry = await ctx.app.inject({
      method: "POST",
      url: `/api/intake/${id}/retry`,
      payload: { hint: "Combine the first two tasks." },
    });
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json().status).toBe("queued");
    expect(retry.json().draft).toEqual(initialRecord.json().draft);
    const retryRequest = ctx.handle.db.select().from(schema.homeAssistantRequests)
      .where(eq(schema.homeAssistantRequests.intakeJobId, id)).orderBy(schema.homeAssistantRequests.createdAt).all()[1]!;
    const retryPayload = JSON.parse(retryRequest.payloadJson);
    expect(retryPayload.text).toContain("Bitte prüfen");
    expect(retryPayload.attachments).toHaveLength(1);
    expect(retryPayload.instructions).toContain("Combine the first two tasks.");
    expect(retryPayload.instructions).toContain("=== CURRENT PROPOSAL CONTEXT (ordered; not a patch) ===");
    expect(retryPayload.instructions.indexOf('"title": "First task"'))
      .toBeLessThan(retryPayload.instructions.indexOf('"title": "Second task"'));
    expect(retryPayload.instructions).not.toContain("=== VALIDATION FEEDBACK ===");

    const failedRequest = await lease(token);
    await ctx.app.inject({
      method: "POST",
      url: `/api/integrations/home-assistant/requests/${failedRequest.id}/complete`,
      headers: { authorization: "Bearer " + token },
      payload: {
        leaseToken: failedRequest.leaseToken,
        outcome: "failed",
        error: { code: "ai_task_failed", message: "Temporary analysis failure." },
      },
    });
    const failedRecord = await ctx.app.inject({ method: "GET", url: `/api/intake/${id}` });
    expect(failedRecord.json().status).toBe("analysis_failed");
    expect(failedRecord.json().draft).toEqual(initialRecord.json().draft);

    const secondRetry = await ctx.app.inject({
      method: "POST",
      url: `/api/intake/${id}/retry`,
      payload: { hint: "Keep the event unchanged." },
    });
    expect(secondRetry.statusCode).toBe(200);
    expect(secondRetry.json().draft).toEqual(initialRecord.json().draft);
    const replacementRequest = await lease(token);
    const replacementPlan = {
      ...originalPlan,
      summary: "Replacement proposal",
      workItems: [{
        ...originalPlan.workItems[0]!,
        title: "Combined task",
      }],
    };
    await ctx.app.inject({
      method: "POST",
      url: `/api/integrations/home-assistant/requests/${replacementRequest.id}/complete`,
      headers: { authorization: "Bearer " + token },
      payload: {
        leaseToken: replacementRequest.leaseToken,
        outcome: "succeeded",
        result: replacementPlan,
      },
    });
    const replacedRecord = await ctx.app.inject({ method: "GET", url: `/api/intake/${id}` });
    expect(replacedRecord.json().status).toBe("ready");
    expect(replacedRecord.json().draft.summary).toBe("Replacement proposal");
    expect(replacedRecord.json().draft.workItems.map((item: { title: string }) => item.title))
      .toEqual(["Combined task"]);
  });

  it("does not report Paperless unavailable when retrying a retained valid draft", async () => {
    await closeTestContext(ctx);
    ctx = createTestContext({
      paperless: { baseUrl: "https://paperless.example", apiToken: "token" },
    });
    const token = await pairAndSnapshot();
    const id = await createIntake(token, true);
    const request = await lease(token);
    await ctx.app.inject({
      method: "POST",
      url: `/api/integrations/home-assistant/requests/${request.id}/complete`,
      headers: { authorization: "Bearer " + token },
      payload: { leaseToken: request.leaseToken, outcome: "succeeded", result: validPlan },
    });
    const ready = await ctx.app.inject({ method: "GET", url: `/api/intake/${id}` });
    const draft = ready.json().draft;
    draft.retainSourceInPaperless = true;
    const updated = await ctx.app.inject({
      method: "PATCH",
      url: `/api/intake/${id}/plan`,
      payload: { expectedRevision: ready.json().revision, draft },
    });
    expect(updated.statusCode, updated.body).toBe(200);

    await ctx.app.inject({
      method: "POST",
      url: `/api/intake/${id}/retry`,
      payload: { hint: "Move that reminder to Friday." },
    });
    const retryRequest = ctx.handle.db.select().from(schema.homeAssistantRequests)
      .where(eq(schema.homeAssistantRequests.intakeJobId, id)).orderBy(schema.homeAssistantRequests.createdAt).all()[1]!;
    const instructions = JSON.parse(retryRequest.payloadJson).instructions as string;
    expect(instructions).toContain("Move that reminder to Friday.");
    expect(instructions).toContain("=== CURRENT PROPOSAL CONTEXT (ordered; not a patch) ===");
    expect(instructions).not.toContain("paperless_unavailable");
  });

  it("reports Paperless unavailable for retained drafts when it is not configured", async () => {
    const token = await pairAndSnapshot();
    const id = await createIntake(token, true);
    const request = await lease(token);
    await ctx.app.inject({
      method: "POST",
      url: `/api/integrations/home-assistant/requests/${request.id}/complete`,
      headers: { authorization: "Bearer " + token },
      payload: { leaseToken: request.leaseToken, outcome: "succeeded", result: validPlan },
    });
    const ready = await ctx.app.inject({ method: "GET", url: `/api/intake/${id}` });
    const draft = ready.json().draft;
    draft.retainSourceInPaperless = true;
    const updated = await ctx.app.inject({
      method: "PATCH",
      url: `/api/intake/${id}/plan`,
      payload: { expectedRevision: ready.json().revision, draft },
    });
    expect(updated.statusCode, updated.body).toBe(200);

    await ctx.app.inject({
      method: "POST",
      url: `/api/intake/${id}/retry`,
      payload: { hint: "Keep the task unchanged." },
    });
    const retryRequest = ctx.handle.db.select().from(schema.homeAssistantRequests)
      .where(eq(schema.homeAssistantRequests.intakeJobId, id)).orderBy(schema.homeAssistantRequests.createdAt).all()[1]!;
    expect(JSON.parse(retryRequest.payloadJson).instructions).toContain("paperless_unavailable");
  });

  it("includes HA normalization details in retry feedback", async () => {
    const token = await pairAndSnapshot();
    const id = await createIntake(token);
    const request = await lease(token);
    await ctx.app.inject({
      method: "POST",
      url: `/api/integrations/home-assistant/requests/${request.id}/complete`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        leaseToken: request.leaseToken,
        outcome: "failed",
        error: {
          code: "ai_task_invalid_response",
          message: "Invalid AI Task response.",
          details: { path: ["workItems", 1, "reminders"], expectedType: "an array of reminder objects" },
        },
      },
    });
    const retry = await ctx.app.inject({
      method: "POST",
      url: `/api/intake/${id}/retry`,
      payload: {},
    });
    expect(retry.statusCode).toBe(200);
    const retryRequest = ctx.handle.db.select().from(schema.homeAssistantRequests)
      .where(eq(schema.homeAssistantRequests.intakeJobId, id)).orderBy(schema.homeAssistantRequests.createdAt).all()[1]!;
    const instructions = JSON.parse(retryRequest.payloadJson).instructions as string;
    expect(instructions).toContain("workItems[1].reminders");
    expect(instructions).toContain("schema_invalid");
    expect(instructions).toContain("an array of reminder objects");
  });

  it("rejects a second draft update using the same revision", async () => {
    const token = await pairAndSnapshot();
    const id = await createIntake(token);
    const request = await lease(token);
    await ctx.app.inject({
      method: "POST",
      url: `/api/integrations/home-assistant/requests/${request.id}/complete`,
      headers: { authorization: `Bearer ${token}` },
      payload: { leaseToken: request.leaseToken, outcome: "succeeded", result: validPlan },
    });
    const record = (await ctx.app.inject({ method: "GET", url: `/api/intake/${id}` })).json();
    updateIntakeDraft(ctx.handle.db, id, null, { expectedRevision: record.revision, draft: record.draft });
    expect(() => updateIntakeDraft(ctx.handle.db, id, null, { expectedRevision: record.revision, draft: record.draft }))
      .toThrowError(/changed since it was read/);
  });

  it("purges expired jobs, files, and requests", async () => {
    const token = await pairAndSnapshot();
    const id = await createIntake(token, true);
    const jobPath = `${ctx.dataDir}/intake/${id}`;
    ctx.handle.db.update(schema.intakeJobs).set({
      expiresAt: new Date(0).toISOString(),
    }).where(eq(schema.intakeJobs.id, id)).run();
    await purgeExpiredIntakes(ctx.handle.db, { dataDir: ctx.dataDir } as never);
    expect(ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, id)).get()).toBeUndefined();
    expect(existsSync(jobPath)).toBe(false);
    expect(ctx.handle.db.select().from(schema.homeAssistantRequests)
      .where(eq(schema.homeAssistantRequests.intakeJobId, id)).all()).toHaveLength(0);
  });
});
