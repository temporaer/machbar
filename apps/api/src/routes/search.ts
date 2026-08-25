import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import { Graph } from "../domain/graph.js";
import { searchTasks } from "../domain/search.js";
import { searchQuerySchema } from "../schemas.js";
import { parseOrThrow } from "../validation.js";

export function registerSearchRoutes(app: FastifyInstance, db: Db) {
  app.get("/api/search", async (request) => {
    const query = parseOrThrow(searchQuerySchema, request.query);
    const graph = Graph.load(db);
    return searchTasks(graph, query);
  });
}
