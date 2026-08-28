import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { Graph } from "../domain/graph.js";
import { buildAgenda } from "../domain/agenda.js";
import { buildWaitingGroups } from "../domain/waiting.js";
import { getMemberOrThrow } from "../domain/mutations.js";
import { AppError } from "../errors.js";
import { validationDetails } from "../validation.js";

const agendaQuerySchema = z.object({
  memberId: z.coerce.number().int().positive().optional(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((value) => {
      const [year, month, day] = value.split("-").map(Number);
      const parsed = new Date(Date.UTC(year!, month! - 1, day));
      return (
        parsed.getUTCFullYear() === year &&
        parsed.getUTCMonth() === month! - 1 &&
        parsed.getUTCDate() === day
      );
    }, "Invalid calendar date")
    .optional(),
});

const waitingQuerySchema = z.object({
  actorTagId: z.coerce.number().int().positive().optional(),
});

/**
 * Parses and validates the optional `memberId` query parameter for
 * `/api/agenda/today`. It must be a positive integer when present. Leaving
 * it out entirely preserves the endpoint's original, unfiltered
 * all-household response for API clients that don't yet select a member.
 */
function parseAgendaQuery(query: unknown): z.infer<typeof agendaQuerySchema> {
  const result = agendaQuerySchema.safeParse(query);
  if (!result.success) {
    throw AppError.badRequest(
      "agenda_query_invalid",
      "The agenda query parameters are invalid.",
      validationDetails(result.error),
    );
  }
  return result.data;
}

export function registerViewRoutes(app: FastifyInstance, db: Db) {
  app.get("/api/agenda/today", async (request) => {
    const { memberId: requestedMemberId, date } = parseAgendaQuery(request.query);
    const memberId = request.authMember?.id ?? requestedMemberId;
    if (memberId !== undefined) {
      getMemberOrThrow(db, memberId);
    }
    const graph = Graph.load(db);
    return buildAgenda(graph, { memberId, today: date });
  });

  app.get("/api/inbox", async () => {
    const graph = Graph.load(db);
    const captured = graph
      .allTasks()
      .filter((task) => task.status === "captured");
    const capturedIds = new Set(captured.map((task) => task.id));
    const cloneCaptured = (task: (typeof captured)[number]): (typeof captured)[number] => ({
      ...task,
      children: task.children
        .filter((child) => capturedIds.has(child.id))
        .map(cloneCaptured),
    });

    return captured
      .filter(
        (task) =>
          task.parentTaskId === null || !capturedIds.has(task.parentTaskId),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(cloneCaptured);
  });

  app.get("/api/waiting", async (request) => {
    const parsed = waitingQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw AppError.badRequest(
        "waiting_query_invalid",
        "The waiting-list query parameters are invalid.",
        validationDetails(parsed.error),
      );
    }
    const graph = Graph.load(db);
    return buildWaitingGroups(graph, parsed.data.actorTagId);
  });
}
