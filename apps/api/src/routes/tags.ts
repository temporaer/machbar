import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import { getOrCreateTag, listTags } from "../domain/mutations.js";
import { createTagSchema } from "../schemas.js";
import { parseOrThrow } from "../validation.js";

export function registerTagRoutes(app: FastifyInstance, db: Db) {
  app.get("/api/tags", async () => listTags(db));

  app.post("/api/tags", async (request, reply) => {
    const body = parseOrThrow(createTagSchema, request.body);
    const tag = getOrCreateTag(db, body.name);
    reply.status(201);
    return tag;
  });
}
