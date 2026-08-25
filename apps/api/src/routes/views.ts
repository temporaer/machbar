import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import { Graph } from "../domain/graph.js";
import { buildAgenda } from "../domain/agenda.js";
import { buildWaitingGroups } from "../domain/waiting.js";

export function registerViewRoutes(app: FastifyInstance, db: Db) {
  app.get("/api/agenda/today", async () => {
    const graph = Graph.load(db);
    return buildAgenda(graph);
  });

  app.get("/api/inbox", async () => {
    const graph = Graph.load(db);
    return graph
      .allTasks()
      .filter((t) => t.status === "inbox")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  });

  app.get("/api/waiting", async () => {
    const graph = Graph.load(db);
    return buildWaitingGroups(graph);
  });
}
