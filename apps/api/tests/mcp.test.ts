import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACTIVITY_ACTOR_HEADER } from "@machbar/shared";
import * as schema from "../src/db/schema.js";
import { createMachbarMcpServer } from "../src/mcp/tools.js";
import {
  closeTestContext,
  createTestContext,
  insertTestTask,
  type TestContext,
} from "./helpers.js";

describe("MCP integration", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await closeTestContext(ctx);
  });

  async function createMember(name = "Mira") {
    return (
      await ctx.app.inject({
        method: "POST",
        url: "/api/members",
        payload: { name },
      })
    ).json() as { id: number };
  }

  it("creates a scoped token, stores only its hash, and revokes it", async () => {
    const member = await createMember();
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/integrations/mcp/agents",
      headers: { [ACTIVITY_ACTOR_HEADER]: String(member.id) },
      payload: { name: "Copilot work", scope: "work" },
    });

    expect(created.statusCode).toBe(201);
    const body = created.json() as {
      token: string;
      endpoint: string;
      agent: { id: number; memberId: number; scope: string };
    };
    expect(body).toMatchObject({
      endpoint: "/api/mcp",
      agent: { memberId: member.id, scope: "work" },
    });
    const stored = ctx.handle.db.select().from(schema.mcpAgents).get()!;
    expect(stored.tokenHash).not.toContain(body.token);

    const initialized = await ctx.app.inject({
      method: "POST",
      url: "/api/mcp",
      headers: {
        authorization: `Bearer ${body.token}`,
        accept: "application/json, text/event-stream",
      },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      },
    });
    expect(initialized.statusCode).toBe(200);
    expect(initialized.json().result.serverInfo.name).toBe("machbar");

    const revoked = await ctx.app.inject({
      method: "DELETE",
      url: `/api/integrations/mcp/agents/${body.agent.id}`,
      headers: { [ACTIVITY_ACTOR_HEADER]: String(member.id) },
    });
    expect(revoked.statusCode).toBe(204);
    expect(
      (
        await ctx.app.inject({
          method: "POST",
          url: "/api/mcp",
          headers: {
            authorization: `Bearer ${body.token}`,
            accept: "application/json, text/event-stream",
          },
          payload: {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/list",
            params: {},
          },
        })
      ).statusCode,
    ).toBe(401);
  });

  it("enforces the agent scope for reads, creates, and mutations", async () => {
    const member = await createMember();
    const otherMember = await createMember("Alex");
    const householdTask = insertTestTask(ctx.handle.db, {
      title: "Clean kitchen",
    });
    const workTask = insertTestTask(ctx.handle.db, {
      title: "Prepare report",
      scope: "work",
      ownerMemberId: member.id,
      ownerInheritanceMode: "explicit",
    });

    const server = createMachbarMcpServer({
      db: ctx.handle.db,
      memberId: member.id,
      scope: "work",
    });
    const client = new Client({ name: "test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const search = await client.callTool({
      name: "machbar_search",
      arguments: { includeTerminal: true },
    });
    expect(search.structuredContent).toEqual({
      result: [expect.objectContaining({ id: workTask.id, scope: "work" })],
    });

    const created = await client.callTool({
      name: "machbar_create_task",
      arguments: {
        title: "Work-only task",
        status: "actionable",
        ownerMemberId: otherMember.id,
      },
    });
    expect(created.structuredContent).toEqual({
      result: expect.objectContaining({
        scope: "work",
        effectiveOwnerId: member.id,
      }),
    });

    const cancelled = await client.callTool({
      name: "machbar_cancel_task",
      arguments: {
        taskId: workTask.id,
        expectedRevision: workTask.revision,
      },
    });
    expect(cancelled.structuredContent).toEqual({
      result: expect.objectContaining({
        id: workTask.id,
        status: "cancelled",
      }),
    });

    const forbidden = await client.callTool({
      name: "machbar_complete_task",
      arguments: {
        taskId: householdTask.id,
        expectedRevision: householdTask.revision,
      },
    });
    expect(forbidden.isError).toBe(true);
    const unchanged = (
      await ctx.app.inject({
        method: "GET",
        url: `/api/tasks/${householdTask.id}`,
      })
    ).json();
    expect(unchanged.status).toBe("actionable");

    await client.close();
    await server.close();
  });
});
