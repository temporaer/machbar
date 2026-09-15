import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { Graph } from "../domain/graph.js";
import { buildAgenda } from "../domain/agenda.js";
import { buildWeekAgenda } from "../domain/weekAgenda.js";
import { buildWaitingEntries } from "../domain/waiting.js";
import { createAgendaSelection } from "../domain/agendaSelection.js";
import { getMemberOrThrow } from "../domain/members.js";
import { AppError } from "../errors.js";
import { validationDetails } from "../validation.js";
import { isTaskInWorkingSystem } from "../domain/workEligibility.js";
import { buildReviewItems } from "../domain/reviewItems.js";
import {
  contextAvailabilityForHousehold,
  contextAvailabilityForMember,
} from "../integrations/homeAssistant.js";

const agendaQuerySchema = z.object({
  memberId: z.coerce.number().int().positive().optional(),
  scope: z.enum(["mine", "all", "work"]).optional(),
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
  memberId: z.coerce.number().int().positive().optional(),
  scope: z.enum(["mine", "all", "work"]).optional(),
});

const weekQuerySchema = z.object({
  memberId: z.coerce.number().int().positive().optional(),
  scope: z.enum(["mine", "all", "work"]).optional(),
  start: z
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
    }, "Invalid calendar date"),
  // `today` overrides the real wall-clock date used to clamp overdue
  // attention forward. Intended for tests; production clients omit it and
  // the server uses the actual current date.
  today: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

/**
 * Parses and validates the Today agenda query. `memberId` remains available
 * to local/development clients, while authenticated browsers use the session
 * member unless they explicitly request the read-only household scope.
 * Leaving both fields out preserves the endpoint's original unfiltered
 * response outside authenticated mode.
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
  app.get("/api/views/more-counts", async () => {
    // Deliberately household-only: Review has no scope toggle, so pass an
    // explicit (always-absent) viewer to keep every "work" item excluded
    // rather than defaulting to `Graph.load`'s unrestricted internal mode.
    const graph = Graph.load(db, undefined, undefined);
    return {
      review: buildReviewItems(graph).length,
    };
  });

  app.get("/api/review", async () => {
    return buildReviewItems(Graph.load(db, undefined, undefined));
  });

  app.get("/api/agenda/today", async (request) => {
    const {
      memberId: requestedMemberId,
      scope,
      date,
    } = parseAgendaQuery(request.query);
    const viewerMemberId =
      request.authMember?.id ?? requestedMemberId ?? request.activityActor?.id;
    if (scope === "work" && viewerMemberId === undefined) {
      throw AppError.badRequest(
        "agenda_query_invalid",
        "The work scope requires a known member.",
      );
    }
    const memberId = scope === "all" ? undefined : viewerMemberId;
    if (memberId !== undefined) {
      getMemberOrThrow(db, memberId);
    }
    const graph = Graph.load(db, undefined, viewerMemberId);
    return buildAgenda(graph, {
      memberId,
      today: date,
      scope: scope === "work" ? "work" : memberId === undefined ? "all" : "mine",
      contextAvailability: (task, target) =>
        target === "household"
          ? contextAvailabilityForHousehold(db, task.effectiveContexts)
          : contextAvailabilityForMember(db, task.effectiveContexts, target),
    });
  });

  app.get("/api/agenda/week", async (request) => {
    const result = weekQuerySchema.safeParse(request.query);
    if (!result.success) {
      throw AppError.badRequest(
        "agenda_query_invalid",
        "The agenda query parameters are invalid.",
        validationDetails(result.error),
      );
    }
    const { memberId: requestedMemberId, scope, start, today } = result.data;
    const viewerMemberId =
      request.authMember?.id ?? requestedMemberId ?? request.activityActor?.id;
    if (scope === "work" && viewerMemberId === undefined) {
      throw AppError.badRequest(
        "agenda_query_invalid",
        "The work scope requires a known member.",
      );
    }
    const memberId = scope === "all" ? undefined : viewerMemberId;
    if (memberId !== undefined) getMemberOrThrow(db, memberId);
    return buildWeekAgenda(Graph.load(db, start, viewerMemberId), {
      start,
      today,
      memberId,
      scope: scope === "work" ? "work" : memberId === undefined ? "all" : "mine",
      contextAvailability: (task, target) =>
        target === "household"
          ? contextAvailabilityForHousehold(db, task.effectiveContexts)
          : contextAvailabilityForMember(db, task.effectiveContexts, target),
    });
  });

  app.get("/api/inbox", async (request) => {
    const parsed = waitingQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw AppError.badRequest(
        "inbox_query_invalid",
        "The inbox query parameters are invalid.",
        validationDetails(parsed.error),
      );
    }
    const viewerMemberId =
      request.authMember?.id ??
      parsed.data.memberId ??
      request.activityActor?.id;
    if (parsed.data.scope === "work" && viewerMemberId === undefined) {
      throw AppError.badRequest(
        "inbox_query_invalid",
        "The work scope requires a known member.",
      );
    }
    const memberId = parsed.data.scope === "all" ? undefined : viewerMemberId;
    if (memberId !== undefined) getMemberOrThrow(db, memberId);
    const scope =
      parsed.data.scope === "work"
        ? "work"
        : memberId === undefined
          ? "all"
          : "mine";
    // Mine/Household/Work toggle, matching Today/Week/Waiting: a resolved
    // viewer sees their own household captured items (or, in Work scope,
    // only their own work-scope captured items). Unlike Review and
    // /more-counts (which have no scope selector at all and stay
    // unconditionally household-only, see their comments above), Inbox
    // needs a real viewer so a captured work item is reachable by its own
    // owner instead of vanishing everywhere.
    const graph = Graph.load(db, undefined, viewerMemberId);
    const selection = createAgendaSelection(graph, { memberId, scope });
    const projectStatusById = new Map(
      [...graph.projectsById.values()].map((project) => [
        project.id,
        project.status,
      ]),
    );
    const captured = graph
      .allTasks()
      .filter(
        (task) =>
          task.status === "captured" &&
          isTaskInWorkingSystem(task, projectStatusById) &&
          selection.matchesScope(task) &&
          selection.matchesOwner(task),
      );
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
    const viewerMemberId =
      request.authMember?.id ??
      parsed.data.memberId ??
      request.activityActor?.id;
    if (parsed.data.scope === "work" && viewerMemberId === undefined) {
      throw AppError.badRequest(
        "waiting_query_invalid",
        "The work scope requires a known member.",
      );
    }
    const memberId = parsed.data.scope === "all" ? undefined : viewerMemberId;
    if (memberId !== undefined) getMemberOrThrow(db, memberId);
    const scope =
      parsed.data.scope === "work"
        ? "work"
        : memberId === undefined
          ? "all"
          : "mine";
    return buildWaitingEntries(Graph.load(db, undefined, viewerMemberId), {
      memberId,
      scope,
      contextAvailability: (task, target) =>
        target === "household"
          ? contextAvailabilityForHousehold(db, task.effectiveContexts)
          : contextAvailabilityForMember(db, task.effectiveContexts, target),
    });
  });
}
