import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema.js";
import {
  closeTestContext,
  createTestContext,
  type TestContext,
} from "./helpers.js";

const plan = {
  summary: "Test",
  calendarEvents: [],
  workItems: [{
    key: "task",
    kind: "action",
    title: "Test task",
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

describe("Home Assistant reverse request bridge", () => {
  let ctx: TestContext;

  beforeEach(() => { ctx = createTestContext(); });
  afterEach(async () => { await closeTestContext(ctx); });

  async function pair(protocolVersion = 3) {
    const code = (await ctx.app.inject({
      method: "POST",
      url: "/api/integrations/home-assistant/pairing-code",
    })).json().code as string;
    return ctx.app.inject({
      method: "POST",
      url: "/api/integrations/home-assistant/pair",
      payload: { pairingCode: code, protocolVersion },
    });
  }

  async function configuredToken() {
    const response = await pair();
    expect(response.statusCode).toBe(200);
    const token = response.json().token as string;
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
    return token;
  }

  async function queueIntake() {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/intake",
      headers: { "content-type": "multipart/form-data; boundary=----test" },
      payload: Buffer.from(
        "------test\r\nContent-Disposition: form-data; name=\"text\"\r\n\r\nhello\r\n------test--\r\n",
      ),
    });
    expect(response.statusCode).toBe(201);
    return response.json().id as string;
  }

  it("leases queued requests and completes them with the lease token", async () => {
    const token = await configuredToken();
    await queueIntake();
    const leased = await ctx.app.inject({
      method: "GET",
      url: "/api/integrations/home-assistant/requests/next?protocolVersion=3&waitSeconds=0",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(leased.statusCode).toBe(200);
    expect(leased.json()).toMatchObject({ kind: "intake_analyze" });
    const requestId = leased.json().id as string;
    const completion = await ctx.app.inject({
      method: "POST",
      url: `/api/integrations/home-assistant/requests/${requestId}/complete`,
      headers: { authorization: `Bearer ${token}` },
      payload: { leaseToken: leased.json().leaseToken, outcome: "succeeded", result: plan },
    });
    expect(completion.statusCode).toBe(204);
    expect(ctx.handle.db.select().from(schema.homeAssistantRequests)
      .where(eq(schema.homeAssistantRequests.id, requestId)).get()?.status).toBe("succeeded");
  });

  it("re-leases an expired request with a new token", async () => {
    const token = await configuredToken();
    await queueIntake();
    const first = await ctx.app.inject({
      method: "GET",
      url: "/api/integrations/home-assistant/requests/next?protocolVersion=3&waitSeconds=0",
      headers: { authorization: `Bearer ${token}` },
    });

    const id = first.json().id as string;
    ctx.handle.db.update(schema.homeAssistantRequests).set({
      leaseExpiresAt: new Date(0).toISOString(),
    }).where(eq(schema.homeAssistantRequests.id, id)).run();
    const second = await ctx.app.inject({
      method: "GET",
      url: "/api/integrations/home-assistant/requests/next?protocolVersion=3&waitSeconds=0",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(id);
    expect(second.json().leaseToken).not.toBe(first.json().leaseToken);
    expect(ctx.handle.db.select().from(schema.homeAssistantRequests)
      .where(eq(schema.homeAssistantRequests.id, id)).get()?.attempts).toBe(2);
  });

  it("returns 204 on a short empty long-poll", async () => {
    const token = await configuredToken();
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/integrations/home-assistant/requests/next?protocolVersion=3&waitSeconds=0.01",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(204);
  });

  it("rejects missing, wrong, and revoked credentials", async () => {
    const token = await configuredToken();
    const url = "/api/integrations/home-assistant/requests/next?protocolVersion=3&waitSeconds=0";
    expect((await ctx.app.inject({ method: "GET", url })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: "GET", url, headers: { authorization: "Bearer wrong" } })).statusCode).toBe(401);
    expect((await ctx.app.inject({
      method: "DELETE",
      url: "/api/integrations/home-assistant/connection",
      headers: { authorization: `Bearer ${token}` },
    })).statusCode).toBe(204);
    expect((await ctx.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
  });

  it("requires protocol v3 for pairing and request polling", async () => {
    expect((await pair(1)).statusCode).toBe(400);
    const token = await configuredToken();
    expect((await ctx.app.inject({
      method: "GET",
      url: "/api/integrations/home-assistant/requests/next?protocolVersion=1&waitSeconds=0",
      headers: { authorization: `Bearer ${token}` },
    })).statusCode).toBe(400);
  });

  it("rejects completion after the lease expires", async () => {
    const token = await configuredToken();
    await queueIntake();
    const first = await ctx.app.inject({
      method: "GET",
      url: "/api/integrations/home-assistant/requests/next?protocolVersion=3&waitSeconds=0",
      headers: { authorization: `Bearer ${token}` },
    });
    const id = first.json().id as string;
    ctx.handle.db.update(schema.homeAssistantRequests).set({
      leaseExpiresAt: new Date(0).toISOString(),
    }).where(eq(schema.homeAssistantRequests.id, id)).run();
    const completion = await ctx.app.inject({
      method: "POST",
      url: `/api/integrations/home-assistant/requests/${id}/complete`,
      headers: { authorization: `Bearer ${token}` },
      payload: { leaseToken: first.json().leaseToken, outcome: "succeeded", result: plan },
    });
    expect(completion.statusCode).toBe(409);
    const reLeased = await ctx.app.inject({
      method: "GET",
      url: "/api/integrations/home-assistant/requests/next?protocolVersion=3&waitSeconds=0",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(reLeased.statusCode).toBe(200);
    expect(reLeased.json().id).toBe(id);
  });

  it("protects attachment downloads with the active lease and confined paths", async () => {
    const token = await configuredToken();
    const boundary = "----attachment";
    const body = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="note.txt"\r\nContent-Type: text/plain\r\n\r\nattachment bytes\r\n--${boundary}--\r\n`,
    );
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/intake",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(created.statusCode).toBe(201);
    const jobId = created.json().id as string;
    const attachment = ctx.handle.db.select().from(schema.intakeAttachments)
      .where(eq(schema.intakeAttachments.intakeJobId, jobId)).get()!;
    const leased = await ctx.app.inject({
      method: "GET",
      url: "/api/integrations/home-assistant/requests/next?protocolVersion=3&waitSeconds=0",
      headers: { authorization: `Bearer ${token}` },
    });
    const download = await ctx.app.inject({
      method: "GET",
      url: `/api/integrations/home-assistant/intake/${jobId}/attachments/${attachment.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toContain("text/plain");
    expect(download.body).toBe("attachment bytes");
    expect((await ctx.app.inject({
      method: "GET",
      url: `/api/integrations/home-assistant/intake/${jobId}/attachments/${encodeURIComponent("../x")}`,
      headers: { authorization: `Bearer ${token}` },
    })).statusCode).toBe(404);
    expect((await ctx.app.inject({
      method: "GET",
      url: `/api/integrations/home-assistant/intake/unknown/attachments/${attachment.id}`,
      headers: { authorization: `Bearer ${token}` },
    })).statusCode).toBe(404);
    expect((await ctx.app.inject({
      method: "GET",
      url: `/api/integrations/home-assistant/intake/${jobId}/attachments/${attachment.id}`,
    })).statusCode).toBe(401);
    expect(leased.statusCode).toBe(200);
  });
});
