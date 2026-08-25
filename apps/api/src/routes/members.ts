import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import { listMembers } from "../domain/mutations.js";

export function registerMemberRoutes(app: FastifyInstance, db: Db) {
  app.get("/api/members", async () => listMembers(db));
}
