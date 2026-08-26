import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import { AppError } from "../errors.js";
import {
  deleteTag,
  getOrCreateTag,
  listTags,
  updateTag,
} from "../domain/mutations.js";
import { createTagSchema, updateTagSchema } from "../schemas.js";
import { parseOrThrow } from "../validation.js";

function parseId(raw: string): number {
  const id = Number.parseInt(raw, 10);
  if (Number.isNaN(id)) throw AppError.badRequest("Die ID muss eine Zahl sein.");
  return id;
}

export function registerTagRoutes(app: FastifyInstance, db: Db) {
  app.get("/api/tags", async () => listTags(db));

  app.post("/api/tags", async (request, reply) => {
    const body = parseOrThrow(createTagSchema, request.body);
    const tag = getOrCreateTag(db, body.name, body.kind);
    reply.status(201);
    return tag;
  });

  app.patch<{ Params: { id: string } }>("/api/tags/:id", async (request) => {
    const body = parseOrThrow(updateTagSchema, request.body);
    return updateTag(db, parseId(request.params.id), body);
  });

  app.delete<{ Params: { id: string } }>("/api/tags/:id", async (request, reply) => {
    deleteTag(db, parseId(request.params.id));
    reply.status(204);
    return null;
  });
}
