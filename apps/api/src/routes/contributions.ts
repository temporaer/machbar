import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import { AppError } from "../errors.js";
import { getContributionSummary } from "../repo/contributionRepo.js";

export function registerContributionRoutes(app: FastifyInstance, db: Db) {
  app.get("/api/contributions/summary", async (request) => {
    const timeZone = (request.query as { timezone?: unknown }).timezone ?? "UTC";
    if (typeof timeZone !== "string") {
      throw AppError.badRequest(
        "contribution_query_invalid",
        "The contribution query parameters are invalid.",
      );
    }
    try {
      new Intl.DateTimeFormat("en", { timeZone });
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      throw AppError.badRequest(
        "contribution_query_invalid",
        "The contribution timezone is invalid.",
        { timezone: timeZone },
      );
    }
    return getContributionSummary(db, new Date(), timeZone);
  });
}
