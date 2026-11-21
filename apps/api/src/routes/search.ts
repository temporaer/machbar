import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import { Graph } from "../domain/graph.js";
import { searchTaskRecords } from "../domain/search.js";
import { searchQuerySchema } from "../schemas.js";
import { parseOrThrow } from "../validation.js";

export function registerSearchRoutes(app: FastifyInstance, db: Db) {
  app.get("/api/search", async (request) => {
    const query = parseOrThrow(searchQuerySchema, request.query, {
      code: "search_query_invalid",
      message: "The search query parameters are invalid.",
    });
    const taskRecords = Graph.loadSearchTasks(
      db,
      request.authMember?.id ?? request.activityActor?.id ?? undefined,
    );
    return searchTaskRecords(taskRecords, query);
  });
}
