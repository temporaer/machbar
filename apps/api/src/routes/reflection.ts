import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { AppError } from "../errors.js";
import { getMemberOrThrow } from "../domain/members.js";
import { buildReflectionBriefing } from "../reflection/briefing.js";
import { parseOrThrow } from "../validation.js";

const briefingQuerySchema = z.object({
  memberId: z.coerce.number().int().positive(),
  days: z.coerce.number().int().refine((value) => [30, 90, 180].includes(value)).default(90),
  scope: z.enum(["household", "work", "all"]).default("household"),
});

export function registerReflectionRoutes(app: FastifyInstance, db: Db): void {
  app.get("/api/reflection/briefing", async (request) => {
    const query = parseOrThrow(briefingQuerySchema, request.query, {
      code: "reflection_briefing_query_invalid",
      message: "The reflection briefing query is invalid.",
    });
    const requesterId = request.authMember?.id ?? request.activityActor?.id ?? null;
    const subjectMemberId = request.authMember?.id ?? query.memberId;
    getMemberOrThrow(db, subjectMemberId);
    if ((query.scope === "work" || query.scope === "all") && requesterId !== subjectMemberId) {
      throw AppError.forbidden("reflection_work_scope_forbidden", "Work-scope reflection is available only to the selected member.");
    }
    return buildReflectionBriefing(db, {
      subjectMemberId,
      days: query.days as 30 | 90 | 180,
      scope: query.scope,
    });
  });
}
