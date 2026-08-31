import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { AppError } from "../errors.js";
import { getMemberOrThrow } from "../domain/mutations.js";
import {
  getRefinementOwnerSizeCounts,
  getRefinementTasks,
  type RefinementFilters,
} from "../repo/refinementRepo.js";
import { validationDetails } from "../validation.js";

/**
 * `ownerId` accepts either a positive member id or the literal `"none"` to
 * filter to the shared/unassigned bucket (effective owner is `null`).
 * Leaving it out entirely means "no owner filter" (every owner + shared).
 */
const refinementQuerySchema = z.object({
  ownerId: z
    .union([z.coerce.number().int().positive(), z.literal("none")])
    .optional(),
  projectId: z.coerce.number().int().positive().optional(),
  tagIds: z
    .string()
    .optional()
    .transform((value) =>
      value
        ? value
            .split(",")
            .map((part) => Number.parseInt(part.trim(), 10))
            .filter((id) => Number.isInteger(id) && id > 0)
        : undefined,
    ),
});

function parseRefinementFilters(db: Db, query: unknown): RefinementFilters {
  const result = refinementQuerySchema.safeParse(query);
  if (!result.success) {
    throw AppError.badRequest(
      "refinement_filters_invalid",
      "The refinement filters are invalid.",
      validationDetails(result.error),
    );
  }
  const filters: RefinementFilters = {};
  if (result.data.ownerId === "none") {
    filters.ownerId = null;
  } else if (result.data.ownerId !== undefined) {
    getMemberOrThrow(db, result.data.ownerId);
    filters.ownerId = result.data.ownerId;
  }
  if (result.data.projectId !== undefined) {
    filters.projectId = result.data.projectId;
  }
  if (result.data.tagIds?.length) filters.tagIds = result.data.tagIds;
  return filters;
}

export function registerRefinementRoutes(app: FastifyInstance, db: Db) {
  app.get("/api/refinement/owners", async (request) => {
    const filters = parseRefinementFilters(db, request.query);
    return getRefinementOwnerSizeCounts(db, filters);
  });

  app.get("/api/refinement/tasks", async (request) => {
    const filters = parseRefinementFilters(db, request.query);
    return getRefinementTasks(db, filters);
  });
}
