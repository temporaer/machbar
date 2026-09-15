import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { eq, isNull } from "drizzle-orm";
import type {
  McpAgent,
  McpAgentToken,
  Member,
  WorkItemScope,
} from "@machbar/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { listMembers } from "../domain/members.js";
import { AppError } from "../errors.js";

const TOKEN_PREFIX = "mbmcp_";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function equalHash(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function publicAgent(
  row: typeof schema.mcpAgents.$inferSelect,
): McpAgent {
  const { tokenHash: _tokenHash, ...agent } = row;
  return agent;
}

export function listMcpAgents(db: Db, memberId: number): McpAgent[] {
  return db
    .select()
    .from(schema.mcpAgents)
    .where(eq(schema.mcpAgents.memberId, memberId))
    .all()
    .map(publicAgent);
}

export function createMcpAgent(
  db: Db,
  name: string,
  memberId: number,
  scope: WorkItemScope,
  endpoint: string,
): McpAgentToken {
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const row = db
    .insert(schema.mcpAgents)
    .values({
      name: name.trim(),
      memberId,
      scope,
      tokenHash: hashToken(token),
    })
    .returning()
    .get();
  return { agent: publicAgent(row), token, endpoint };
}

export function authenticateMcpAgent(
  db: Db,
  authorization: string | undefined,
): { agentId: number; member: Member; scope: WorkItemScope } {
  const prefix = "Bearer ";
  if (!authorization?.startsWith(prefix)) {
    throw AppError.unauthorized(
      "integration_authentication_required",
      "An MCP agent token is required.",
    );
  }
  const suppliedHash = hashToken(authorization.slice(prefix.length));
  const agent = db
    .select()
    .from(schema.mcpAgents)
    .where(isNull(schema.mcpAgents.revokedAt))
    .all()
    .find((candidate) => equalHash(candidate.tokenHash, suppliedHash));
  if (!agent) {
    throw AppError.unauthorized(
      "integration_token_revoked",
      "The MCP agent token is invalid or revoked.",
    );
  }
  const member = listMembers(db).find((candidate) => candidate.id === agent.memberId);
  if (!member) {
    throw AppError.unauthorized(
      "integration_token_revoked",
      "The MCP agent member no longer exists.",
    );
  }
  db.update(schema.mcpAgents)
    .set({ lastUsedAt: new Date().toISOString() })
    .where(eq(schema.mcpAgents.id, agent.id))
    .run();
  return { agentId: agent.id, member, scope: agent.scope };
}

export function revokeMcpAgent(
  db: Db,
  id: number,
  memberId: number,
): void {
  const agent = db
    .select()
    .from(schema.mcpAgents)
    .where(eq(schema.mcpAgents.id, id))
    .get();
  if (!agent || agent.memberId !== memberId) {
    throw AppError.notFound(
      "identifier_invalid",
      "The MCP agent was not found.",
      { agentId: id },
    );
  }
  db.update(schema.mcpAgents)
    .set({ revokedAt: new Date().toISOString() })
    .where(eq(schema.mcpAgents.id, id))
    .run();
}
