import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { Graph } from "../domain/graph.js";
import { buildAgenda } from "../domain/agenda.js";
import { buildWaitingGroups } from "../domain/waiting.js";
import { getMemberOrThrow } from "../domain/mutations.js";
import { AppError } from "../errors.js";

const agendaQuerySchema = z.object({
  memberId: z.coerce.number().int().positive().optional(),
});

/**
 * Parses and validates the optional `memberId` query parameter for
 * `/api/agenda/today`. It must be a positive integer when present. Leaving
 * it out entirely preserves the endpoint's original, unfiltered
 * all-household response for API clients that don't yet select a member.
 */
function parseAgendaMemberId(query: unknown): number | undefined {
  const result = agendaQuerySchema.safeParse(query);
  if (!result.success) {
    throw AppError.badRequest(
      "Die memberId muss eine positive ganze Zahl sein.",
      result.error.flatten(),
    );
  }
  return result.data.memberId;
}

export function registerViewRoutes(app: FastifyInstance, db: Db) {
  app.get("/api/agenda/today", async (request) => {
    const requestedMemberId = parseAgendaMemberId(request.query);
    const memberId = request.authMember?.id ?? requestedMemberId;
    if (memberId !== undefined) {
      // Throws a German 404 (AppError.notFound) if the member doesn't exist.
      getMemberOrThrow(db, memberId);
    }
    const graph = Graph.load(db);
    return buildAgenda(graph, { memberId });
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
