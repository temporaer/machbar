import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import { getActivityPage } from "../repo/activityRepo.js";
import { activityQuerySchema } from "../schemas.js";
import { parseOrThrow } from "../validation.js";

export function registerActivityRoutes(app: FastifyInstance, db: Db) {
  app.get("/api/activity", async (request) => {
    const query = parseOrThrow(activityQuerySchema, request.query, {
      code: "activity_query_invalid",
      message: "The activity query parameters are invalid.",
    });
    return getActivityPage(db, query);
  });
}
