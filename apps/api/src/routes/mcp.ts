import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import { createMcpAgentSchema } from "../schemas.js";
import {
  createMcpAgent,
  listMcpAgents,
  revokeMcpAgent,
} from "../integrations/mcp.js";
import { createMachbarMcpServer } from "../mcp/tools.js";
import { parseOrThrow } from "../validation.js";
import { AppError } from "../errors.js";

const INTEGRATION_ROOT = "/api/integrations/mcp";

function memberId(request: {
  authMember: { id: number } | null;
  activityActor: { id: number } | null;
}): number {
  const id = request.authMember?.id ?? request.activityActor?.id;
  if (id === undefined) {
    throw AppError.unauthorized(
      "authentication_required",
      "Select or authenticate a member before creating an MCP agent.",
    );
  }
  return id;
}

export function registerMcpRoutes(app: FastifyInstance, db: Db): void {
  app.get(`${INTEGRATION_ROOT}/agents`, async (request) =>
    listMcpAgents(db, memberId(request)),
  );

  app.post(`${INTEGRATION_ROOT}/agents`, async (request, reply) => {
    const body = parseOrThrow(createMcpAgentSchema, request.body);
    reply.status(201);
    return createMcpAgent(
      db,
      body.name,
      memberId(request),
      body.scope,
      "/api/mcp",
    );
  });

  app.delete<{ Params: { id: string } }>(
    `${INTEGRATION_ROOT}/agents/:id`,
    async (request, reply) => {
      const id = Number.parseInt(request.params.id, 10);
      if (!Number.isSafeInteger(id) || id <= 0) {
        throw AppError.badRequest(
          "identifier_invalid",
          "The MCP agent ID must be a positive integer.",
        );
      }
      revokeMcpAgent(db, id, memberId(request));
      reply.status(204);
      return null;
    },
  );

  app.route({
    method: ["GET", "POST", "DELETE"],
    url: "/api/mcp",
    handler: async (request, reply) => {
      const authenticatedMember = request.authMember;
      if (!authenticatedMember || !request.mcpScope) {
        throw AppError.unauthorized(
          "integration_authentication_required",
          "An MCP agent token is required.",
        );
      }
      const server = createMachbarMcpServer({
        db,
        memberId: authenticatedMember.id,
        scope: request.mcpScope,
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      reply.hijack();
      try {
        await server.connect(transport);
        await transport.handleRequest(request.raw, reply.raw, request.body);
      } finally {
        await transport.close();
        await server.close();
      }
    },
  });
}
