import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import { AppError } from "../errors.js";
import {
  createMember,
  deleteMember,
  listMembers,
  renameMember,
} from "../domain/mutations.js";
import { createMemberSchema, renameMemberSchema } from "../schemas.js";
import { parseOrThrow } from "../validation.js";

function parseId(raw: string): number {
  const id = Number.parseInt(raw, 10);
  if (Number.isNaN(id)) {
    throw AppError.badRequest("Die ID muss eine Zahl sein.");
  }
  return id;
}

export function registerMemberRoutes(app: FastifyInstance, db: Db) {
  app.get("/api/members", async () => listMembers(db));

  app.post("/api/members", async (request, reply) => {
    const body = parseOrThrow(createMemberSchema, request.body);
    const member = createMember(db, body.name);
    reply.status(201);
    return member;
  });

  app.patch<{ Params: { id: string } }>("/api/members/:id", async (request) => {
    const id = parseId(request.params.id);
    const body = parseOrThrow(renameMemberSchema, request.body);
    return renameMember(db, id, body.name);
  });

  app.delete<{ Params: { id: string } }>(
    "/api/members/:id",
    async (request, reply) => {
      const id = parseId(request.params.id);
      deleteMember(db, id);
      reply.status(204);
      return null;
    },
  );
}
