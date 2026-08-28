import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import { getContributionSummary } from "../repo/contributionRepo.js";

export function registerContributionRoutes(app: FastifyInstance, db: Db) {
  app.get("/api/contributions/summary", async () =>
    getContributionSummary(db),
  );
}
