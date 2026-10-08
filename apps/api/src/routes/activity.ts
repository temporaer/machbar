import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.js";
import {
  acknowledgeActivityDigest,
  getActivityDigest,
} from "../activity/digest.js";
import { getMemberOrThrow } from "../domain/members.js";
import { getActivityPage } from "../repo/activityRepo.js";
import { activityQuerySchema } from "../schemas.js";
import { parseOrThrow } from "../validation.js";
import { AppError } from "../errors.js";

export function registerActivityRoutes(app: FastifyInstance, db: Db) {
  app.get("/api/activity", async (request) => {
    const query = parseOrThrow(activityQuerySchema, request.query, {
      code: "activity_query_invalid",
      message: "The activity query parameters are invalid.",
    });
    return getActivityPage(db, {
      ...query,
      viewerMemberId:
        request.authMember?.id ??
        query.memberId ??
        request.activityActor?.id ??
        null,
    });
  });

  const digestQuerySchema = z.object({
    memberId: z.coerce.number().int().positive().optional(),
  });
  const digestAckSchema = z.object({
    memberId: z.coerce.number().int().positive().optional(),
    throughEventId: z.coerce.number().int().nonnegative(),
  });

  app.get("/api/activity/digest", async (request) => {
    const query = parseOrThrow(digestQuerySchema, request.query, {
      code: "activity_digest_query_invalid",
      message: "The activity digest query is invalid.",
    });
    const memberId =
      request.authMember?.id ??
      query.memberId ??
      request.activityActor?.id;
    if (memberId === undefined) {
      throw AppError.badRequest(
        "activity_digest_member_required",
        "A member is required to load the activity digest.",
      );
    }
    getMemberOrThrow(db, memberId);
    return getActivityDigest(db, memberId);
  });

  app.post("/api/activity/digest/ack", async (request) => {
    const body = parseOrThrow(digestAckSchema, request.body, {
      code: "activity_digest_ack_invalid",
      message: "The activity digest acknowledgement is invalid.",
    });
    const memberId =
      request.authMember?.id ??
      body.memberId ??
      request.activityActor?.id;
    if (memberId === undefined) {
      throw AppError.badRequest(
        "activity_digest_member_required",
        "A member is required to acknowledge the activity digest.",
      );
    }
    getMemberOrThrow(db, memberId);
    acknowledgeActivityDigest(db, memberId, body.throughEventId);
    return { acknowledgedThroughEventId: body.throughEventId };
  });
}
