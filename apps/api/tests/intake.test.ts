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
    reminderAt: null,
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
      payload: { pairingCode: code, protocolVersion: 2 },
    });
    const token = paired.json().token as string;
    await ctx.app.inject({
      method: "POST",
      url: "/api/integrations/home-assistant/context",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        protocolVersion: 2,
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
      url: "/api/integrations/home-assistant/requests/next?protocolVersion=2&waitSeconds=0",
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
    expect(JSON.parse(failed.errorJson!).code).toBe("ai_task_invalid_response");
    const retry = await ctx.app.inject({ method: "POST", url: `/api/intake/${id}/retry` });
    expect(retry.statusCode).toBe(200);
    expect(ctx.handle.db.select().from(schema.homeAssistantRequests)
      .where(eq(schema.homeAssistantRequests.intakeJobId, id)).all()).toHaveLength(2);
    expect(readdirSync(`${ctx.dataDir}/intake/${id}`)).toHaveLength(1);
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
