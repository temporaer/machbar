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
      result: {
        items: [
          expect.objectContaining({
            id: workTask.id,
            effectiveOwnerId: member.id,
          }),
        ],
        returned: 1,
        truncated: false,
      },
    });

    const created = await client.callTool({
      name: "machbar_create_task",
      arguments: {
        title: "Work-only task",
        activateIfReady: true,
        ownerMemberId: otherMember.id,
      },
    });
    expect(created.structuredContent).toEqual({
      result: expect.objectContaining({
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

  it("selects the initial task status without exposing the status enum", async () => {
    const authenticated = await createMember();
    const project = insertTestProject(ctx.handle.db, {
      title: "Metadata project",
    });
    const context = ctx.handle.db
      .insert(schema.physicalContexts)
      .values({
        source: "home_assistant",
        externalId: "zone.home",
        name: "Home",
        active: true,
      })
      .returning()
      .get();
    const { client, server } = await connectMcp(authenticated.id);

    const listed = await client.listTools();
    const createTool = listed.tools.find(
      ({ name }) => name === "machbar_create_task",
    );
    expect(createTool).toBeDefined();
    const properties = createTool!.inputSchema.properties as Record<
      string,
      { type?: string }
    >;
    expect(properties.activateIfReady).toMatchObject({ type: "boolean" });
    expect(createTool!.inputSchema.required ?? []).not.toContain(
      "activateIfReady",
    );
    expect(properties.status).toBeUndefined();
    const activateSchema = JSON.stringify(properties.activateIfReady);
    expect(activateSchema).not.toContain("oneOf");
    expect(activateSchema).not.toContain("anyOf");

    const omitted = await client.callTool({
      name: "machbar_create_task",
      arguments: { title: "Inbox by default" },
    });
    expect(omitted.structuredContent).toEqual({
      result: expect.objectContaining({ status: "captured" }),
    });

    const explicitFalse = await client.callTool({
      name: "machbar_create_task",
      arguments: { title: "Inbox explicitly", activateIfReady: false },
    });
    expect(explicitFalse.structuredContent).toEqual({
      result: expect.objectContaining({ status: "captured" }),
    });

    const actionable = await client.callTool({
      name: "machbar_create_task",
      arguments: {
        title: "Buy milk",
        activateIfReady: true,
        projectId: project.id,
        dueDate: "2026-09-21",
        contextIds: [context.id],
      },
    });
    const actionableTask = (
      actionable.structuredContent as {
        result: {
          id: number;
          status: string;
          projectId: number | null;
          dueDate: string | null;
        };
      }
    ).result;
    expect(actionableTask).toMatchObject({
      status: "actionable",
      projectId: project.id,
      dueDate: "2026-09-21",
    });

    const detailed = await client.callTool({
      name: "machbar_get_task",
      arguments: { taskId: actionableTask.id },
    });
    expect(detailed.structuredContent).toEqual({
      result: expect.objectContaining({
        status: "actionable",
        projectId: project.id,
        dueDate: "2026-09-21",
        explicitContexts: [
          expect.objectContaining({ id: context.id, name: "Home" }),
        ],
      }),
    });

    const recurringParent = insertTestTask(ctx.handle.db, {
      title: "Recurring parent",
      repeatAfterDays: 7,
      scheduledDate: "2026-09-20",
      dueDate: "2026-09-21",
    });
    const rejected = await client.callTool({
      name: "machbar_create_task",
      arguments: {
        title: "Must not be created under recurring parent",
        parentTaskId: recurringParent.id,
        activateIfReady: true,
      },
    });
    expect(rejected.isError).toBe(true);

    const afterRejected = await client.callTool({
      name: "machbar_search",
      arguments: {
        text: "Must not be created under recurring parent",
        includeTerminal: true,
      },
    });
    const afterRejectedItems = (
      afterRejected.structuredContent as {
        result: { items: Array<{ id: number; title: string }> };
      }
    ).result.items;
    expect(
      afterRejectedItems.find(
        (item) => item.title === "Must not be created under recurring parent",
      ),
    ).toBeUndefined();
    expect(afterRejectedItems.filter((item) => item.id === recurringParent.id)).toHaveLength(1);

    await client.close();
    await server.close();
  });

  it("bounds broad MCP responses and keeps drill-down details explicit", async () => {
    const member = await createMember();
    const project = insertTestProject(ctx.handle.db, {
      title: "Compact project",
      notes: "Project notes should only appear in drill-down.",
      status: "active",
    });
    const { client, server } = await connectMcp(member.id);

    for (let index = 0; index < 12; index += 1) {
      insertTestTask(ctx.handle.db, {
        title: `Compact task ${index}`,
        notes: "Task notes should only appear in drill-down.",
        projectId: project.id,
        dueDate: "2026-09-15",
      });
    }

    const defaultSearch = await client.callTool({
      name: "machbar_search",
      arguments: { text: "Compact task", includeTerminal: true },
    });
    const defaultSearchResult = (
      defaultSearch.structuredContent as {
        result: {
          items: Array<{ id: number; revision: number } & Record<string, unknown>>;
          returned: number;
          truncated: boolean;
        };
      }
    ).result;
    expect(defaultSearchResult.returned).toBe(10);
    expect(defaultSearchResult.truncated).toBe(true);
    expect(defaultSearchResult.items[0]).not.toHaveProperty("notes");
    expect(defaultSearchResult.items[0]).not.toHaveProperty("reminders");
    expect(defaultSearchResult.items[0]).not.toHaveProperty("ancestors");
    expect(defaultSearchResult.items[0]).not.toHaveProperty("blockers");
    expect(defaultSearchResult.items[0]).not.toHaveProperty("children");
    expect(defaultSearchResult.items[0]).not.toHaveProperty("effectiveTags");

    const limitedSearch = await client.callTool({
      name: "machbar_search",
      arguments: { text: "Compact task", limit: 3 },
    });
    expect(
      (limitedSearch.structuredContent as {
        result: { items: unknown[]; returned: number; truncated: boolean };
      }).result,
    ).toMatchObject({ returned: 3, truncated: true });
    expect(
      (limitedSearch.structuredContent as {
        result: { items: unknown[] };
      }).result.items,
    ).toHaveLength(3);

    insertTestTask(ctx.handle.db, { title: "LexicalLimit" });
    const strongest = insertTestTask(ctx.handle.db, {
      title: "LexicalLimit exact phrase",
    });
    const rankedLimitedSearch = await client.callTool({
      name: "machbar_search",
      arguments: { text: "LexicalLimit exact phrase", limit: 1 },
    });
    expect(
      (
        rankedLimitedSearch.structuredContent as {
          result: { items: Array<{ id: number }> };
        }
      ).result.items,
    ).toEqual([expect.objectContaining({ id: strongest.id })]);

    const invalidLimit = await client.callTool({
      name: "machbar_search",
      arguments: { limit: 26 },
    });
    expect(invalidLimit.isError).toBe(true);

    const projects = await client.callTool({
      name: "machbar_list_projects",
      arguments: {},
    });
    const projectSummary = (
      projects.structuredContent as {
        result: { items: Array<Record<string, unknown>> };
      }
    ).result.items[0]!;
    expect(projectSummary).toMatchObject({
      id: project.id,
      title: "Compact project",
    });
    expect(projectSummary).not.toHaveProperty("tasks");
    expect(projectSummary).not.toHaveProperty("childStories");
    expect(projectSummary).not.toHaveProperty("notes");
    expect(projectSummary).not.toHaveProperty("ancestors");

    insertTestProject(ctx.handle.db, { title: "Another compact project" });
    const limitedProjects = await client.callTool({
      name: "machbar_list_projects",
      arguments: { limit: 1 },
    });
    expect(
      (limitedProjects.structuredContent as {
        result: { items: unknown[]; truncated: boolean };
      }).result,
    ).toMatchObject({ truncated: true });
    expect(
      (limitedProjects.structuredContent as {
        result: { items: unknown[] };
      }).result.items,
    ).toHaveLength(1);
    const invalidProjectLimit = await client.callTool({
      name: "machbar_list_projects",
      arguments: { limit: 51 },
    });
    expect(invalidProjectLimit.isError).toBe(true);

    const today = await client.callTool({
      name: "machbar_today",
      arguments: { date: "2026-09-15" },
    });
    const todayResult = (today.structuredContent as {
      result: { dueToday: Array<Record<string, unknown>> };
    }).result;
    expect(todayResult.dueToday[0]).not.toHaveProperty("notes");
    expect(todayResult.dueToday[0]).not.toHaveProperty("reminders");
    expect(todayResult.dueToday[0]).not.toHaveProperty("ancestors");

    const taskId = defaultSearchResult.items[0]!.id;
    const waitingMutation = await client.callTool({
      name: "machbar_set_waiting",
      arguments: {
        taskId,
        expectedRevision: defaultSearchResult.items[0]!.revision,
        waitingFor: "a reply",
      },
    });
    expect(waitingMutation.structuredContent).toEqual({
      result: expect.objectContaining({ revision: expect.any(Number) }),
    });
    const waiting = await client.callTool({
      name: "machbar_waiting",
      arguments: {},
    });
    const waitingResult = (waiting.structuredContent as {
      result: Array<{ task: Record<string, unknown> }>;
    }).result;
    expect(waitingResult[0]!.task).not.toHaveProperty("notes");
    expect(waitingResult[0]!.task).not.toHaveProperty("reminders");
    const review = await client.callTool({
      name: "machbar_review",
      arguments: {},
    });
    expect((review.structuredContent as { result: unknown[] }).result[0]).not.toHaveProperty(
      "notes",
    );

    const detailedTask = await client.callTool({
      name: "machbar_get_task",
      arguments: { taskId },
    });
    expect(detailedTask.structuredContent).toEqual({
      result: expect.objectContaining({
        notes: "Task notes should only appear in drill-down.",
        ancestors: expect.any(Array),
      }),
    });
    const detailedProject = await client.callTool({
      name: "machbar_get_project",
      arguments: { projectId: project.id },
    });
    expect(detailedProject.structuredContent).toEqual({
      result: expect.objectContaining({
        notes: "Project notes should only appear in drill-down.",
        tasks: expect.any(Array),
      }),
    });

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
        activateIfReady: true,
      },
    });
    expect(shared.structuredContent).toEqual({
      result: expect.objectContaining({
        effectiveOwnerId: null,
      }),
    });
    const sharedUnderParent = await client.callTool({
      name: "machbar_create_task",
      arguments: {
        title: "Shared nested child",
        parentTaskId: parent.id,
        activateIfReady: true,
      },
    });
    expect(sharedUnderParent.structuredContent).toEqual({
      result: expect.objectContaining({
        effectiveOwnerId: null,
      }),
    });

    const explicitlyOwned = await client.callTool({
      name: "machbar_create_task",
      arguments: {
        title: "Alex child",
        projectId: project.id,
        ownerMemberId: owner.id,
        activateIfReady: true,
      },
    });
    expect(explicitlyOwned.structuredContent).toEqual({
      result: expect.objectContaining({
        effectiveOwnerId: owner.id,
      }),
    });

    const members = await client.callTool({
      name: "machbar_list_members",
      arguments: {},
    });
    expect(members.structuredContent).toEqual({
      result: expect.arrayContaining([
        { id: authenticated.id, name: "Mira" },
        { id: owner.id, name: "Alex" },
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
        effectiveOwnerId: null,
      }),
    });

    const invalidOwner = await client.callTool({
      name: "machbar_create_task",
      arguments: {
        title: "Invalid owner",
        ownerMemberId: 99999,
        activateIfReady: true,
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
        activateIfReady: true,
        dueDate: "2026-09-21T17:00:00+02:00",
      },
    });
    expect(invalidCreate.isError).toBe(true);
    const afterInvalidCreate = await client.callTool({
      name: "machbar_search",
      arguments: { text: "Must not be created", includeTerminal: true },
    });
    expect(
      (
        afterInvalidCreate.structuredContent as {
          result: { items: unknown[] };
        }
      ).result.items,
    ).toEqual([]);

    const invalidScheduledCreate = await client.callTool({
      name: "machbar_create_task",
      arguments: {
        title: "Must not be scheduled",
        activateIfReady: true,
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
        activateIfReady: true,
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

  it("supports scoped project creation, updates, waits, notes, and active contexts", async () => {
    const authenticated = await createMember();
    const owner = await createMember("Alex");
    const context = ctx.handle.db
      .insert(schema.physicalContexts)
      .values({
        source: "home_assistant",
        externalId: "zone.home",
        name: "Home",
        active: true,
      })
      .returning()
      .get();
    const inactiveContext = ctx.handle.db
      .insert(schema.physicalContexts)
      .values({
        source: "home_assistant",
        externalId: "zone.garage",
        name: "Garage",
        active: false,
      })
      .returning()
      .get();
    const ownedParent = insertTestProject(ctx.handle.db, {
      title: "Owned parent",
      ownerMemberId: owner.id,
    });
    const { client, server } = await connectMcp(authenticated.id);

    const shared = await client.callTool({
      name: "machbar_create_project",
      arguments: {
        title: "Shared child",
        parentProjectId: ownedParent.id,
        contextIds: [context.id],
      },
    });
    const sharedProject = (
      shared.structuredContent as {
        result: {
          id: number;
          revision: number;
          ownerMemberId: number | null;
        };
      }
    ).result;
    expect(sharedProject).toMatchObject({
      ownerMemberId: null,
    });

    const explicitlyOwned = await client.callTool({
      name: "machbar_create_project",
      arguments: { title: "Alex project", ownerMemberId: owner.id },
    });
    expect(explicitlyOwned.structuredContent).toEqual({
      result: expect.objectContaining({
        ownerMemberId: owner.id,
      }),
    });

    const updated = await client.callTool({
      name: "machbar_update_project",
      arguments: {
        projectId: sharedProject.id,
        expectedRevision: sharedProject.revision,
        ownerMemberId: owner.id,
        dueDate: "2026-09-21",
        contextIds: [context.id],
      },
    });
    expect(updated.structuredContent).toEqual({
      result: expect.objectContaining({
        ownerMemberId: owner.id,
        dueDate: "2026-09-21",
      }),
    });

    const contexts = await client.callTool({
      name: "machbar_list_contexts",
      arguments: {},
    });
    expect(contexts.structuredContent).toEqual({
      result: [
        { id: context.id, name: "Home" },
      ],
    });
    expect(JSON.stringify(contexts.structuredContent)).not.toContain(
      `"id":${inactiveContext.id}`,
    );

    const task = await client.callTool({
      name: "machbar_create_task",
      arguments: { title: "Wait for reply", activateIfReady: true },
    });
    const createdTask = (
      task.structuredContent as {
        result: { id: number; revision: number };
      }
    ).result;
    const waiting = await client.callTool({
      name: "machbar_set_waiting",
      arguments: {
        taskId: createdTask.id,
        expectedRevision: createdTask.revision,
        waitingFor: "Alex",
        revisitDate: "2026-09-22",
      },
    });
    expect(waiting.structuredContent).toEqual({
      result: expect.objectContaining({
        externalWait: { waitingFor: "Alex", revisitDate: "2026-09-22" },
      }),
    });

    const taskNote = await client.callTool({
      name: "machbar_append_note",
      arguments: {
        entityType: "task",
        entityId: createdTask.id,
        content: "Ask again next week",
      },
    });
    expect(taskNote.structuredContent).toEqual({
      result: expect.objectContaining({ revision: expect.any(Number) }),
    });
    const projectNote = await client.callTool({
      name: "machbar_append_note",
      arguments: {
        entityType: "project",
        entityId: sharedProject.id,
        content: "Keep this shared",
      },
    });
    expect(projectNote.structuredContent).toEqual({
      result: expect.objectContaining({ revision: expect.any(Number) }),
    });

    await client.close();
    await server.close();
  });

  it("forces project ownership to the authenticated member in work scope", async () => {
    const authenticated = await createMember();
    const other = await createMember("Alex");
    const { client, server } = await connectMcp(authenticated.id, "work");

    const created = await client.callTool({
      name: "machbar_create_project",
      arguments: { title: "Work project", ownerMemberId: other.id },
    });
    expect(created.structuredContent).toEqual({
      result: expect.objectContaining({
        ownerMemberId: authenticated.id,
      }),
    });

    await client.close();
    await server.close();
  });
});
