import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACTIVITY_ACTOR_HEADER } from "@machbar/shared";
import * as schema from "../src/db/schema.js";
import { createMachbarMcpServer } from "../src/mcp/tools.js";
import {
  closeTestContext,
  createTestContext,
  insertTestProject,
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

  async function connectMcp(memberId: number, scope: "household" | "work" = "household") {
    const server = createMachbarMcpServer({
      db: ctx.handle.db,
      memberId,
      scope,
    });
    const client = new Client({ name: "test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return { client, server };
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
  it("keeps household ownership shared unless the model supplies a member id", async () => {
    const authenticated = await createMember();
    const owner = await createMember("Alex");
    const project = insertTestProject(ctx.handle.db, {
      title: "Owned project",
      ownerMemberId: owner.id,
    });
    const parent = insertTestTask(ctx.handle.db, {
      title: "Owned parent",
      ownerMemberId: owner.id,
      ownerInheritanceMode: "explicit",
    });
    const inherited = insertTestTask(ctx.handle.db, {
      title: "Inherited child",
      parentTaskId: parent.id,
      ownerInheritanceMode: "inherit",
    });
    const { client, server } = await connectMcp(authenticated.id);

    const shared = await client.callTool({
      name: "machbar_create_task",
      arguments: {
        title: "Shared child",
        projectId: project.id,
        status: "actionable",
      },
    });
    expect(shared.structuredContent).toEqual({
      result: expect.objectContaining({
        ownerMemberId: null,
        ownerInheritanceMode: "none",
        effectiveOwnerId: null,
      }),
    });
    const sharedUnderParent = await client.callTool({
      name: "machbar_create_task",
      arguments: {
        title: "Shared nested child",
        parentTaskId: parent.id,
        status: "actionable",
      },
    });
    expect(sharedUnderParent.structuredContent).toEqual({
      result: expect.objectContaining({
        ownerMemberId: null,
        ownerInheritanceMode: "none",
        effectiveOwnerId: null,
      }),
    });

    const explicitlyOwned = await client.callTool({
      name: "machbar_create_task",
      arguments: {
        title: "Alex child",
        projectId: project.id,
        ownerMemberId: owner.id,
        status: "actionable",
      },
    });
    expect(explicitlyOwned.structuredContent).toEqual({
      result: expect.objectContaining({
        ownerMemberId: owner.id,
        ownerInheritanceMode: "explicit",
        effectiveOwnerId: owner.id,
      }),
    });

    const members = await client.callTool({
      name: "machbar_list_members",
      arguments: {},
    });
    expect(members.structuredContent).toEqual({
      result: expect.arrayContaining([
        expect.objectContaining({
          id: authenticated.id,
          name: "Mira",
          isAuthenticatedMember: true,
        }),
        expect.objectContaining({
          id: owner.id,
          name: "Alex",
          isAuthenticatedMember: false,
        }),
      ]),
    });

    const byOwner = await client.callTool({
      name: "machbar_search",
      arguments: { ownerId: owner.id },
    });
    expect(JSON.stringify(byOwner.structuredContent)).toContain(
      `"id":${explicitlyOwned.structuredContent &&
        (explicitlyOwned.structuredContent as { result: { id: number } }).result.id}`,
    );
    expect(JSON.stringify(byOwner.structuredContent)).toContain(
      `"id":${inherited.id}`,
    );
    expect(JSON.stringify(byOwner.structuredContent)).not.toContain(
      `"id":${(shared.structuredContent as { result: { id: number } }).result.id}`,
    );

    const sharedTasks = await client.callTool({
      name: "machbar_search",
      arguments: { ownerId: null },
    });
    expect(JSON.stringify(sharedTasks.structuredContent)).toContain(
      `"id":${(shared.structuredContent as { result: { id: number } }).result.id}`,
    );

    const explicitlyOwnedTask = (
      explicitlyOwned.structuredContent as {
        result: { id: number; revision: number };
      }
    ).result;
    const unchangedOwner = await client.callTool({
      name: "machbar_update_task",
      arguments: {
        taskId: explicitlyOwnedTask.id,
        expectedRevision: explicitlyOwnedTask.revision,
        priority: 1,
      },
    });
    expect(unchangedOwner.structuredContent).toEqual({
      result: expect.objectContaining({
        ownerMemberId: owner.id,
        effectiveOwnerId: owner.id,
      }),
    });
    const clearedOwner = await client.callTool({
      name: "machbar_update_task",
      arguments: {
        taskId: explicitlyOwnedTask.id,
        expectedRevision: (
          unchangedOwner.structuredContent as { result: { revision: number } }
        ).result.revision,
        ownerMemberId: null,
      },
    });
    expect(clearedOwner.structuredContent).toEqual({
      result: expect.objectContaining({
        ownerMemberId: null,
        ownerInheritanceMode: "none",
        effectiveOwnerId: null,
      }),
    });

    const invalidOwner = await client.callTool({
      name: "machbar_create_task",
      arguments: {
        title: "Invalid owner",
        ownerMemberId: 99999,
        status: "actionable",
      },
    });
    expect(invalidOwner.isError).toBe(true);
    expect(JSON.stringify(invalidOwner.content)).toContain(
      "requested member was not found",
    );

    await client.close();
    await server.close();
  });

  it("filters Today by a selected household member and validates calendar dates", async () => {
    const authenticated = await createMember();
    const other = await createMember("Alex");
    const ownTask = insertTestTask(ctx.handle.db, {
      title: "Mira agenda",
      ownerMemberId: authenticated.id,
      ownerInheritanceMode: "explicit",
      dueDate: "2026-09-21",
    });
    insertTestTask(ctx.handle.db, {
      title: "Alex agenda",
      ownerMemberId: other.id,
      ownerInheritanceMode: "explicit",
      dueDate: "2026-09-21",
    });
    const { client, server } = await connectMcp(authenticated.id);

    const today = await client.callTool({
      name: "machbar_today",
      arguments: { date: "2026-09-21", memberId: authenticated.id },
    });
    expect(JSON.stringify(today.structuredContent)).toContain(
      `"id":${ownTask.id}`,
    );
    expect(JSON.stringify(today.structuredContent)).not.toContain(
      `"title":"Alex agenda"`,
    );

    const invalid = await client.callTool({
      name: "machbar_today",
      arguments: { date: "2026-09-21T17:00:00+02:00" },
    });
    expect(invalid.isError).toBe(true);
    expect(JSON.stringify(invalid.content)).toContain("YYYY-MM-DD");

    const invalidSearch = await client.callTool({
      name: "machbar_search",
      arguments: { dueFrom: "2026-09-21T17:00:00+02:00" },
    });
    expect(invalidSearch.isError).toBe(true);

    const invalidCreate = await client.callTool({
      name: "machbar_create_task",
      arguments: {
        title: "Must not be created",
        status: "actionable",
        dueDate: "2026-09-21T17:00:00+02:00",
      },
    });
    expect(invalidCreate.isError).toBe(true);
    const afterInvalidCreate = await client.callTool({
      name: "machbar_search",
      arguments: { text: "Must not be created", includeTerminal: true },
    });
    expect(
      (afterInvalidCreate.structuredContent as { result: unknown[] }).result,
    ).toEqual([]);

    const invalidScheduledCreate = await client.callTool({
      name: "machbar_create_task",
      arguments: {
        title: "Must not be scheduled",
        status: "actionable",
        scheduledDate: "2026-09-21T17:00:00+02:00",
      },
    });
    expect(invalidScheduledCreate.isError).toBe(true);

    await client.close();
    await server.close();
  });

  it("manages reminders through canonical task updates with stable ids", async () => {
    const member = await createMember();
    const { client, server } = await connectMcp(member.id);

    const created = await client.callTool({
      name: "machbar_create_task",
      arguments: {
        title: "Call the dentist",
        status: "actionable",
        reminders: [
          {
            at: "2026-09-21T08:00:00+02:00",
          },
        ],
      },
    });
    const createdTask = (
      created.structuredContent as {
        result: { id: number; revision: number; reminders: Array<{ id: number }> };
      }
    ).result;
    expect(createdTask.reminders).toHaveLength(1);
    const originalReminderId = createdTask.reminders[0]!.id;

    const added = await client.callTool({
      name: "machbar_manage_reminder",
      arguments: {
        taskId: createdTask.id,
        expectedRevision: createdTask.revision,
        operation: "add",
        at: "2026-09-22T08:00:00+02:00",
      },
    });
    const addedTask = (
      added.structuredContent as {
        result: {
          revision: number;
          reminders: Array<{ id: number; kind: string }>;
        };
      }
    ).result;
    expect(addedTask.reminders).toHaveLength(2);
    const addedReminderId = addedTask.reminders.find(
      ({ id }) => id !== originalReminderId,
    )!.id;

    const updated = await client.callTool({
      name: "machbar_manage_reminder",
      arguments: {
        taskId: createdTask.id,
        expectedRevision: addedTask.revision,
        operation: "update",
        reminderId: addedReminderId,
        at: "2026-09-22T08:30:00+02:00",
      },
    });
    const updatedTask = (
      updated.structuredContent as {
        result: { revision: number; reminders: Array<{ id: number; kind: string }> };
      }
    ).result;
    expect(updatedTask.reminders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: addedReminderId,
          kind: "absolute",
          at: "2026-09-22T06:30:00.000Z",
        }),
        expect.objectContaining({ id: originalReminderId, kind: "absolute" }),
      ]),
    );

    const removed = await client.callTool({
      name: "machbar_manage_reminder",
      arguments: {
        taskId: createdTask.id,
        expectedRevision: updatedTask.revision,
        operation: "remove",
        reminderId: originalReminderId,
      },
    });
    expect(
      (removed.structuredContent as { result: { reminders: unknown[] } }).result
        .reminders,
    ).toEqual([
      expect.objectContaining({
        id: addedReminderId,
        kind: "absolute",
        at: "2026-09-22T06:30:00.000Z",
      }),
    ]);

    const captured = await client.callTool({
      name: "machbar_create_task",
      arguments: {
        title: "Inbox reminder",
        reminders: [{ at: "2026-09-21T08:00:00Z" }],
      },
    });
    expect(captured.isError).toBe(true);
    expect(JSON.stringify(captured.content)).toContain("captured");

    await client.close();
    await server.close();
  });

  it("publishes single-shape absolute reminder schemas for Home Assistant", async () => {
    const member = await createMember();
    const { client, server } = await connectMcp(member.id);
    const listed = await client.listTools();
    const createTool = listed.tools.find(
      ({ name }) => name === "machbar_create_task",
    );
    const manageTool = listed.tools.find(
      ({ name }) => name === "machbar_manage_reminder",
    );

    expect(createTool).toBeDefined();
    expect(manageTool).toBeDefined();
    const createReminderSchema = (
      createTool!.inputSchema.properties as Record<string, unknown>
    ).reminders;
    const manageReminderSchema = (
      manageTool!.inputSchema.properties as Record<string, unknown>
    ).at;
    const schemas = JSON.stringify({
      createReminderSchema,
      manageReminderSchema,
    });
    expect(schemas).not.toContain("anyOf");
    expect(schemas).not.toContain("oneOf");
    expect(createReminderSchema).toMatchObject({
      type: "array",
      items: {
        type: "object",
        properties: {
          at: { type: "string" },
        },
        required: ["at"],
      },
    });
    expect(manageReminderSchema).toMatchObject({ type: "string" });

    await client.close();
    await server.close();
  });
});
