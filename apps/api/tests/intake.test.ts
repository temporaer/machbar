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

  it("keeps semantic conflicts reviewable and sends them when reanalyzing", async () => {
    const token = await pairAndSnapshot();
    const id = await createIntake(token);
    const request = await lease(token);
    const conflicted = {
      ...validPlan,
      workItems: [{
        ...validPlan.workItems[0],
        needsClarification: true,
        reminders: [{ kind: "absolute", at: "2026-10-01T08:00:00+02:00" }],
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
    expect(instructions).toContain("captured_reminder");
    expect(instructions).toContain("Bitte Konflikte korrigieren.");
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
